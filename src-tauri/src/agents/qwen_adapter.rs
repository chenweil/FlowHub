use std::collections::{HashMap, HashSet, VecDeque};

use serde_json::{json, Value};
use tauri::Emitter;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{ChildStdin, ChildStdout};
use tokio::time::{timeout, Duration};

use crate::models::ListenerCommand;
use crate::router::{emit_task_finish, handle_session_update};
use super::session_params::{
    build_initialize_params, build_session_new_params,
    build_session_new_params_with_id, build_session_load_params, build_prompt_params,
};

struct StdioAcpConnection {
    writer: ChildStdin,
    reader: Lines<BufReader<ChildStdout>>,
}

impl StdioAcpConnection {
    fn new(stdout: ChildStdout, stdin: ChildStdin) -> Self {
        Self {
            writer: stdin,
            reader: BufReader::new(stdout).lines(),
        }
    }

    async fn send_message(&mut self, message: String) -> Result<(), String> {
        self.writer
            .write_all(format!("{}\n", message).as_bytes())
            .await
            .map_err(|e| format!("Failed to send message: {}", e))?;
        self.writer
            .flush()
            .await
            .map_err(|e| format!("Failed to flush message: {}", e))
    }

    async fn receive_message(&mut self) -> Result<Option<String>, String> {
        match timeout(Duration::from_secs(30), self.reader.next_line()).await {
            Ok(Ok(Some(line))) => Ok(Some(line)),
            Ok(Ok(None)) => Ok(None),
            Ok(Err(e)) => Err(format!("Stdio read error: {}", e)),
            Err(_) => Ok(Some(String::new())),
        }
    }
}

fn build_rpc_request(id: i64, method: &str, params: Value) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    })
    .to_string()
}

async fn send_rpc_result(
    conn: &mut StdioAcpConnection,
    id: i64,
    result: Value,
) -> Result<(), String> {
    conn.send_message(
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result,
        })
        .to_string(),
    )
    .await
}

async fn send_rpc_error(
    conn: &mut StdioAcpConnection,
    id: i64,
    code: i64,
    message: &str,
) -> Result<(), String> {
    conn.send_message(
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": {
                "code": code,
                "message": message,
            },
        })
        .to_string(),
    )
    .await
}

fn parse_rpc_id(message: &Value) -> Option<i64> {
    let id = message.get("id")?;
    if let Some(v) = id.as_i64() {
        return Some(v);
    }
    if let Some(v) = id.as_u64() {
        return i64::try_from(v).ok();
    }
    if let Some(v) = id.as_f64() {
        return Some(v as i64);
    }
    None
}

fn should_handle_server_method(method: &str) -> bool {
    matches!(
        method,
        "session/request_permission" | "fs/read_text_file" | "fs/write_text_file"
    )
}

pub(crate) fn parse_ndjson_line(line: &str) -> Result<Option<Value>, String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    serde_json::from_str(trimmed)
        .map(Some)
        .map_err(|e| format!("Invalid ACP NDJSON line: {}", e))
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct ReportedContextUsage {
    used_tokens: u64,
    context_window: u64,
    percentage: f64,
}

fn value_as_u64(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_i64().and_then(|item| u64::try_from(item).ok()))
        .or_else(|| {
            value.as_f64().and_then(|item| {
                if item.is_finite() && item >= 0.0 {
                    Some(item as u64)
                } else {
                    None
                }
            })
        })
}

fn reported_context_usage_from_node(payload: &Value) -> Option<ReportedContextUsage> {
    let usage = payload.get("usageMetadata")?;
    let context_window = payload.get("contextWindowSize").and_then(value_as_u64)?;
    let used_tokens = usage
        .get("promptTokenCount")
        .and_then(value_as_u64)
        .or_else(|| usage.get("totalTokenCount").and_then(value_as_u64))?;
    let percentage = if context_window == 0 {
        0.0
    } else {
        (used_tokens as f64 / context_window as f64) * 100.0
    };

    Some(ReportedContextUsage {
        used_tokens,
        context_window,
        percentage,
    })
}

fn extract_reported_context_usage(payload: &Value) -> Option<ReportedContextUsage> {
    if let Some(usage) = reported_context_usage_from_node(payload) {
        return Some(usage);
    }

    let nested_keys = ["update", "result", "content", "value", "message"];
    for key in nested_keys {
        if let Some(child) = payload.get(key) {
            if let Some(usage) = extract_reported_context_usage(child) {
                return Some(usage);
            }
        }
    }

    for key in ["candidates", "parts"] {
        if let Some(items) = payload.get(key).and_then(Value::as_array) {
            for item in items {
                if let Some(usage) = extract_reported_context_usage(item) {
                    return Some(usage);
                }
            }
        }
    }

    None
}

fn emit_reported_context_usage(
    app_handle: &tauri::AppHandle,
    agent_id: &str,
    session_id: Option<&str>,
    payload: &Value,
) {
    let Some(usage) = extract_reported_context_usage(payload) else {
        return;
    };

    let _ = app_handle.emit(
        "context-usage",
        json!({
            "agentId": agent_id,
            "sessionId": session_id,
            "usedTokens": usage.used_tokens,
            "contextWindow": usage.context_window,
            "percentage": usage.percentage,
            "source": "reported",
        }),
    );
}

async fn handle_server_request(
    conn: &mut StdioAcpConnection,
    request_id: i64,
    method: &str,
    params: Option<&Value>,
) {
    let params = params.cloned().unwrap_or(Value::Null);
    println!(
        "[listener] Server request received: method={}, id={}",
        method, request_id
    );

    let result = match method {
        "session/request_permission" => {
            send_rpc_result(
                conn,
                request_id,
                json!({
                    "outcome": {
                        "outcome": "selected",
                        "optionId": "allow_once",
                    }
                }),
            )
            .await
        }
        "fs/read_text_file" => {
            let Some(path) = params.get("path").and_then(Value::as_str) else {
                let _ = send_rpc_error(conn, request_id, -32602, "Missing path").await;
                return;
            };
            let session_id = params
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or_default();

            match tokio::fs::read_to_string(path).await {
                Ok(content) => {
                    send_rpc_result(
                        conn,
                        request_id,
                        json!({
                            "content": content,
                            "path": path,
                            "sessionId": session_id,
                        }),
                    )
                    .await
                }
                Err(e) => {
                    send_rpc_error(
                        conn,
                        request_id,
                        -32603,
                        &format!("Failed to read file: {}", e),
                    )
                    .await
                }
            }
        }
        "fs/write_text_file" => {
            let Some(path) = params.get("path").and_then(Value::as_str) else {
                let _ = send_rpc_error(conn, request_id, -32602, "Missing path").await;
                return;
            };
            let Some(content) = params.get("content").and_then(Value::as_str) else {
                let _ = send_rpc_error(conn, request_id, -32602, "Missing content").await;
                return;
            };

            match tokio::fs::write(path, content).await {
                Ok(_) => send_rpc_result(conn, request_id, Value::Null).await,
                Err(e) => {
                    send_rpc_error(
                        conn,
                        request_id,
                        -32603,
                        &format!("Failed to write file: {}", e),
                    )
                    .await
                }
            }
        }
        _ => send_rpc_error(conn, request_id, -32601, "Method not found").await,
    };

    if let Err(e) = result {
        println!("[listener] Failed to respond to {}: {}", method, e);
    }
}

fn next_rpc_id(counter: &mut i64) -> i64 {
    let id = *counter;
    *counter += 1;
    id
}

fn text_from_json_value(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => {
            let normalized = text.trim();
            if normalized.is_empty() {
                None
            } else {
                Some(normalized.to_string())
            }
        }
        Value::Array(items) => {
            let parts: Vec<String> = items.iter().filter_map(text_from_json_value).collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join(" "))
            }
        }
        Value::Object(map) => map.get("text").and_then(text_from_json_value),
        _ => None,
    }
}

fn extract_registry_array<'a>(payload: &'a Value, key: &str) -> Option<&'a Vec<Value>> {
    payload.get(key).and_then(Value::as_array).or_else(|| {
        payload
            .get("_meta")
            .and_then(|meta| meta.get(key))
            .and_then(Value::as_array)
    })
}

fn normalized_command_entries(payload: &Value) -> Vec<Value> {
    let Some(raw_entries) = extract_registry_array(payload, "availableCommands") else {
        return Vec::new();
    };

    raw_entries
        .iter()
        .filter_map(|entry| {
            let raw_name = entry.get("name").and_then(Value::as_str)?.trim();
            if raw_name.is_empty() {
                return None;
            }

            let normalized_name = if raw_name.starts_with('/') {
                raw_name.to_string()
            } else {
                format!("/{}", raw_name)
            };

            let description = entry
                .get("description")
                .and_then(text_from_json_value)
                .unwrap_or_default();
            let scope = entry
                .get("_meta")
                .and_then(|meta| meta.get("scope"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();

            Some(json!({
                "name": normalized_name,
                "description": description,
                "scope": scope,
            }))
        })
        .collect()
}

fn normalized_mcp_entries(payload: &Value) -> Vec<Value> {
    let Some(raw_entries) = extract_registry_array(payload, "availableMcpServers") else {
        return Vec::new();
    };

    raw_entries
        .iter()
        .filter_map(|entry| {
            let raw_name = entry
                .get("name")
                .or_else(|| entry.get("id"))
                .and_then(Value::as_str)?
                .trim();
            if raw_name.is_empty() {
                return None;
            }

            let description = entry
                .get("description")
                .and_then(text_from_json_value)
                .unwrap_or_default();

            Some(json!({
                "name": raw_name,
                "description": description,
            }))
        })
        .collect()
}

fn emit_command_registry_payload(app_handle: &tauri::AppHandle, agent_id: &str, payload: &Value) {
    let commands = normalized_command_entries(payload);
    let mcp_servers = normalized_mcp_entries(payload);

    if commands.is_empty() && mcp_servers.is_empty() {
        return;
    }

    let _ = app_handle.emit(
        "command-registry",
        json!({
            "agentId": agent_id,
            "commands": commands,
            "mcpServers": mcp_servers,
        }),
    );
}

fn emit_command_registry_from_update(
    app_handle: &tauri::AppHandle,
    agent_id: &str,
    update: &Value,
) {
    emit_command_registry_payload(app_handle, agent_id, update);

    if let Some(content) = update.get("content") {
        emit_command_registry_payload(app_handle, agent_id, content);
    }
}

fn model_registry_payload(payload: &Value) -> Option<(Vec<Value>, Option<String>)> {
    let models_node = payload
        .get("models")
        .or_else(|| payload.get("_meta").and_then(|meta| meta.get("models")))?;

    let available_models = models_node
        .get("availableModels")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let current_model = models_node
        .get("currentModelId")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    if available_models.is_empty() && current_model.is_none() {
        return None;
    }

    let normalized = available_models
        .into_iter()
        .filter_map(|entry| {
            let value = entry
                .get("value")
                .or_else(|| entry.get("id"))
                .and_then(Value::as_str)
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())?;
            let label = entry
                .get("label")
                .or_else(|| entry.get("name"))
                .and_then(Value::as_str)
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
                .unwrap_or_else(|| value.clone());
            Some(json!({
                "label": label,
                "value": value,
            }))
        })
        .collect::<Vec<_>>();

    if normalized.is_empty() && current_model.is_none() {
        return None;
    }

    Some((normalized, current_model))
}

fn emit_model_registry_payload(app_handle: &tauri::AppHandle, agent_id: &str, payload: &Value) {
    let Some((models, current_model)) = model_registry_payload(payload) else {
        return;
    };

    let _ = app_handle.emit(
        "model-registry",
        json!({
            "agentId": agent_id,
            "models": models,
            "currentModel": current_model,
        }),
    );
}

pub async fn message_listener_task(
    app_handle: tauri::AppHandle,
    agent_id: String,
    workspace_path: String,
    stdout: ChildStdout,
    stdin: ChildStdin,
    mut message_rx: tokio::sync::mpsc::UnboundedReceiver<ListenerCommand>,
) {
    println!("[listener] Starting for agent: {}", agent_id);

    // 未 ready 前收到的 prompt 先入队。每条可绑定一个目标 sessionId（用于恢复指定会话后再发送）。
    let mut queued_prompts: VecDeque<(String, Option<String>)> = VecDeque::new();
    let mut conn = StdioAcpConnection::new(stdout, stdin);
    let mut rpc_id_counter: i64 = 1;
    let mut initialize_request_id: Option<i64>;
    let mut session_new_request_id: Option<i64> = None;
    let mut session_new_target_id: Option<String> = None;
    let mut session_load_request_id: Option<i64> = None;
    let mut session_load_target_id: Option<String> = None;
    let mut session_load_for_initialize = false;
    let mut session_id: Option<String> = None;
    let mut pending_prompt_request_ids: HashSet<i64> = HashSet::new();
    let mut pending_set_model_requests: HashMap<
        i64,
        (tokio::sync::oneshot::Sender<Result<String, String>>, String),
    > = HashMap::new();
    let mut pending_set_think_requests: HashMap<
        i64,
        (
            tokio::sync::oneshot::Sender<Result<bool, String>>,
            bool,
            String,
        ),
    > = HashMap::new();

    let init_id = next_rpc_id(&mut rpc_id_counter);
    let init_request = build_rpc_request(init_id, "initialize", build_initialize_params());
    if let Err(e) = conn.send_message(init_request).await {
        println!("[listener] Failed to send initialize: {}", e);
        return;
    }
    initialize_request_id = Some(init_id);

    loop {
                    tokio::select! {
                        msg = message_rx.recv() => {
                            match msg {
                                Some(ListenerCommand::UserPrompt { content: prompt, session_id: requested_session_id }) => {
                                    let target_session_id = requested_session_id
                                        .map(|item| item.trim().to_string())
                                        .filter(|item| !item.is_empty());

                                    if let Some(target) = target_session_id.as_ref() {
                                        if session_id.as_deref() != Some(target.as_str()) {
                                            println!("[listener] Session switch requested: {} -> {}", session_id.as_deref().unwrap_or("<none>"), target);
                                            queued_prompts.push_back((prompt, target_session_id.clone()));

                                            if session_load_request_id.is_none() {
                                                let load_id = next_rpc_id(&mut rpc_id_counter);
                                                session_load_request_id = Some(load_id);
                                                session_load_target_id = Some(target.clone());
                                                session_load_for_initialize = false;
                                                let load_request = build_rpc_request(
                                                    load_id,
                                                    "session/load",
                                                    build_session_load_params(&workspace_path, target),
                                                );
                                                if let Err(e) = conn.send_message(load_request).await {
                                                    println!("[listener] Failed to send session/load: {}", e);
                                                    break;
                                                }
                                            }
                                            continue;
                                        }
                                    }

                                    if let Some(current_session_id) = &session_id {
                                        let prompt_id = next_rpc_id(&mut rpc_id_counter);
                                        let prompt_request = build_rpc_request(
                                            prompt_id,
                                            "session/prompt",
                                            build_prompt_params(current_session_id, &prompt),
                                        );

                                        println!("[listener] Sending session/prompt request: id={}", prompt_id);
                                        if let Err(e) = conn.send_message(prompt_request).await {
                                            println!("[listener] Failed to send prompt: {}", e);
                                            queued_prompts.push_front((prompt, target_session_id));
                                            break;
                                        }
                                        pending_prompt_request_ids.insert(prompt_id);
                                    } else {
                                        println!("[listener] Session not ready, prompt queued");
                                        queued_prompts.push_back((prompt, target_session_id));
                                    }
                                }
                                Some(ListenerCommand::CancelPrompt) => {
                                    if let Some(current_session_id) = &session_id {
                                        let cancel_id = next_rpc_id(&mut rpc_id_counter);
                                        let cancel_request = build_rpc_request(
                                            cancel_id,
                                            "session/cancel",
                                            json!({
                                                "sessionId": current_session_id,
                                            }),
                                        );
                                        if let Err(e) = conn.send_message(cancel_request).await {
                                            println!("[listener] Failed to send session/cancel: {}", e);
                                        }
                                    } else {
                                        println!("[listener] Session not ready, cancel ignored");
                                    }
                                }
                                Some(ListenerCommand::SetModel { model, response }) => {
                                    if let Some(current_session_id) = &session_id {
                                        let switch_id = next_rpc_id(&mut rpc_id_counter);
                                        let switch_request = build_rpc_request(
                                            switch_id,
                                            "session/set_model",
                                            json!({
                                                "sessionId": current_session_id,
                                                "modelId": model,
                                            }),
                                        );
                                        if let Err(e) = conn.send_message(switch_request).await {
                                            let _ = response.send(Err(format!(
                                                "Failed to send session/set_model: {}",
                                                e
                                            )));
                                            break;
                                        }
                                        pending_set_model_requests.insert(switch_id, (response, model));
                                    } else {
                                        let _ = response.send(Err("Session not ready".to_string()));
                                    }
                                }
                                Some(ListenerCommand::SetThink {
                                    enable,
                                    config,
                                    response,
                                }) => {
                                    if let Some(current_session_id) = &session_id {
                                        let requested_config = config.clone();
                                        let switch_id = next_rpc_id(&mut rpc_id_counter);
                                        let switch_request = build_rpc_request(
                                            switch_id,
                                            "session/set_think",
                                            json!({
                                                "sessionId": current_session_id,
                                                "thinkEnabled": enable,
                                                "thinkConfig": requested_config,
                                            }),
                                        );
                                        if let Err(e) = conn.send_message(switch_request).await {
                                            let _ = response.send(Err(format!(
                                                "Failed to send session/set_think: {}",
                                                e
                                            )));
                                            break;
                                        }
                                        pending_set_think_requests
                                            .insert(switch_id, (response, enable, config));
                                    } else {
                                        let _ = response.send(Err("Session not ready".to_string()));
                                    }
                                }
                                None => {
                                    println!("[listener] Channel closed, exiting");
                                    return;
                                }
                            }
                        }

                        result = conn.receive_message() => {
                            match result {
                                Ok(Some(message_text)) => {
                                    if message_text.is_empty() {
                                        continue;
                                    }

                                    for line in message_text.lines() {
                                        let raw = line.trim();
                                        if raw.is_empty() {
                                            continue;
                                        }

                                        if raw.starts_with("//") {
                                            println!("[listener] Control message: {}", raw);
                                            continue;
                                        }

                                        let Some(message_json) = (match parse_ndjson_line(raw) {
                                            Ok(message) => message,
                                            Err(error) => {
                                                println!("[listener] JSON parse failed: {} ({})", raw, error);
                                                continue;
                                            }
                                        }) else {
                                            continue;
                                        };

                                        if let Some(method) = message_json.get("method").and_then(Value::as_str) {
                                            let request_id = parse_rpc_id(&message_json);
                                            let params = message_json.get("params");

                                            if method == "session/update" {
                                                if let Some(update) = params.and_then(|p| p.get("update")) {
                                                    handle_session_update(&app_handle, &agent_id, update).await;
                                                    emit_command_registry_from_update(&app_handle, &agent_id, update);
                                                    emit_reported_context_usage(
                                                        &app_handle,
                                                        &agent_id,
                                                        session_id.as_deref(),
                                                        update,
                                                    );
                                                }
                                                continue;
                                            }

                                            if let Some(request_id) = request_id {
                                                if !should_handle_server_method(method) {
                                                    let _ = send_rpc_error(&mut conn, request_id, -32601, "Method not found").await;
                                                    continue;
                                                }
                                                handle_server_request(&mut conn, request_id, method, params).await;
                                            } else {
                                                println!("[listener] Notification method ignored: {}", method);
                                            }

                                            continue;
                                        }

                                        let Some(response_id) = parse_rpc_id(&message_json) else {
                                            println!("[listener] Unknown message: {}", raw);
                                            continue;
                                        };

                                        if initialize_request_id == Some(response_id) {
                                            initialize_request_id = None;

                                            if let Some(error) = message_json.get("error") {
                                                let _ = app_handle.emit(
                                                    "agent-error",
                                                    json!({
                                                        "agentId": &agent_id,
                                                        "error": format!("ACP initialize failed: {}", error),
                                                    }),
                                                );
                                                break;
                                            }

                                            if let Some(existing_session_id) = &session_id {
                                                let session_load_id = next_rpc_id(&mut rpc_id_counter);
                                                session_load_request_id = Some(session_load_id);
                                                session_load_target_id = Some(existing_session_id.clone());
                                                session_load_for_initialize = true;
                                                let session_load_request = build_rpc_request(
                                                    session_load_id,
                                                    "session/load",
                                                    build_session_load_params(&workspace_path, existing_session_id),
                                                );

                                                if let Err(e) = conn.send_message(session_load_request).await {
                                                    println!("[listener] Failed to send session/load: {}", e);
                                                    break;
                                                }
                                            } else {
                                                let session_new_id = next_rpc_id(&mut rpc_id_counter);
                                                session_new_request_id = Some(session_new_id);
                                                session_new_target_id = None;
                                                let session_new_request = build_rpc_request(
                                                    session_new_id,
                                                    "session/new",
                                                    build_session_new_params(&workspace_path),
                                                );

                                                if let Err(e) = conn.send_message(session_new_request).await {
                                                    println!("[listener] Failed to send session/new: {}", e);
                                                    break;
                                                }
                                            }

                                            continue;
                                        }

                                        if session_load_request_id == Some(response_id) {
                                            session_load_request_id = None;
                                            let load_target = session_load_target_id.take();
                                            let load_was_initialize = session_load_for_initialize;
                                            session_load_for_initialize = false;

                                            if let Some(error) = message_json.get("error") {
                                                println!("[listener] session/load failed: {}", error);
                                                if load_was_initialize {
                                                    let _ = app_handle.emit(
                                                        "stream-message",
                                                        json!({
                                                            "agentId": &agent_id,
                                                            "content": format!("⚠️ 会话恢复失败，已回退创建新会话：{}", error),
                                                            "type": "system",
                                                        }),
                                                    );
                                                    // 初始化恢复失败时，回退到创建新会话
                                                    let session_new_id = next_rpc_id(&mut rpc_id_counter);
                                                    session_new_request_id = Some(session_new_id);
                                                    session_new_target_id = None;
                                                    let session_new_request = build_rpc_request(
                                                        session_new_id,
                                                        "session/new",
                                                        build_session_new_params(&workspace_path),
                                                    );

                                                    if let Err(e) = conn.send_message(session_new_request).await {
                                                        println!("[listener] Failed to send fallback session/new: {}", e);
                                                        break;
                                                    }
                                                } else if let Some(target) = load_target.as_ref() {
                                                    let _ = app_handle.emit(
                                                        "stream-message",
                                                        json!({
                                                            "agentId": &agent_id,
                                                            "content": format!(
                                                                "⚠️ 目标会话恢复失败（{}），将回退创建会话：{}",
                                                                target,
                                                                error
                                                            ),
                                                            "type": "system",
                                                        }),
                                                    );
                                                    // 指定会话恢复失败时，尝试使用自定义 sessionId 新建会话（新版 ACP 支持）
                                                    let session_new_id = next_rpc_id(&mut rpc_id_counter);
                                                    session_new_request_id = Some(session_new_id);
                                                    session_new_target_id = Some(target.clone());
                                                    let session_new_request = build_rpc_request(
                                                        session_new_id,
                                                        "session/new",
                                                        build_session_new_params_with_id(
                                                            &workspace_path,
                                                            target,
                                                        ),
                                                    );
                                                    if let Err(e) = conn.send_message(session_new_request).await {
                                                        println!(
                                                            "[listener] Failed to send targeted session/new: {}",
                                                            e
                                                        );
                                                        let _ = app_handle.emit(
                                                            "agent-error",
                                                            json!({
                                                                "agentId": &agent_id,
                                                                "error": format!("session/load failed and session/new fallback failed for {}: {}", target, error),
                                                            }),
                                                        );
                                                        break;
                                                    }
                                                } else {
                                                    let _ = app_handle.emit(
                                                        "agent-error",
                                                        json!({
                                                            "agentId": &agent_id,
                                                            "error": format!("session/load failed: {}", error),
                                                        }),
                                                    );
                                                }
                                                continue;
                                            }

                                            if let Some(target_session_id) = load_target {
                                                session_id = Some(target_session_id.clone());
                                                let _ = app_handle.emit(
                                                    "acp-session",
                                                    json!({
                                                        "agentId": &agent_id,
                                                        "sessionId": target_session_id,
                                                    }),
                                                );
                                            }

                                            if let Some(result) = message_json.get("result") {
                                                emit_command_registry_payload(&app_handle, &agent_id, result);
                                                emit_model_registry_payload(&app_handle, &agent_id, result);
                                                emit_reported_context_usage(
                                                    &app_handle,
                                                    &agent_id,
                                                    session_id.as_deref(),
                                                    result,
                                                );
                                            }

                                            let message_text = if load_was_initialize {
                                                "✅ Qwen ACP 会话已恢复"
                                            } else {
                                                "✅ 已切换到目标会话"
                                            };
                                            let _ = app_handle.emit(
                                                "stream-message",
                                                json!({
                                                    "agentId": &agent_id,
                                                    "content": message_text,
                                                    "type": "system",
                                                }),
                                            );

                                            while let Some((prompt, target_session_id)) =
                                                queued_prompts.pop_front()
                                            {
                                                if let Some(target) = target_session_id.as_ref() {
                                                    if session_id.as_deref() != Some(target.as_str()) {
                                                        queued_prompts.push_front((
                                                            prompt,
                                                            target_session_id.clone(),
                                                        ));
                                                        if session_load_request_id.is_none() {
                                                            let load_id = next_rpc_id(&mut rpc_id_counter);
                                                            session_load_request_id = Some(load_id);
                                                            session_load_target_id = Some(target.clone());
                                                            session_load_for_initialize = false;
                                                            let load_request = build_rpc_request(
                                                                load_id,
                                                                "session/load",
                                                                build_session_load_params(
                                                                    &workspace_path,
                                                                    target,
                                                                ),
                                                            );
                                                            if let Err(e) = conn.send_message(load_request).await {
                                                                println!(
                                                                    "[listener] Failed to send queued session/load: {}",
                                                                    e
                                                                );
                                                                break;
                                                            }
                                                        }
                                                        break;
                                                    }
                                                }

                                                if let Some(current_session_id) = &session_id {
                                                    let prompt_id = next_rpc_id(&mut rpc_id_counter);
                                                    let prompt_request = build_rpc_request(
                                                        prompt_id,
                                                        "session/prompt",
                                                        build_prompt_params(current_session_id, &prompt),
                                                    );
                                                    if let Err(e) = conn.send_message(prompt_request).await {
                                                        println!("[listener] Failed to flush prompt queue: {}", e);
                                                        queued_prompts.push_front((
                                                            prompt,
                                                            target_session_id,
                                                        ));
                                                        break;
                                                    }
                                                    pending_prompt_request_ids.insert(prompt_id);
                                                } else {
                                                    queued_prompts.push_front((prompt, target_session_id));
                                                    break;
                                                }
                                            }

                                            continue;
                                        }

                                        if session_new_request_id == Some(response_id) {
                                            session_new_request_id = None;
                                            let requested_session_id = session_new_target_id.take();

                                            if let Some(error) = message_json.get("error") {
                                                let _ = app_handle.emit(
                                                    "agent-error",
                                                    json!({
                                                        "agentId": &agent_id,
                                                        "error": format!(
                                                            "session/new failed{}: {}",
                                                            requested_session_id
                                                                .as_ref()
                                                                .map(|item| format!(" for {}", item))
                                                                .unwrap_or_default(),
                                                            error
                                                        ),
                                                    }),
                                                );
                                                break;
                                            }

                                            session_id = message_json
                                                .get("result")
                                                .and_then(|r| r.get("sessionId"))
                                                .and_then(Value::as_str)
                                                .map(|s| s.to_string())
                                                .or(requested_session_id);
                                            if session_id.is_none() {
                                                let _ = app_handle.emit(
                                                    "agent-error",
                                                    json!({
                                                        "agentId": &agent_id,
                                                        "error": "session/new succeeded but no sessionId returned",
                                                    }),
                                                );
                                                break;
                                            }

                                            if let Some(result) = message_json.get("result") {
                                                emit_command_registry_payload(&app_handle, &agent_id, result);
                                                emit_model_registry_payload(&app_handle, &agent_id, result);
                                                emit_reported_context_usage(
                                                    &app_handle,
                                                    &agent_id,
                                                    session_id.as_deref(),
                                                    result,
                                                );
                                            }

                                            if let Some(current_session_id) = &session_id {
                                                let _ = app_handle.emit(
                                                    "acp-session",
                                                    json!({
                                                        "agentId": &agent_id,
                                                        "sessionId": current_session_id,
                                                    }),
                                                );
                                            }

                                            if let Some(current_session_id) = &session_id {
                                                while let Some((prompt, target_session_id)) =
                                                    queued_prompts.pop_front()
                                                {
                                                    if let Some(target) = target_session_id.as_ref() {
                                                        if session_id.as_deref() != Some(target.as_str()) {
                                                            queued_prompts.push_front((
                                                                prompt,
                                                                target_session_id.clone(),
                                                            ));
                                                            if session_load_request_id.is_none() {
                                                                let load_id = next_rpc_id(&mut rpc_id_counter);
                                                                session_load_request_id = Some(load_id);
                                                                session_load_target_id = Some(target.clone());
                                                                session_load_for_initialize = false;
                                                                let load_request = build_rpc_request(
                                                                    load_id,
                                                                    "session/load",
                                                                    build_session_load_params(
                                                                        &workspace_path,
                                                                        target,
                                                                    ),
                                                                );
                                                                if let Err(e) = conn.send_message(load_request).await {
                                                                    println!(
                                                                        "[listener] Failed to send queued session/load: {}",
                                                                        e
                                                                    );
                                                                    break;
                                                                }
                                                            }
                                                            break;
                                                        }
                                                    }
                                                    let prompt_id = next_rpc_id(&mut rpc_id_counter);
                                                    let prompt_request = build_rpc_request(
                                                        prompt_id,
                                                        "session/prompt",
                                                        build_prompt_params(current_session_id, &prompt),
                                                    );
                                                    if let Err(e) = conn.send_message(prompt_request).await {
                                                        println!("[listener] Failed to flush prompt queue: {}", e);
                                                        queued_prompts.push_front((
                                                            prompt,
                                                            target_session_id,
                                                        ));
                                                        break;
                                                    }
                                                    pending_prompt_request_ids.insert(prompt_id);
                                                }
                                            }

                                            continue;
                                        }

                                        if pending_prompt_request_ids.remove(&response_id) {
                                            if let Some(error) = message_json.get("error") {
                                                let _ = app_handle.emit(
                                                    "agent-error",
                                                    json!({
                                                        "agentId": &agent_id,
                                                        "error": format!("session/prompt failed: {}", error),
                                                    }),
                                                );
                                                continue;
                                            }

                                            if let Some(result) = message_json.get("result") {
                                                emit_reported_context_usage(
                                                    &app_handle,
                                                    &agent_id,
                                                    session_id.as_deref(),
                                                    result,
                                                );
                                            }

                                            let reason = message_json
                                                .get("result")
                                                .and_then(|r| r.get("stopReason"))
                                                .and_then(Value::as_str)
                                                .unwrap_or("completed");
                                            emit_task_finish(&app_handle, &agent_id, reason).await;
                                            continue;
                                        }

                                        if let Some((response, requested_model)) =
                                            pending_set_model_requests.remove(&response_id)
                                        {
                                            if let Some(error) = message_json.get("error") {
                                                let _ = response.send(Err(format!(
                                                    "session/set_model failed: {}",
                                                    error
                                                )));
                                                continue;
                                            }

                                            let current_model = message_json
                                                .get("result")
                                                .and_then(|result| result.get("currentModelId"))
                                                .and_then(Value::as_str)
                                                .map(|value| value.trim().to_string())
                                                .filter(|value| !value.is_empty())
                                                .unwrap_or(requested_model);

                                            let _ = app_handle.emit(
                                                "model-registry",
                                                json!({
                                                    "agentId": &agent_id,
                                                    "models": [],
                                                    "currentModel": current_model,
                                                }),
                                            );
                                            let _ = response.send(Ok(current_model));
                                            continue;
                                        }

                                        if let Some((response, requested_enable, requested_config)) =
                                            pending_set_think_requests.remove(&response_id)
                                        {
                                            if let Some(error) = message_json.get("error") {
                                                let _ = response.send(Err(format!(
                                                    "session/set_think failed: {}",
                                                    error
                                                )));
                                                continue;
                                            }

                                            let current_enabled = message_json
                                                .get("result")
                                                .and_then(|result| result.get("currentThinkEnabled"))
                                                .and_then(Value::as_bool)
                                                .unwrap_or(requested_enable);
                                            let current_config = message_json
                                                .get("result")
                                                .and_then(|result| result.get("currentThinkConfig"))
                                                .and_then(Value::as_str)
                                                .map(|value| value.trim().to_string())
                                                .filter(|value| !value.is_empty())
                                                .unwrap_or(requested_config);

                                            let _ = app_handle.emit(
                                                "think-status-changed",
                                                json!({
                                                    "agentId": &agent_id,
                                                    "enabled": current_enabled,
                                                    "config": current_config,
                                                }),
                                            );
                                            let _ = response.send(Ok(current_enabled));
                                            continue;
                                        }
                                    }
                                }
                                Ok(None) => {
                                    println!("[listener] stdio closed by server");
                                    return;
                                }
                                Err(e) => {
                                    println!("[listener] Receive error: {}", e);
                                    return;
                                }
                            }
                        }
                    }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{
        extract_reported_context_usage, normalized_command_entries,
        normalized_mcp_entries, parse_ndjson_line, should_handle_server_method,
        text_from_json_value,
    };

    #[test]
    fn parse_ndjson_line_reads_single_json_message() {
        let parsed = parse_ndjson_line(r#"{"jsonrpc":"2.0","id":1}"#)
            .expect("parse line")
            .expect("message");
        assert_eq!(parsed, json!({"jsonrpc":"2.0","id":1}));
    }

    #[test]
    fn parse_ndjson_line_ignores_blank_lines() {
        assert!(parse_ndjson_line("   ").expect("blank line").is_none());
    }

    #[test]
    fn private_iflow_methods_are_not_supported() {
        assert!(!should_handle_server_method("_iflow/user/questions"));
        assert!(!should_handle_server_method("_iflow/plan/exit"));
        assert!(should_handle_server_method("fs/read_text_file"));
    }

    #[test]
    fn parse_text_from_json_value_array() {
        let input = json!(["line1", "line2"]);
        assert_eq!(text_from_json_value(&input).as_deref(), Some("line1 line2"));
    }

    #[test]
    fn parse_available_commands_from_meta() {
        let payload = json!({
            "_meta": {
                "availableCommands": [
                    {
                        "name": "help",
                        "description": ["show", "help"],
                        "_meta": { "scope": "project" }
                    }
                ]
            }
        });

        let entries = normalized_command_entries(&payload);
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].get("name").and_then(|v| v.as_str()),
            Some("/help")
        );
        assert_eq!(
            entries[0].get("description").and_then(|v| v.as_str()),
            Some("show help")
        );
        assert_eq!(
            entries[0].get("scope").and_then(|v| v.as_str()),
            Some("project")
        );
    }

    #[test]
    fn parse_available_mcp_servers_from_meta() {
        let payload = json!({
            "_meta": {
                "availableMcpServers": [
                    {
                        "name": "filesystem",
                        "description": "Local FS"
                    }
                ]
            }
        });

        let entries = normalized_mcp_entries(&payload);
        assert_eq!(entries.len(), 1);
        assert_eq!(
            entries[0].get("name").and_then(|v| v.as_str()),
            Some("filesystem")
        );
        assert_eq!(
            entries[0].get("description").and_then(|v| v.as_str()),
            Some("Local FS")
        );
    }

    #[test]
    fn extract_reported_context_usage_prefers_prompt_tokens() {
        let payload = json!({
            "usageMetadata": {
                "promptTokenCount": 2500,
                "totalTokenCount": 2800
            },
            "contextWindowSize": 100000
        });

        let usage = extract_reported_context_usage(&payload).expect("reported usage");
        assert_eq!(usage.used_tokens, 2500);
        assert_eq!(usage.context_window, 100000);
        assert!((usage.percentage - 2.5).abs() < f64::EPSILON);
    }
}

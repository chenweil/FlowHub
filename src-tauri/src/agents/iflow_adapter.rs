use std::collections::{HashMap, HashSet, VecDeque};

use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tauri::Emitter;
use tokio::time::{timeout, Duration};
use tokio_tungstenite::tungstenite::Message as WsMessage;

use crate::models::ListenerCommand;
use crate::router::{emit_task_finish, handle_session_update};

// ACP 连接
struct AcpConnection {
    ws_stream: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
}

impl AcpConnection {
    async fn connect(url: &str) -> Result<Self, String> {
        let url = url::Url::parse(url).map_err(|e| format!("Invalid URL: {}", e))?;

        let (ws_stream, _) = tokio_tungstenite::connect_async(url)
            .await
            .map_err(|e| format!("WebSocket connection failed: {}", e))?;

        Ok(Self { ws_stream })
    }

    async fn send_message(&mut self, message: String) -> Result<(), String> {
        self.ws_stream
            .send(WsMessage::Text(message.into()))
            .await
            .map_err(|e| format!("Failed to send message: {}", e))
    }

    async fn receive_message(&mut self) -> Result<Option<String>, String> {
        match timeout(Duration::from_secs(30), self.ws_stream.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => Ok(Some(text.to_string())),
            Ok(Some(Ok(WsMessage::Binary(bin)))) => String::from_utf8(bin.to_vec())
                .map(Some)
                .map_err(|e| format!("Invalid UTF-8: {}", e)),
            Ok(Some(Ok(WsMessage::Ping(_)))) => Ok(Some(String::new())),
            Ok(Some(Ok(WsMessage::Pong(_)))) => Ok(Some(String::new())),
            Ok(Some(Ok(WsMessage::Close(_)))) => Ok(None),
            Ok(Some(Err(e))) => Err(format!("WebSocket error: {}", e)),
            Ok(None) => Ok(None),
            Err(_) => Ok(Some(String::new())),
            _ => Ok(None),
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

async fn send_rpc_result(conn: &mut AcpConnection, id: i64, result: Value) -> Result<(), String> {
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
    conn: &mut AcpConnection,
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

async fn handle_server_request(
    conn: &mut AcpConnection,
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
        "_iflow/user/questions" => {
            send_rpc_result(conn, request_id, json!({ "answers": {} })).await
        }
        "_iflow/plan/exit" => send_rpc_result(conn, request_id, json!({ "approved": true })).await,
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

fn build_initialize_params() -> Value {
    json!({
        "protocolVersion": 1,
        "clientCapabilities": {
            "fs": {
                "readTextFile": true,
                "writeTextFile": true,
            }
        },
        "mcpServers": [],
    })
}

fn build_session_new_params(workspace_path: &str) -> Value {
    json!({
        "cwd": workspace_path,
        "mcpServers": [],
        "settings": {
            "permission_mode": "yolo",
        }
    })
}

fn build_session_load_params(workspace_path: &str, session_id: &str) -> Value {
    json!({
        "cwd": workspace_path,
        "sessionId": session_id,
        "mcpServers": [],
        "settings": {
            "permission_mode": "yolo",
        }
    })
}

fn build_prompt_params(session_id: &str, prompt: &str) -> Value {
    json!({
        "sessionId": session_id,
        "prompt": [{
            "type": "text",
            "text": prompt,
        }],
    })
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

// 查找可用端口
pub async fn find_available_port() -> Result<u16, String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("Failed to bind: {}", e))?;
    let addr = listener
        .local_addr()
        .map_err(|e| format!("Failed to get local address: {}", e))?;
    let port = addr.port();
    drop(listener);
    Ok(port)
}

// 后台消息监听任务
pub async fn message_listener_task(
    app_handle: tauri::AppHandle,
    agent_id: String,
    ws_url: String,
    workspace_path: String,
    mut message_rx: tokio::sync::mpsc::UnboundedReceiver<ListenerCommand>,
) {
    println!("[listener] Starting for agent: {}", agent_id);

    let mut retry_count = 0;
    let max_retries = 5;
    let mut cached_session_id: Option<String> = None;

    // 未 ready 前收到的 prompt 先入队
    let mut queued_prompts: VecDeque<String> = VecDeque::new();

    while retry_count < max_retries {
        println!(
            "[listener] Connection attempt {}/{}",
            retry_count + 1,
            max_retries
        );

        match AcpConnection::connect(&ws_url).await {
            Ok(mut conn) => {
                println!("[listener] WebSocket connected!");
                retry_count = 0;

                let mut rpc_id_counter: i64 = 1;
                let mut initialize_request_id: Option<i64>;
                let mut session_new_request_id: Option<i64> = None;
                let mut session_load_request_id: Option<i64> = None;
                let mut session_id: Option<String> = cached_session_id.clone();
                let mut pending_prompt_request_ids: HashSet<i64> = HashSet::new();
                let mut pending_set_model_requests: HashMap<
                    i64,
                    (tokio::sync::oneshot::Sender<Result<String, String>>, String),
                > = HashMap::new();

                let init_id = next_rpc_id(&mut rpc_id_counter);
                let init_request =
                    build_rpc_request(init_id, "initialize", build_initialize_params());
                if let Err(e) = conn.send_message(init_request).await {
                    println!("[listener] Failed to send initialize: {}", e);
                    break;
                }
                initialize_request_id = Some(init_id);

                loop {
                    tokio::select! {
                        msg = message_rx.recv() => {
                            match msg {
                                Some(ListenerCommand::UserPrompt(prompt)) => {
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
                                            queued_prompts.push_front(prompt);
                                            break;
                                        }
                                        pending_prompt_request_ids.insert(prompt_id);
                                    } else {
                                        println!("[listener] Session not ready, prompt queued");
                                        queued_prompts.push_back(prompt);
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

                                        let Ok(message_json) = serde_json::from_str::<Value>(raw) else {
                                            println!("[listener] JSON parse failed: {}", raw);
                                            continue;
                                        };

                                        if let Some(method) = message_json.get("method").and_then(Value::as_str) {
                                            let request_id = parse_rpc_id(&message_json);
                                            let params = message_json.get("params");

                                            if method == "session/update" {
                                                if let Some(update) = params.and_then(|p| p.get("update")) {
                                                    handle_session_update(&app_handle, &agent_id, update).await;
                                                    emit_command_registry_from_update(&app_handle, &agent_id, update);
                                                }
                                                continue;
                                            }

                                            if let Some(request_id) = request_id {
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

                                            if let Some(error) = message_json.get("error") {
                                                println!("[listener] session/load failed: {}", error);
                                                // 如果恢复失败，回退到创建新会话
                                                let session_new_id = next_rpc_id(&mut rpc_id_counter);
                                                session_new_request_id = Some(session_new_id);
                                                let session_new_request = build_rpc_request(
                                                    session_new_id,
                                                    "session/new",
                                                    build_session_new_params(&workspace_path),
                                                );

                                                if let Err(e) = conn.send_message(session_new_request).await {
                                                    println!("[listener] Failed to send fallback session/new: {}", e);
                                                    break;
                                                }
                                                continue;
                                            }

                                            if let Some(result) = message_json.get("result") {
                                                emit_command_registry_payload(&app_handle, &agent_id, result);
                                                emit_model_registry_payload(&app_handle, &agent_id, result);
                                            }

                                            let _ = app_handle.emit(
                                                "stream-message",
                                                json!({
                                                    "agentId": &agent_id,
                                                    "content": "✅ iFlow ACP 会话已恢复",
                                                    "type": "system",
                                                }),
                                            );

                                            if let Some(current_session_id) = &session_id {
                                                while let Some(prompt) = queued_prompts.pop_front() {
                                                    let prompt_id = next_rpc_id(&mut rpc_id_counter);
                                                    let prompt_request = build_rpc_request(
                                                        prompt_id,
                                                        "session/prompt",
                                                        build_prompt_params(current_session_id, &prompt),
                                                    );
                                                    if let Err(e) = conn.send_message(prompt_request).await {
                                                        println!("[listener] Failed to flush prompt queue: {}", e);
                                                        queued_prompts.push_front(prompt);
                                                        break;
                                                    }
                                                    pending_prompt_request_ids.insert(prompt_id);
                                                }
                                            }

                                            continue;
                                        }

                                        if session_new_request_id == Some(response_id) {
                                            session_new_request_id = None;

                                            if let Some(error) = message_json.get("error") {
                                                let _ = app_handle.emit(
                                                    "agent-error",
                                                    json!({
                                                        "agentId": &agent_id,
                                                        "error": format!("session/new failed: {}", error),
                                                    }),
                                                );
                                                break;
                                            }

                                            session_id = message_json
                                                .get("result")
                                                .and_then(|r| r.get("sessionId"))
                                                .and_then(Value::as_str)
                                                .map(|s| s.to_string());
                                            cached_session_id = session_id.clone();

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
                                            }

                                            if let Some(current_session_id) = &session_id {
                                                while let Some(prompt) = queued_prompts.pop_front() {
                                                    let prompt_id = next_rpc_id(&mut rpc_id_counter);
                                                    let prompt_request = build_rpc_request(
                                                        prompt_id,
                                                        "session/prompt",
                                                        build_prompt_params(current_session_id, &prompt),
                                                    );
                                                    if let Err(e) = conn.send_message(prompt_request).await {
                                                        println!("[listener] Failed to flush prompt queue: {}", e);
                                                        queued_prompts.push_front(prompt);
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
                                    }
                                }
                                Ok(None) => {
                                    println!("[listener] WebSocket closed by server");
                                    break;
                                }
                                Err(e) => {
                                    println!("[listener] Receive error: {}", e);
                                    break;
                                }
                            }
                        }
                    }
                }
            }
            Err(e) => {
                retry_count += 1;
                println!("[listener] Connection failed: {}", e);
                if retry_count >= max_retries {
                    let _ = app_handle.emit(
                        "agent-error",
                        json!({
                            "agentId": &agent_id,
                            "error": format!("Failed after {} attempts: {}", max_retries, e),
                        }),
                    );
                    break;
                }
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
        }
    }

    println!("[listener] Stopped for agent: {}", agent_id);
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{normalized_command_entries, normalized_mcp_entries, text_from_json_value};

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
}

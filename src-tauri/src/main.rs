// iFlow Workspace - Tauri Backend
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::process::Stdio;
use std::sync::Arc;
use tauri::{Emitter, State};
use tokio::process::{Child, Command};
use tokio::sync::RwLock;
use tokio::time::{timeout, Duration};

// Agent 状态
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    pub agent_type: String,
    pub status: AgentStatus,
    pub workspace_path: String,
    pub port: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentStatus {
    Disconnected,
    Connecting,
    Connected,
    Error,
}

// 消息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub role: String,
    pub content: String,
    pub timestamp: String,
}

// 工具调用
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub status: String,
    pub arguments: Option<serde_json::Value>,
    pub output: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PlanEntry {
    content: String,
    status: String,
}

#[derive(Debug, Clone)]
pub(crate) enum ListenerCommand {
    UserPrompt(String),
}

// Agent 实例
pub struct AgentInstance {
    pub info: AgentInfo,
    pub process: Option<Child>,
    pub port: u16,
    pub(crate) message_sender: Option<MessageSender>,
}

// 应用状态
pub struct AppState {
    pub agents: Arc<RwLock<HashMap<String, AgentInstance>>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            agents: Arc::new(RwLock::new(HashMap::new())),
        }
    }
}

// ACP 连接
pub struct AcpConnection {
    ws_stream: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
}

impl AcpConnection {
    pub async fn connect(url: &str) -> Result<Self, String> {
        let url = url::Url::parse(url).map_err(|e| format!("Invalid URL: {}", e))?;

        let (ws_stream, _) = tokio_tungstenite::connect_async(url)
            .await
            .map_err(|e| format!("WebSocket connection failed: {}", e))?;

        Ok(Self { ws_stream })
    }

    pub async fn send_message(&mut self, message: String) -> Result<(), String> {
        use futures::SinkExt;
        use tokio_tungstenite::tungstenite::Message as WsMessage;

        self.ws_stream
            .send(WsMessage::Text(message.into()))
            .await
            .map_err(|e| format!("Failed to send message: {}", e))
    }

    pub async fn receive_message(&mut self) -> Result<Option<String>, String> {
        use futures::StreamExt;
        use tokio_tungstenite::tungstenite::Message as WsMessage;

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

// 查找可用端口
async fn find_available_port() -> Result<u16, String> {
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

// 连接响应
#[derive(Serialize)]
pub struct ConnectResponse {
    pub success: bool,
    pub port: u16,
    pub error: Option<String>,
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

fn text_from_content(content: &Value) -> Option<String> {
    let content_type = content.get("type")?.as_str()?;
    match content_type {
        "text" => content.get("text")?.as_str().map(|s| s.to_string()),
        _ => Some(content.to_string()),
    }
}

fn text_from_tool_contents(contents: &Value) -> Option<String> {
    let items = contents.as_array()?;
    let mut texts = Vec::new();

    for item in items {
        match item.get("type").and_then(Value::as_str) {
            Some("content") => {
                if let Some(content) = item.get("content") {
                    if let Some(text) = text_from_content(content) {
                        texts.push(text);
                    }
                }
            }
            Some("diff") => {
                if let Some(path) = item.get("path").and_then(Value::as_str) {
                    texts.push(format!("[diff] {}", path));
                }
            }
            _ => {}
        }
    }

    if texts.is_empty() {
        None
    } else {
        Some(texts.join("\n"))
    }
}

fn stop_reason_to_message(reason: &str) -> &'static str {
    match reason {
        "end_turn" => "✅ 任务完成",
        "max_tokens" => "⚠️ 达到最大令牌限制",
        "cancelled" => "🚫 任务已取消",
        "refusal" => "⛔ 模型拒绝回答",
        _ => "✅ 任务结束",
    }
}

async fn emit_task_finish(app_handle: &tauri::AppHandle, agent_id: &str, reason: &str) {
    let _ = app_handle.emit(
        "stream-message",
        json!({
            "agentId": agent_id,
            "content": stop_reason_to_message(reason),
            "type": "system",
        }),
    );

    let _ = app_handle.emit(
        "task-finish",
        json!({
            "agentId": agent_id,
            "reason": reason,
        }),
    );
}

async fn handle_session_update(app_handle: &tauri::AppHandle, agent_id: &str, update: &Value) {
    let Some(session_update) = update.get("sessionUpdate").and_then(Value::as_str) else {
        return;
    };

    match session_update {
        "agent_message_chunk" => {
            if let Some(content) = update.get("content").and_then(text_from_content) {
                let _ = app_handle.emit(
                    "stream-message",
                    json!({
                        "agentId": agent_id,
                        "content": content,
                        "type": "content",
                    }),
                );
            }
        }
        "agent_thought_chunk" => {
            if let Some(content) = update.get("content").and_then(text_from_content) {
                let _ = app_handle.emit(
                    "stream-message",
                    json!({
                        "agentId": agent_id,
                        "content": format!("💭 {}", content),
                        "type": "thought",
                    }),
                );
            }
        }
        "tool_call" | "tool_call_update" => {
            let tool_call = ToolCall {
                id: update
                    .get("toolCallId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                name: update
                    .get("toolName")
                    .and_then(Value::as_str)
                    .or_else(|| update.get("title").and_then(Value::as_str))
                    .unwrap_or_default()
                    .to_string(),
                status: update
                    .get("status")
                    .and_then(Value::as_str)
                    .unwrap_or("pending")
                    .to_string(),
                arguments: update.get("args").cloned(),
                output: update.get("content").and_then(text_from_tool_contents),
            };

            let _ = app_handle.emit(
                "tool-call",
                json!({
                    "agentId": agent_id,
                    "toolCalls": vec![tool_call],
                }),
            );
        }
        "plan" => {
            let mut entries = Vec::new();

            if let Some(raw_entries) = update.get("entries").and_then(Value::as_array) {
                for raw_entry in raw_entries {
                    if let Ok(entry) = serde_json::from_value::<PlanEntry>(raw_entry.clone()) {
                        entries.push(format!("[{}] {}", entry.status, entry.content));
                    }
                }
            }

            if !entries.is_empty() {
                let _ = app_handle.emit(
                    "stream-message",
                    json!({
                        "agentId": agent_id,
                        "content": format!("📋 执行计划:\n{}", entries.join("\n")),
                        "type": "plan",
                    }),
                );
            }
        }
        "user_message_chunk" => {
            // 用户消息回显忽略
        }
        _ => {
            println!(
                "[listener] Unhandled session update type: {}",
                session_update
            );
        }
    }
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
                Ok(content) => send_rpc_result(
                    conn,
                    request_id,
                    json!({
                        "content": content,
                        "path": path,
                        "sessionId": session_id,
                    }),
                )
                .await,
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

// 后台消息监听任务
async fn message_listener_task(
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
                                            if raw.contains("ready") {
                                                let _ = app_handle.emit(
                                                    "stream-message",
                                                    json!({
                                                        "agentId": &agent_id,
                                                        "content": "✅ iFlow 连接已建立，正在初始化会话...",
                                                        "type": "system",
                                                    }),
                                                );
                                            }
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

                                            let _ = app_handle.emit(
                                                "stream-message",
                                                json!({
                                                    "agentId": &agent_id,
                                                    "content": "✅ iFlow ACP 会话已就绪",
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

/// 连接 iFlow
#[tauri::command]
async fn connect_iflow(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    agent_id: String,
    iflow_path: String,
    workspace_path: String,
) -> Result<ConnectResponse, String> {
    println!("Connecting to iFlow...");
    println!("Agent ID: {}", agent_id);
    println!("Workspace: {}", workspace_path);

    // 查找可用端口
    let port = find_available_port().await?;
    println!("Using port: {}", port);

    // 启动 iFlow 进程
    let mut cmd = Command::new(&iflow_path);
    cmd.current_dir(&workspace_path)
        .arg("--experimental-acp")
        .arg("--port")
        .arg(port.to_string())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    println!("Spawning iFlow process...");
    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start iFlow: {}", e))?;
    println!("iFlow process started, PID: {:?}", child.id());

    // 等待 iFlow 启动
    println!("Waiting for iFlow to initialize...");
    tokio::time::sleep(Duration::from_secs(3)).await;

    let ws_url = format!("ws://127.0.0.1:{}/acp", port);

    // 创建消息发送通道
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<ListenerCommand>();

    // 保存 Agent 实例
    let agent_info = AgentInfo {
        id: agent_id.clone(),
        name: "iFlow".to_string(),
        agent_type: "iflow".to_string(),
        status: AgentStatus::Connected,
        workspace_path: workspace_path.clone(),
        port: Some(port),
    };

    let instance = AgentInstance {
        info: agent_info,
        process: Some(child),
        port,
        message_sender: Some(tx),
    };

    {
        let mut agents = state.agents.write().await;
        agents.insert(agent_id.clone(), instance);
        println!("[connect] Agent saved, total agents: {}", agents.len());
        println!(
            "[connect] Agent IDs: {:?}",
            agents.keys().collect::<Vec<_>>()
        );
    }

    // 启动后台消息监听任务
    let app_handle_clone = app_handle.clone();
    let agent_id_clone = agent_id.clone();
    let ws_url_clone = ws_url.clone();
    let workspace_path_clone = workspace_path.clone();

    tokio::spawn(async move {
        message_listener_task(
            app_handle_clone,
            agent_id_clone,
            ws_url_clone,
            workspace_path_clone,
            rx,
        )
        .await;
    });

    println!("Agent {} connected successfully", agent_id);

    Ok(ConnectResponse {
        success: true,
        port,
        error: None,
    })
}

// 用于在任务间传递消息发送请求的通道
type MessageSender = tokio::sync::mpsc::UnboundedSender<ListenerCommand>;

/// 发送消息
#[tauri::command]
async fn send_message(
    state: State<'_, AppState>,
    agent_id: String,
    content: String,
) -> Result<(), String> {
    println!(
        "[send_message] Starting for agent {}: {}",
        agent_id, content
    );

    let sender = {
        let agents = state.agents.read().await;
        println!(
            "[send_message] Got agents lock, total agents: {}",
            agents.len()
        );
        println!(
            "[send_message] Available agent IDs: {:?}",
            agents.keys().collect::<Vec<_>>()
        );
        println!("[send_message] Looking for agent: {}", agent_id);

        if let Some(instance) = agents.get(&agent_id) {
            println!(
                "[send_message] Found agent! sender exists: {}",
                instance.message_sender.is_some()
            );
            instance.message_sender.clone()
        } else {
            println!("[send_message] ERROR: Agent {} not found!", agent_id);
            return Err(format!("Agent {} not found", agent_id));
        }
    };

    if let Some(sender) = sender {
        println!(
            "[send_message] Queueing user prompt to listener: {}",
            &content[..content.len().min(100)]
        );
        match sender.send(ListenerCommand::UserPrompt(content)) {
            Ok(_) => {
                println!("[send_message] Prompt queued successfully");
                Ok(())
            }
            Err(e) => {
                println!("[send_message] Failed to queue prompt: {}", e);
                Err(format!("Failed to queue prompt: {}", e))
            }
        }
    } else {
        println!("[send_message] Message sender not available");
        Err("Message sender not available".to_string())
    }
}

/// 断开连接
#[tauri::command]
async fn disconnect_agent(state: State<'_, AppState>, agent_id: String) -> Result<(), String> {
    println!("Disconnecting agent: {}", agent_id);

    let mut agents = state.agents.write().await;

    if let Some(mut instance) = agents.remove(&agent_id) {
        if let Some(mut process) = instance.process.take() {
            let _ = process.kill().await;
        }
        println!("Agent {} disconnected", agent_id);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_text_from_content_text() {
        let content = json!({ "type": "text", "text": "hello" });
        assert_eq!(text_from_content(&content).as_deref(), Some("hello"));
    }

    #[test]
    fn test_text_from_tool_contents() {
        let content = json!([
            {
                "type": "content",
                "content": {
                    "type": "text",
                    "text": "line1"
                }
            },
            {
                "type": "diff",
                "path": "src/main.ts"
            }
        ]);

        let text = text_from_tool_contents(&content).unwrap_or_default();
        assert!(text.contains("line1"));
        assert!(text.contains("src/main.ts"));
    }
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            connect_iflow,
            send_message,
            disconnect_agent,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

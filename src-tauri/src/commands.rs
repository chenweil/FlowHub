use std::env;
use std::collections::HashSet;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Instant;

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use tauri::State;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

use crate::agents::iflow_adapter::{find_available_port, message_listener_task};
use crate::models::{AgentInfo, AgentStatus, ConnectResponse, ListenerCommand, ModelOption};
use crate::state::{AgentInstance, AppState};

const MAX_HTML_ARTIFACT_SIZE: u64 = 2 * 1024 * 1024;

async fn spawn_iflow_agent(
    app_handle: tauri::AppHandle,
    state: &AppState,
    agent_id: String,
    iflow_path: String,
    workspace_path: String,
    model: Option<String>,
) -> Result<ConnectResponse, String> {
    println!("Connecting to iFlow...");
    println!("Agent ID: {}", agent_id);
    println!("Workspace: {}", workspace_path);
    if let Some(model_name) = model.as_ref() {
        println!("Model override: {}", model_name);
    }

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

    if let Some(model_name) = model.as_ref() {
        let trimmed = model_name.trim();
        if !trimmed.is_empty() {
            cmd.arg("--model").arg(trimmed);
        }
    }

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
        iflow_path: iflow_path.clone(),
        model: model.clone(),
        message_sender: Some(tx),
    };

    state.agent_manager.upsert(agent_id.clone(), instance).await;
    let (agent_count, agent_ids) = state.agent_manager.stats().await;
    println!("[connect] Agent saved, total agents: {}", agent_count);
    println!("[connect] Agent IDs: {:?}", agent_ids);

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

/// 连接 iFlow
#[tauri::command]
pub async fn connect_iflow(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    agent_id: String,
    iflow_path: String,
    workspace_path: String,
    model: Option<String>,
) -> Result<ConnectResponse, String> {
    spawn_iflow_agent(
        app_handle,
        &state,
        agent_id,
        iflow_path,
        workspace_path,
        model,
    )
    .await
}

/// 切换模型（通过重启 ACP 会话生效）
#[tauri::command]
pub async fn switch_agent_model(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    agent_id: String,
    iflow_path: String,
    workspace_path: String,
    model: String,
) -> Result<ConnectResponse, String> {
    let target_model = model.trim();
    if target_model.is_empty() {
        return Err("Model name cannot be empty".to_string());
    }

    let (agent_exists, sender) = state.agent_manager.sender_of(&agent_id).await;
    if agent_exists {
        if let Some(sender) = sender {
            let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
            let send_result = sender.send(ListenerCommand::SetModel {
                model: target_model.to_string(),
                response: tx,
            });

            if send_result.is_ok() {
                match timeout(Duration::from_secs(20), rx).await {
                    Ok(Ok(Ok(_current_model))) => {
                        let port = state
                            .agent_manager
                            .port_of(&agent_id)
                            .await
                            .ok_or_else(|| "Agent port not available".to_string())?;
                        return Ok(ConnectResponse {
                            success: true,
                            port,
                            error: None,
                        });
                    }
                    Ok(Ok(Err(err))) => {
                        println!(
                            "[switch_agent_model] ACP switch failed, fallback to restart: {}",
                            err
                        );
                    }
                    Ok(Err(_)) => {
                        println!(
                            "[switch_agent_model] ACP switch response channel closed, fallback to restart"
                        );
                    }
                    Err(_) => {
                        println!("[switch_agent_model] ACP switch timeout, fallback to restart");
                    }
                }
            } else {
                println!(
                    "[switch_agent_model] Failed to send ACP switch command, fallback to restart"
                );
            }
        }
    }

    if let Some(mut instance) = state.agent_manager.remove(&agent_id).await {
        if let Some(mut process) = instance.process.take() {
            let _ = process.kill().await;
        }
    }

    spawn_iflow_agent(
        app_handle,
        &state,
        agent_id,
        iflow_path,
        workspace_path,
        Some(target_model.to_string()),
    )
    .await
}

fn resolve_iflow_executable_path(iflow_path: &str) -> Result<PathBuf, String> {
    let trimmed = iflow_path.trim();
    if trimmed.is_empty() {
        return Err("iflow path cannot be empty".to_string());
    }

    let input_path = PathBuf::from(trimmed);
    if input_path.is_absolute() || trimmed.contains(std::path::MAIN_SEPARATOR) {
        if input_path.exists() {
            let resolved = std::fs::canonicalize(&input_path).unwrap_or(input_path);
            return Ok(resolved);
        }
        return Err(format!("iflow executable not found: {}", trimmed));
    }

    let path_var =
        env::var_os("PATH").ok_or_else(|| "PATH environment variable not found".to_string())?;
    for search_path in env::split_paths(&path_var) {
        let candidate = search_path.join(trimmed);
        if candidate.is_file() {
            let resolved = std::fs::canonicalize(&candidate).unwrap_or(candidate);
            return Ok(resolved);
        }
    }

    Err(format!("iflow executable not found in PATH: {}", trimmed))
}

fn resolve_iflow_bundle_entry(iflow_path: &str) -> Result<PathBuf, String> {
    let executable_path = resolve_iflow_executable_path(iflow_path)?;
    let resolved = std::fs::canonicalize(&executable_path).unwrap_or(executable_path);

    if resolved.extension().and_then(|ext| ext.to_str()) != Some("js") {
        return Err(format!(
            "Unsupported iflow executable target: {}",
            resolved.display()
        ));
    }

    let candidates = build_bundle_entry_candidates(&resolved);
    for candidate in candidates {
        if candidate.exists() {
            let canonicalized = std::fs::canonicalize(&candidate).unwrap_or(candidate);
            return Ok(canonicalized);
        }
    }

    Err(format!(
        "iflow bundle entry not found near: {}",
        resolved.display()
    ))
}

fn push_candidate(candidates: &mut Vec<PathBuf>, candidate: PathBuf) {
    if !candidates.iter().any(|existing| existing == &candidate) {
        candidates.push(candidate);
    }
}

fn build_bundle_entry_candidates(executable_entry: &Path) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Some(parent) = executable_entry.parent() {
        // Newer iFlow releases put model constants in iflow.js instead of entry.js.
        push_candidate(&mut candidates, parent.join("iflow.js"));
        push_candidate(&mut candidates, parent.join("entry.js"));
    }

    push_candidate(&mut candidates, executable_entry.to_path_buf());
    candidates
}

fn extract_bracket_block(source: &str, anchor: &str) -> Option<String> {
    let start_anchor = source.find(anchor)?;
    let array_start = start_anchor + anchor.len().saturating_sub(1);
    let mut depth = 0_i32;
    let mut in_string = false;
    let mut escaped = false;

    for (offset, ch) in source[array_start..].char_indices() {
        if escaped {
            escaped = false;
            continue;
        }

        if ch == '\\' {
            escaped = true;
            continue;
        }

        if ch == '"' {
            in_string = !in_string;
            continue;
        }

        if in_string {
            continue;
        }

        if ch == '[' {
            depth += 1;
            continue;
        }

        if ch == ']' {
            depth -= 1;
            if depth == 0 {
                let end_index = array_start + offset + 1;
                return Some(source[array_start..end_index].to_string());
            }
        }
    }

    None
}

fn parse_model_entries_from_array_block(block: &str) -> Vec<ModelOption> {
    let mut options = Vec::new();
    let mut cursor = 0_usize;
    const LABEL_PREFIX: &str = "{label:\"";
    const VALUE_SEPARATOR: &str = "\",value:\"";

    while let Some(start_rel) = block[cursor..].find(LABEL_PREFIX) {
        let label_start = cursor + start_rel + LABEL_PREFIX.len();
        let Some(value_sep_rel) = block[label_start..].find(VALUE_SEPARATOR) else {
            break;
        };
        let label_end = label_start + value_sep_rel;
        let value_start = label_end + VALUE_SEPARATOR.len();
        let Some(value_end_rel) = block[value_start..].find('"') else {
            break;
        };
        let value_end = value_start + value_end_rel;

        let label = block[label_start..label_end].replace("\\\"", "\"");
        let value = block[value_start..value_end].replace("\\\"", "\"");
        if !value.trim().is_empty() {
            options.push(ModelOption { label, value });
        }

        cursor = value_end + 1;
    }

    options
}

fn extract_model_options_from_bundle(entry_path: &Path) -> Result<Vec<ModelOption>, String> {
    let bundle_text = std::fs::read_to_string(entry_path).map_err(|e| {
        format!(
            "Failed to read iflow bundle {}: {}",
            entry_path.display(),
            e
        )
    })?;

    let anchors = ["CAe=[", "modelOptions=[", "models=["];
    let mut block = None;
    for anchor in anchors {
        block = extract_bracket_block(&bundle_text, anchor);
        if block.is_some() {
            break;
        }
    }

    let block = block.ok_or_else(|| "Failed to locate model list in iflow bundle".to_string())?;
    let models = parse_model_entries_from_array_block(&block);
    if models.is_empty() {
        return Err("No model entries found in iflow bundle".to_string());
    }

    Ok(models)
}

#[tauri::command]
pub async fn list_available_models(iflow_path: String) -> Result<Vec<ModelOption>, String> {
    let entry_path = resolve_iflow_bundle_entry(&iflow_path)?;
    extract_model_options_from_bundle(&entry_path)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IflowHistorySession {
    pub session_id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IflowHistoryMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub timestamp: String,
}

fn normalize_workspace_path(workspace_path: &str) -> String {
    let mut normalized = workspace_path.trim().replace('\\', "/");
    while normalized.len() > 1 && normalized.ends_with('/') {
        normalized.pop();
    }
    normalized
}

fn workspace_to_iflow_project_key(workspace_path: &str) -> String {
    let normalized = normalize_workspace_path(workspace_path);
    let mut key = normalized.replace('/', "-").replace(':', "-");
    if !key.starts_with('-') {
        key = format!("-{}", key);
    }
    key
}

fn iflow_projects_root() -> Result<PathBuf, String> {
    let home_dir = env::var("HOME").map_err(|e| format!("HOME is not set: {}", e))?;
    Ok(PathBuf::from(home_dir).join(".iflow").join("projects"))
}

fn iflow_project_dirs_for_workspace(
    workspace_path: &str,
    normalized_workspace_path: &str,
) -> Result<Vec<PathBuf>, String> {
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();

    for path in [workspace_path, normalized_workspace_path] {
        let key = workspace_to_iflow_project_key(path);
        if seen.insert(key.clone()) {
            candidates.push(iflow_projects_root()?.join(key));
        }
    }

    Ok(candidates)
}

fn to_rfc3339_or_now(system_time: Option<std::time::SystemTime>) -> String {
    system_time
        .map(DateTime::<Utc>::from)
        .map(|time| time.to_rfc3339())
        .unwrap_or_else(|| Utc::now().to_rfc3339())
}

fn compact_title(raw: &str) -> String {
    let normalized = raw.replace('\n', " ").replace('\r', " ").trim().to_string();
    if normalized.is_empty() {
        return "iFlow 会话".to_string();
    }
    let max_len = 28;
    if normalized.chars().count() <= max_len {
        return normalized;
    }
    format!("{}...", normalized.chars().take(max_len).collect::<String>())
}

fn extract_text_value(value: &Value) -> Option<String> {
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
            let parts: Vec<String> = items.iter().filter_map(extract_text_value).collect();
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n"))
            }
        }
        Value::Object(map) => {
            if let Some(text) = map.get("text").and_then(extract_text_value) {
                return Some(text);
            }
            map.get("content").and_then(extract_text_value)
        }
        _ => None,
    }
}

fn extract_text_entries_only(value: &Value) -> Option<String> {
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
            let mut parts = Vec::new();
            for item in items {
                let Some(item_map) = item.as_object() else {
                    continue;
                };
                let Some(item_type) = item_map.get("type").and_then(Value::as_str) else {
                    continue;
                };
                if item_type != "text" {
                    continue;
                }
                if let Some(text) = item_map.get("text").and_then(extract_text_value) {
                    parts.push(text);
                }
            }
            if parts.is_empty() {
                None
            } else {
                Some(parts.join("\n"))
            }
        }
        Value::Object(map) => {
            if let Some(item_type) = map.get("type").and_then(Value::as_str) {
                if item_type != "text" {
                    return None;
                }
                return map.get("text").and_then(extract_text_value);
            }

            if let Some(text) = map.get("text").and_then(extract_text_value) {
                return Some(text);
            }

            map.get("content").and_then(extract_text_entries_only)
        }
        _ => None,
    }
}

fn has_structured_tool_entries(value: &Value) -> bool {
    let Value::Array(items) = value else {
        return false;
    };

    items.iter().any(|item| {
        item.as_object()
            .and_then(|map| map.get("type"))
            .and_then(Value::as_str)
            .map(|kind| kind == "tool_use" || kind == "tool_result")
            .unwrap_or(false)
    })
}

fn extract_history_message_content(record: &Value, record_type: &str) -> Option<String> {
    let content = record.get("message").and_then(|message| message.get("content"))?;

    if has_structured_tool_entries(content) {
        // 过滤工具编排中间日志，避免污染历史回复与 Markdown 渲染。
        return None;
    }

    // 仅提取文本片段，忽略 tool_use/tool_result 等结构化条目。
    let text_only = extract_text_entries_only(content)?;
    if text_only.trim().is_empty() {
        return None;
    }

    // 对 user/assistant 之外的类型不展示（理论上外层已过滤，这里兜底）。
    if record_type != "user" && record_type != "assistant" {
        return None;
    }

    Some(text_only)
}

fn extract_history_timestamp(record: &Value) -> Option<String> {
    record
        .get("timestamp")
        .and_then(Value::as_str)
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
}

fn extract_history_record_cwd(record: &Value) -> Option<String> {
    record
        .get("cwd")
        .and_then(Value::as_str)
        .map(normalize_workspace_path)
}

async fn parse_iflow_history_summary(
    file_path: &Path,
    session_id: &str,
    expected_workspace_path: &str,
) -> Result<Option<IflowHistorySession>, String> {
    let raw = tokio::fs::read_to_string(file_path)
        .await
        .map_err(|e| format!("Failed to read {}: {}", file_path.display(), e))?;
    let metadata = tokio::fs::metadata(file_path).await.ok();
    let fallback_ts = to_rfc3339_or_now(metadata.and_then(|item| item.modified().ok()));

    let mut created_at: Option<String> = None;
    let mut updated_at: Option<String> = None;
    let mut title: Option<String> = None;
    let mut message_count = 0_usize;
    let mut has_cwd = false;
    let mut workspace_matches = false;

    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let Ok(record) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };

        let record_type = record
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        if record_type != "user" && record_type != "assistant" {
            continue;
        }

        if let Some(cwd) = extract_history_record_cwd(&record) {
            has_cwd = true;
            if cwd == expected_workspace_path {
                workspace_matches = true;
            }
        }

        let Some(content) = extract_history_message_content(&record, record_type) else {
            continue;
        };

        message_count += 1;

        if let Some(ts) = extract_history_timestamp(&record) {
            if created_at.is_none() {
                created_at = Some(ts.clone());
            }
            updated_at = Some(ts);
        }

        if title.is_none() && record_type == "user" {
            title = Some(content);
        }
    }

    if has_cwd && !workspace_matches {
        return Ok(None);
    }

    Ok(Some(IflowHistorySession {
        session_id: session_id.to_string(),
        title: compact_title(title.as_deref().unwrap_or(session_id)),
        created_at: created_at.unwrap_or_else(|| fallback_ts.clone()),
        updated_at: updated_at.unwrap_or(fallback_ts),
        message_count,
    }))
}

async fn parse_iflow_history_messages(
    file_path: &Path,
    session_id: &str,
    expected_workspace_path: &str,
) -> Result<Vec<IflowHistoryMessage>, String> {
    let raw = tokio::fs::read_to_string(file_path)
        .await
        .map_err(|e| format!("Failed to read {}: {}", file_path.display(), e))?;

    let mut messages = Vec::new();
    let mut has_cwd = false;
    let mut workspace_matches = false;
    for (index, line) in raw.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let Ok(record) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };

        let record_type = record
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        let role = if record_type == "assistant" {
            "assistant"
        } else if record_type == "user" {
            "user"
        } else {
            continue;
        };

        if let Some(cwd) = extract_history_record_cwd(&record) {
            has_cwd = true;
            if cwd == expected_workspace_path {
                workspace_matches = true;
            }
        }

        let Some(content) = extract_history_message_content(&record, record_type) else {
            continue;
        };

        let timestamp = extract_history_timestamp(&record).unwrap_or_else(|| Utc::now().to_rfc3339());

        let id = record
            .get("uuid")
            .and_then(Value::as_str)
            .map(|item| item.to_string())
            .unwrap_or_else(|| format!("{}-{}", session_id, index));

        messages.push(IflowHistoryMessage {
            id,
            role: role.to_string(),
            content,
            timestamp,
        });
    }

    if has_cwd && !workspace_matches {
        return Err(format!(
            "Session {} does not belong to workspace {}",
            session_id, expected_workspace_path
        ));
    }

    Ok(messages)
}

#[tauri::command]
pub async fn list_iflow_history_sessions(
    workspace_path: String,
) -> Result<Vec<IflowHistorySession>, String> {
    let normalized_workspace = match tokio::fs::canonicalize(&workspace_path).await {
        Ok(path) => normalize_workspace_path(&path.to_string_lossy()),
        Err(_) => normalize_workspace_path(&workspace_path),
    };
    let candidate_dirs = iflow_project_dirs_for_workspace(&workspace_path, &normalized_workspace)?;

    let mut seen_sessions = HashSet::new();
    let mut sessions = Vec::new();
    for project_dir in candidate_dirs {
        let mut reader = match tokio::fs::read_dir(&project_dir).await {
            Ok(reader) => reader,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to open iFlow project dir {}: {}",
                    project_dir.display(),
                    error
                ))
            }
        };

        while let Some(entry) = reader
            .next_entry()
            .await
            .map_err(|e| format!("Failed to read iFlow project entry: {}", e))?
        {
            let path = entry.path();
            let file_name = entry.file_name();
            let file_name = file_name.to_string_lossy();
            if !file_name.starts_with("session-") || !file_name.ends_with(".jsonl") {
                continue;
            }

            let session_id = file_name.trim_end_matches(".jsonl").to_string();
            if !seen_sessions.insert(session_id.clone()) {
                continue;
            }
            if let Ok(Some(summary)) =
                parse_iflow_history_summary(&path, &session_id, &normalized_workspace).await
            {
                sessions.push(summary);
            }
        }
    }

    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(sessions)
}

#[tauri::command]
pub async fn load_iflow_history_messages(
    workspace_path: String,
    session_id: String,
) -> Result<Vec<IflowHistoryMessage>, String> {
    let normalized_session_id = normalize_iflow_session_id(&session_id)?;

    let normalized_workspace = match tokio::fs::canonicalize(&workspace_path).await {
        Ok(path) => normalize_workspace_path(&path.to_string_lossy()),
        Err(_) => normalize_workspace_path(&workspace_path),
    };
    let candidate_dirs = iflow_project_dirs_for_workspace(&workspace_path, &normalized_workspace)?;

    for project_dir in candidate_dirs {
        let file_path = project_dir.join(format!("{}.jsonl", normalized_session_id));
        match tokio::fs::metadata(&file_path).await {
            Ok(metadata) if metadata.is_file() => {
                return parse_iflow_history_messages(
                    &file_path,
                    &normalized_session_id,
                    &normalized_workspace,
                )
                .await;
            }
            Ok(_) => continue,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!("Failed to inspect {}: {}", file_path.display(), error));
            }
        }
    }

    Err(format!(
        "Session file not found for {} under workspace {}",
        normalized_session_id, normalized_workspace
    ))
}

fn normalize_iflow_session_id(session_id: &str) -> Result<String, String> {
    let normalized_session_id = session_id.trim().trim_end_matches(".jsonl").to_string();
    if normalized_session_id.is_empty() {
        return Err("session_id cannot be empty".to_string());
    }
    if !normalized_session_id.starts_with("session-") {
        return Err("Invalid session_id format".to_string());
    }
    Ok(normalized_session_id)
}

#[tauri::command]
pub async fn delete_iflow_history_session(
    workspace_path: String,
    session_id: String,
) -> Result<bool, String> {
    let normalized_session_id = normalize_iflow_session_id(&session_id)?;
    let normalized_workspace = match tokio::fs::canonicalize(&workspace_path).await {
        Ok(path) => normalize_workspace_path(&path.to_string_lossy()),
        Err(_) => normalize_workspace_path(&workspace_path),
    };
    let candidate_dirs = iflow_project_dirs_for_workspace(&workspace_path, &normalized_workspace)?;

    for project_dir in candidate_dirs {
        let file_path = project_dir.join(format!("{}.jsonl", normalized_session_id));
        match tokio::fs::remove_file(&file_path).await {
            Ok(_) => return Ok(true),
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!("Failed to delete {}: {}", file_path.display(), error));
            }
        }
    }

    Ok(false)
}

#[tauri::command]
pub async fn clear_iflow_history_sessions(workspace_path: String) -> Result<usize, String> {
    let normalized_workspace = match tokio::fs::canonicalize(&workspace_path).await {
        Ok(path) => normalize_workspace_path(&path.to_string_lossy()),
        Err(_) => normalize_workspace_path(&workspace_path),
    };
    let candidate_dirs = iflow_project_dirs_for_workspace(&workspace_path, &normalized_workspace)?;

    let mut deleted_files = 0_usize;

    for project_dir in candidate_dirs {
        let mut reader = match tokio::fs::read_dir(&project_dir).await {
            Ok(reader) => reader,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to open iFlow project dir {}: {}",
                    project_dir.display(),
                    error
                ))
            }
        };

        while let Some(entry) = reader
            .next_entry()
            .await
            .map_err(|e| format!("Failed to read iFlow project entry: {}", e))?
        {
            let file_name = entry.file_name();
            let file_name = file_name.to_string_lossy();
            if !file_name.starts_with("session-") || !file_name.ends_with(".jsonl") {
                continue;
            }

            let path = entry.path();
            tokio::fs::remove_file(&path)
                .await
                .map_err(|e| format!("Failed to delete {}: {}", path.display(), e))?;
            deleted_files += 1;
        }
    }

    Ok(deleted_files)
}

async fn resolve_html_artifact_path_in_workspace(
    workspace_path: &str,
    file_path: &str,
) -> Result<PathBuf, String> {
    let workspace_root = tokio::fs::canonicalize(workspace_path).await.map_err(|e| {
        format!(
            "Failed to resolve workspace path {}: {}",
            workspace_path, e
        )
    })?;

    let requested_path = normalize_artifact_request_path(file_path);
    if requested_path.is_empty() {
        return Err("Artifact file path cannot be empty".to_string());
    }

    let requested = PathBuf::from(&requested_path);
    let is_absolute_request = requested.is_absolute();
    let target_path = if is_absolute_request {
        requested
    } else {
        workspace_root.join(requested)
    };

    let canonical_target = tokio::fs::canonicalize(&target_path).await.map_err(|e| {
        format!(
            "Failed to resolve artifact path {}: {}",
            target_path.display(),
            e
        )
    })?;

    if !is_absolute_request && !canonical_target.starts_with(&workspace_root) {
        return Err("Artifact path is outside workspace".to_string());
    }

    let extension = canonical_target
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_lowercase();
    if extension != "html" && extension != "htm" {
        return Err("Only .html/.htm artifacts are supported".to_string());
    }

    Ok(canonical_target)
}

fn is_windows_absolute_like(path: &str) -> bool {
    let bytes = path.as_bytes();
    if bytes.len() < 3 {
        return false;
    }
    bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

fn trim_artifact_path_wrappers(path: &str) -> String {
    path.trim()
        .trim_matches(|ch: char| {
            matches!(
                ch,
                '"' | '\''
                    | '`'
                    | '('
                    | ')'
                    | '['
                    | ']'
                    | '{'
                    | '}'
                    | '<'
                    | '>'
                    | ','
                    | '.'
                    | ';'
                    | ':'
                    | '!'
                    | '?'
                    | '，'
                    | '。'
                    | '；'
                    | '：'
                    | '！'
                    | '？'
                    | '、'
                    | '「'
                    | '」'
                    | '『'
                    | '』'
                    | '【'
                    | '】'
            )
        })
        .to_string()
}

fn strip_json_like_artifact_prefix(path: &str) -> String {
    let lowered = path.to_lowercase();
    for marker in ["file_path", "absolute_path", "path"] {
        if let Some(marker_pos) = lowered.find(marker) {
            let marker_end = marker_pos + marker.len();
            let rest = &path[marker_end..];
            if let Some(colon_pos) = rest.find(':') {
                let after_colon = &rest[colon_pos + 1..];
                return trim_artifact_path_wrappers(after_colon);
            }
        }
    }
    path.to_string()
}

fn normalize_artifact_request_path(file_path: &str) -> String {
    let trimmed = trim_artifact_path_wrappers(file_path);
    let without_file_prefix = trimmed.strip_prefix("file://").unwrap_or(&trimmed);
    let mut normalized = strip_json_like_artifact_prefix(without_file_prefix);
    normalized = trim_artifact_path_wrappers(&normalized);

    if let Some(rest) = normalized.strip_prefix('@') {
        if rest.starts_with('/')
            || rest.starts_with("./")
            || rest.starts_with("../")
            || rest.starts_with("~/")
            || is_windows_absolute_like(rest)
        {
            return rest.to_string();
        }
    }

    normalized
}

async fn validate_html_artifact_file(canonical_target: &Path) -> Result<(), String> {
    let metadata = tokio::fs::metadata(canonical_target).await.map_err(|e| {
        format!(
            "Failed to stat artifact {}: {}",
            canonical_target.display(),
            e
        )
    })?;
    if !metadata.is_file() {
        return Err("Artifact path is not a file".to_string());
    }
    if metadata.len() > MAX_HTML_ARTIFACT_SIZE {
        return Err(format!(
            "Artifact is too large (>{} bytes)",
            MAX_HTML_ARTIFACT_SIZE
        ));
    }
    Ok(())
}

/// 解析 HTML Artifact 的绝对路径（限制在当前 Agent 工作目录内）
#[tauri::command]
pub async fn resolve_html_artifact_path(
    state: State<'_, AppState>,
    agent_id: String,
    file_path: String,
) -> Result<String, String> {
    let workspace_path = state
        .agent_manager
        .workspace_path_of(&agent_id)
        .await
        .ok_or_else(|| format!("Agent {} not found", agent_id))?;
    let canonical_target =
        resolve_html_artifact_path_in_workspace(&workspace_path, &file_path).await?;
    validate_html_artifact_file(&canonical_target).await?;
    Ok(canonical_target.to_string_lossy().to_string())
}

/// 读取 HTML Artifact（限制在当前 Agent 工作目录内）
#[tauri::command]
pub async fn read_html_artifact(
    state: State<'_, AppState>,
    agent_id: String,
    file_path: String,
) -> Result<String, String> {
    let started_at = Instant::now();
    println!(
        "[read_html_artifact] start agent={} path={}",
        agent_id, file_path
    );

    let workspace_path = state
        .agent_manager
        .workspace_path_of(&agent_id)
        .await
        .ok_or_else(|| format!("Agent {} not found", agent_id))?;
    let canonical_target =
        resolve_html_artifact_path_in_workspace(&workspace_path, &file_path).await?;
    validate_html_artifact_file(&canonical_target).await?;

    let content = tokio::fs::read_to_string(&canonical_target)
        .await
        .map_err(|e| {
        format!(
            "Failed to read artifact {}: {}",
            canonical_target.display(),
            e
        )
    })?;

    println!(
        "[read_html_artifact] done agent={} path={} bytes={} elapsed={}ms",
        agent_id,
        canonical_target.display(),
        content.len(),
        started_at.elapsed().as_millis()
    );

    Ok(content)
}

/// 发送消息
#[tauri::command]
pub async fn send_message(
    state: State<'_, AppState>,
    agent_id: String,
    content: String,
    session_id: Option<String>,
) -> Result<(), String> {
    println!(
        "[send_message] Starting for agent {}: {}",
        agent_id, content
    );

    let (agent_count, agent_ids) = state.agent_manager.stats().await;
    println!(
        "[send_message] Got agent manager snapshot, total agents: {}",
        agent_count
    );
    println!("[send_message] Available agent IDs: {:?}", agent_ids);
    println!("[send_message] Looking for agent: {}", agent_id);

    let (agent_exists, sender) = state.agent_manager.sender_of(&agent_id).await;
    if !agent_exists {
        println!("[send_message] ERROR: Agent {} not found!", agent_id);
        return Err(format!("Agent {} not found", agent_id));
    }
    println!(
        "[send_message] Found agent! sender exists: {}",
        sender.is_some()
    );

    if let Some(sender) = sender {
        println!(
            "[send_message] Queueing user prompt to listener: {}",
            &content[..content.len().min(100)]
        );
        match sender.send(ListenerCommand::UserPrompt {
            content,
            session_id,
        }) {
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

/// 停止当前消息生成
#[tauri::command]
pub async fn stop_message(state: State<'_, AppState>, agent_id: String) -> Result<(), String> {
    let (agent_exists, sender) = state.agent_manager.sender_of(&agent_id).await;
    if !agent_exists {
        return Err(format!("Agent {} not found", agent_id));
    }

    if let Some(sender) = sender {
        sender
            .send(ListenerCommand::CancelPrompt)
            .map_err(|e| format!("Failed to queue cancel request: {}", e))?;
        Ok(())
    } else {
        Err("Message sender not available".to_string())
    }
}

/// 断开连接
#[tauri::command]
pub async fn disconnect_agent(state: State<'_, AppState>, agent_id: String) -> Result<(), String> {
    println!("Disconnecting agent: {}", agent_id);

    if let Some(mut instance) = state.agent_manager.remove(&agent_id).await {
        if let Some(mut process) = instance.process.take() {
            let _ = process.kill().await;
        }
        println!("Agent {} disconnected", agent_id);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::{
        build_bundle_entry_candidates, extract_bracket_block, parse_model_entries_from_array_block,
    };

    #[test]
    fn extract_model_block_from_bundle() {
        let bundle = "abc CAe=[{label:\"GLM-4.7\",value:\"glm-4.7\"}] xyz";
        let block = extract_bracket_block(bundle, "CAe=[").unwrap_or_default();
        assert_eq!(block, "[{label:\"GLM-4.7\",value:\"glm-4.7\"}]");
    }

    #[test]
    fn parse_model_entries_from_block() {
        let block =
            r#"[{label:"GLM-4.7",value:"glm-4.7"},{label:"Kimi-K2.5",value:"kimi-k2.5"}]"#;
        let entries = parse_model_entries_from_array_block(block);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].label, "GLM-4.7");
        assert_eq!(entries[0].value, "glm-4.7");
        assert_eq!(entries[1].label, "Kimi-K2.5");
        assert_eq!(entries[1].value, "kimi-k2.5");
    }

    #[test]
    fn build_bundle_candidates_prefers_iflow_js() {
        let candidates = build_bundle_entry_candidates(Path::new("/tmp/bundle/entry.js"));
        assert_eq!(candidates[0], Path::new("/tmp/bundle/iflow.js"));
        assert_eq!(candidates[1], Path::new("/tmp/bundle/entry.js"));
    }
}

//! iFlow 历史会话文件读取与解析

use std::collections::HashSet;
use std::env;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;

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

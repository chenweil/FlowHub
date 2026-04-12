//! Qwen 历史会话文件读取与解析

use std::collections::HashSet;
use std::env;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QwenHistorySession {
    pub session_id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    pub message_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QwenHistoryMessage {
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

fn is_same_or_ancestor(base: &str, path: &str) -> bool {
    if base == path {
        return true;
    }
    if base == "/" {
        return path.starts_with('/');
    }
    let prefix = format!("{}/", base);
    path.starts_with(&prefix)
}

fn workspace_path_matches(expected_workspace_path: &str, record_cwd: &str) -> bool {
    let expected = normalize_workspace_path(expected_workspace_path);
    let actual = normalize_workspace_path(record_cwd);
    is_same_or_ancestor(&expected, &actual) || is_same_or_ancestor(&actual, &expected)
}

fn workspace_to_qwen_project_key(workspace_path: &str) -> String {
    let normalized = normalize_workspace_path(workspace_path);
    let mut key = normalized.replace('/', "-").replace(':', "-");
    if !key.starts_with('-') {
        key = format!("-{}", key);
    }
    key
}

fn qwen_projects_root() -> Result<PathBuf, String> {
    let home_dir = env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .map_err(|e| format!("HOME/USERPROFILE is not set: {}", e))?;
    Ok(PathBuf::from(home_dir).join(".qwen").join("projects"))
}

fn qwen_chat_dirs_for_workspace(
    workspace_path: &str,
    normalized_workspace_path: &str,
) -> Result<Vec<PathBuf>, String> {
    let root = qwen_projects_root()?;
    let mut candidates = Vec::new();
    let mut seen = HashSet::new();

    for path in [workspace_path, normalized_workspace_path] {
        let key = workspace_to_qwen_project_key(path);
        if seen.insert(key.clone()) {
            candidates.push(root.join(key).join("chats"));
        }
    }

    Ok(candidates)
}

async fn list_all_qwen_chat_dirs() -> Result<Vec<PathBuf>, String> {
    let root = qwen_projects_root()?;
    let mut dirs = Vec::new();
    let mut reader = match tokio::fs::read_dir(&root).await {
        Ok(reader) => reader,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(dirs),
        Err(error) => {
            return Err(format!(
                "Failed to open Qwen projects root {}: {}",
                root.display(),
                error
            ));
        }
    };

    while let Some(entry) = reader
        .next_entry()
        .await
        .map_err(|e| format!("Failed to read Qwen projects root entry: {}", e))?
    {
        let project_dir = entry.path();
        let chat_dir = project_dir.join("chats");
        match tokio::fs::metadata(&chat_dir).await {
            Ok(metadata) if metadata.is_dir() => dirs.push(chat_dir),
            Ok(_) => continue,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(_) => continue,
        }
    }

    Ok(dirs)
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
        return "Qwen 会话".to_string();
    }
    let max_len = 28;
    if normalized.chars().count() <= max_len {
        return normalized;
    }
    format!("{}...", normalized.chars().take(max_len).collect::<String>())
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

fn extract_history_message_content(record: &Value, record_type: &str) -> Option<String> {
    if record_type != "user" && record_type != "assistant" {
        return None;
    }

    let parts = record.get("message")?.get("parts")?.as_array()?;
    let text_items = parts
        .iter()
        .filter(|item| !item.get("thought").and_then(Value::as_bool).unwrap_or(false))
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>();

    if text_items.is_empty() {
        None
    } else {
        Some(text_items.join("\n"))
    }
}

async fn parse_qwen_history_summary(
    file_path: &Path,
    session_id: &str,
    expected_workspace_path: &str,
) -> Result<Option<QwenHistorySession>, String> {
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
            if workspace_path_matches(expected_workspace_path, &cwd) {
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

    Ok(Some(QwenHistorySession {
        session_id: session_id.to_string(),
        title: compact_title(title.as_deref().unwrap_or(session_id)),
        created_at: created_at.unwrap_or_else(|| fallback_ts.clone()),
        updated_at: updated_at.unwrap_or(fallback_ts),
        message_count,
    }))
}

async fn parse_qwen_history_messages(
    file_path: &Path,
    session_id: &str,
    expected_workspace_path: &str,
) -> Result<Vec<QwenHistoryMessage>, String> {
    let raw = tokio::fs::read_to_string(file_path)
        .await
        .map_err(|e| format!("Failed to read {}: {}", file_path.display(), e))?;
    let metadata = tokio::fs::metadata(file_path).await.ok();
    let fallback_ts = to_rfc3339_or_now(metadata.and_then(|item| item.modified().ok()));

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
            if workspace_path_matches(expected_workspace_path, &cwd) {
                workspace_matches = true;
            }
        }

        let Some(content) = extract_history_message_content(&record, record_type) else {
            continue;
        };

        let timestamp = extract_history_timestamp(&record).unwrap_or_else(|| fallback_ts.clone());
        let id = record
            .get("uuid")
            .and_then(Value::as_str)
            .map(|item| item.to_string())
            .unwrap_or_else(|| format!("{}-{}", session_id, index));

        messages.push(QwenHistoryMessage {
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

fn normalize_qwen_session_id(session_id: &str) -> Result<String, String> {
    let normalized = session_id.trim().trim_end_matches(".jsonl").to_string();
    if normalized.is_empty() {
        return Err("session_id cannot be empty".to_string());
    }
    Ok(normalized)
}

#[tauri::command]
pub async fn list_qwen_history_sessions(
    workspace_path: String,
) -> Result<Vec<QwenHistorySession>, String> {
    let normalized_workspace = match tokio::fs::canonicalize(&workspace_path).await {
        Ok(path) => normalize_workspace_path(&path.to_string_lossy()),
        Err(_) => normalize_workspace_path(&workspace_path),
    };
    let candidate_dirs = qwen_chat_dirs_for_workspace(&workspace_path, &normalized_workspace)?;

    let mut seen_sessions = HashSet::new();
    let mut sessions = Vec::new();

    for chat_dir in candidate_dirs {
        let mut reader = match tokio::fs::read_dir(&chat_dir).await {
            Ok(reader) => reader,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to open Qwen chat dir {}: {}",
                    chat_dir.display(),
                    error
                ));
            }
        };

        while let Some(entry) = reader
            .next_entry()
            .await
            .map_err(|e| format!("Failed to read Qwen chat entry: {}", e))?
        {
            let path = entry.path();
            let file_name = entry.file_name();
            let file_name = file_name.to_string_lossy();
            if !file_name.ends_with(".jsonl") {
                continue;
            }

            let session_id = file_name.trim_end_matches(".jsonl").to_string();
            if !seen_sessions.insert(session_id.clone()) {
                continue;
            }
            if let Ok(Some(summary)) =
                parse_qwen_history_summary(&path, &session_id, &normalized_workspace).await
            {
                sessions.push(summary);
            }
        }
    }

    if sessions.is_empty() {
        let fallback_dirs = list_all_qwen_chat_dirs().await?;
        for chat_dir in fallback_dirs {
            let mut reader = match tokio::fs::read_dir(&chat_dir).await {
                Ok(reader) => reader,
                Err(error) if error.kind() == ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(format!(
                        "Failed to open Qwen chat dir {}: {}",
                        chat_dir.display(),
                        error
                    ));
                }
            };

            while let Some(entry) = reader
                .next_entry()
                .await
                .map_err(|e| format!("Failed to read Qwen chat entry: {}", e))?
            {
                let path = entry.path();
                let file_name = entry.file_name();
                let file_name = file_name.to_string_lossy();
                if !file_name.ends_with(".jsonl") {
                    continue;
                }

                let session_id = file_name.trim_end_matches(".jsonl").to_string();
                if !seen_sessions.insert(session_id.clone()) {
                    continue;
                }
                if let Ok(Some(summary)) =
                    parse_qwen_history_summary(&path, &session_id, &normalized_workspace).await
                {
                    sessions.push(summary);
                }
            }
        }
    }

    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(sessions)
}

#[tauri::command]
pub async fn load_qwen_history_messages(
    workspace_path: String,
    session_id: String,
) -> Result<Vec<QwenHistoryMessage>, String> {
    let normalized_session_id = normalize_qwen_session_id(&session_id)?;
    let normalized_workspace = match tokio::fs::canonicalize(&workspace_path).await {
        Ok(path) => normalize_workspace_path(&path.to_string_lossy()),
        Err(_) => normalize_workspace_path(&workspace_path),
    };
    let candidate_dirs = qwen_chat_dirs_for_workspace(&workspace_path, &normalized_workspace)?;

    for chat_dir in candidate_dirs {
        let file_path = chat_dir.join(format!("{}.jsonl", normalized_session_id));
        match tokio::fs::metadata(&file_path).await {
            Ok(metadata) if metadata.is_file() => {
                return parse_qwen_history_messages(
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

    let fallback_dirs = list_all_qwen_chat_dirs().await?;
    for chat_dir in fallback_dirs {
        let file_path = chat_dir.join(format!("{}.jsonl", normalized_session_id));
        match tokio::fs::metadata(&file_path).await {
            Ok(metadata) if metadata.is_file() => {
                return parse_qwen_history_messages(
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
pub async fn delete_qwen_history_session(
    workspace_path: String,
    session_id: String,
) -> Result<bool, String> {
    let normalized_session_id = normalize_qwen_session_id(&session_id)?;
    let normalized_workspace = match tokio::fs::canonicalize(&workspace_path).await {
        Ok(path) => normalize_workspace_path(&path.to_string_lossy()),
        Err(_) => normalize_workspace_path(&workspace_path),
    };
    let candidate_dirs = qwen_chat_dirs_for_workspace(&workspace_path, &normalized_workspace)?;

    for chat_dir in candidate_dirs {
        let file_path = chat_dir.join(format!("{}.jsonl", normalized_session_id));
        match tokio::fs::remove_file(&file_path).await {
            Ok(_) => return Ok(true),
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!("Failed to delete {}: {}", file_path.display(), error));
            }
        }
    }

    let fallback_dirs = list_all_qwen_chat_dirs().await?;
    for chat_dir in fallback_dirs {
        let file_path = chat_dir.join(format!("{}.jsonl", normalized_session_id));
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
pub async fn clear_qwen_history_sessions(workspace_path: String) -> Result<usize, String> {
    let normalized_workspace = match tokio::fs::canonicalize(&workspace_path).await {
        Ok(path) => normalize_workspace_path(&path.to_string_lossy()),
        Err(_) => normalize_workspace_path(&workspace_path),
    };
    let candidate_dirs = qwen_chat_dirs_for_workspace(&workspace_path, &normalized_workspace)?;
    let mut deleted_files = 0_usize;

    for chat_dir in candidate_dirs {
        let mut reader = match tokio::fs::read_dir(&chat_dir).await {
            Ok(reader) => reader,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(format!(
                    "Failed to open Qwen chat dir {}: {}",
                    chat_dir.display(),
                    error
                ));
            }
        };

        while let Some(entry) = reader
            .next_entry()
            .await
            .map_err(|e| format!("Failed to read Qwen chat entry: {}", e))?
        {
            let file_name = entry.file_name();
            let file_name = file_name.to_string_lossy();
            if !file_name.ends_with(".jsonl") {
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

#[cfg(test)]
mod tests {
    use super::{compact_title, normalize_qwen_session_id, workspace_path_matches};

    #[test]
    fn normalize_qwen_session_id_accepts_uuid_jsonl() {
        assert_eq!(
            normalize_qwen_session_id("464a05db-d441-44fb-a696-f920a0e49ae4.jsonl").unwrap(),
            "464a05db-d441-44fb-a696-f920a0e49ae4"
        );
    }

    #[test]
    fn compact_title_falls_back_to_qwen_session() {
        assert_eq!(compact_title("   "), "Qwen 会话");
    }

    #[test]
    fn workspace_match_supports_exact_and_parent_child() {
        assert!(workspace_path_matches(
            "/Users/chenweilong/playground/iflow/iflow-workspace",
            "/Users/chenweilong/playground/iflow/iflow-workspace"
        ));
        assert!(workspace_path_matches(
            "/Users/chenweilong/playground",
            "/Users/chenweilong/playground/iflow/iflow-workspace"
        ));
        assert!(workspace_path_matches(
            "/Users/chenweilong/playground/iflow/iflow-workspace",
            "/Users/chenweilong/playground"
        ));
        assert!(!workspace_path_matches(
            "/Users/chenweilong/playground",
            "/Users/chenweilong/Downloads"
        ));
    }
}

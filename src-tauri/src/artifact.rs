//! HTML Artifact 路径解析与安全读取
use std::path::{Path, PathBuf};
use std::time::Instant;

use tauri::State;

use crate::state::AppState;

const MAX_HTML_ARTIFACT_SIZE: u64 = 2 * 1024 * 1024;

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

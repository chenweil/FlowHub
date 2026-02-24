use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{Manager, State};
use tokio::fs;

use crate::state::AppState;

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    pub id: String,
    pub agent_id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    pub id: String,
    pub role: String,
    pub content: String,
    pub timestamp: String,
    pub agent_id: Option<String>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StorageSnapshot {
    #[serde(default)]
    pub sessions_by_agent: HashMap<String, Vec<StoredSession>>,
    #[serde(default)]
    pub messages_by_session: HashMap<String, Vec<StoredMessage>>,
}

fn storage_env_tag() -> &'static str {
    if cfg!(test) {
        "test"
    } else if cfg!(debug_assertions) {
        "dev"
    } else {
        "prod"
    }
}

fn storage_file_name() -> String {
    format!("iflow-session-store-{}.json", storage_env_tag())
}

fn storage_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;
    Ok(base_dir.join(storage_file_name()))
}

pub async fn read_snapshot_from_path(path: &Path) -> Result<StorageSnapshot, String> {
    match fs::read_to_string(path).await {
        Ok(content) => {
            if content.trim().is_empty() {
                return Ok(StorageSnapshot::default());
            }
            serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse session store: {}", e))
        }
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(StorageSnapshot::default()),
        Err(err) => Err(format!("Failed to read session store: {}", err)),
    }
}

pub async fn write_snapshot_to_path(path: &Path, snapshot: &StorageSnapshot) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create session store dir: {}", e))?;
    }
    let payload = serde_json::to_vec(snapshot)
        .map_err(|e| format!("Failed to encode session store: {}", e))?;
    fs::write(path, payload)
        .await
        .map_err(|e| format!("Failed to write session store: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn load_storage_snapshot(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<StorageSnapshot, String> {
    let _guard = state.storage_lock.lock().await;
    let path = storage_path(&app_handle)?;
    read_snapshot_from_path(&path).await
}

#[tauri::command]
pub async fn save_storage_snapshot(
    app_handle: tauri::AppHandle,
    state: State<'_, AppState>,
    snapshot: StorageSnapshot,
) -> Result<(), String> {
    let _guard = state.storage_lock.lock().await;
    let path = storage_path(&app_handle)?;
    write_snapshot_to_path(&path, &snapshot).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn temp_path(file_name: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!("iflow-store-{}", Uuid::new_v4()))
            .join(file_name)
    }

    #[tokio::test]
    async fn read_missing_snapshot_returns_default() {
        let path = temp_path("missing.json");
        let snapshot = read_snapshot_from_path(&path).await.unwrap();
        assert!(snapshot.sessions_by_agent.is_empty());
        assert!(snapshot.messages_by_session.is_empty());
    }

    #[tokio::test]
    async fn snapshot_roundtrip_persists_data() {
        let path = temp_path("roundtrip.json");
        let mut snapshot = StorageSnapshot::default();
        snapshot.sessions_by_agent.insert(
            "agent-a".to_string(),
            vec![StoredSession {
                id: "session-1".to_string(),
                agent_id: "agent-a".to_string(),
                title: "Session One".to_string(),
                created_at: "2024-01-01T00:00:00.000Z".to_string(),
                updated_at: "2024-01-01T00:10:00.000Z".to_string(),
            }],
        );
        snapshot.messages_by_session.insert(
            "session-1".to_string(),
            vec![StoredMessage {
                id: "msg-1".to_string(),
                role: "user".to_string(),
                content: "Hello".to_string(),
                timestamp: "2024-01-01T00:00:00.000Z".to_string(),
                agent_id: Some("agent-a".to_string()),
            }],
        );

        write_snapshot_to_path(&path, &snapshot).await.unwrap();
        let loaded = read_snapshot_from_path(&path).await.unwrap();
        assert_eq!(snapshot, loaded);
    }
}

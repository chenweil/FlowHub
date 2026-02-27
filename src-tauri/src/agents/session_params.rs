//! ACP JSON-RPC session 请求参数构建
use serde_json::{json, Value};

pub(super) fn build_initialize_params() -> Value {
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

pub(super) fn build_session_new_params(workspace_path: &str) -> Value {
    json!({
        "cwd": workspace_path,
        "mcpServers": [],
        "settings": {
            "permission_mode": "yolo",
        }
    })
}

pub(super) fn build_session_new_params_with_id(workspace_path: &str, session_id: &str) -> Value {
    json!({
        "cwd": workspace_path,
        "sessionId": session_id,
        "mcpServers": [],
        "settings": {
            "permission_mode": "yolo",
        }
    })
}

pub(super) fn build_session_load_params(workspace_path: &str, session_id: &str) -> Value {
    json!({
        "cwd": workspace_path,
        "sessionId": session_id,
        "mcpServers": [],
        "settings": {
            "permission_mode": "yolo",
        }
    })
}

pub(super) fn build_prompt_params(session_id: &str, prompt: &str) -> Value {
    json!({
        "sessionId": session_id,
        "prompt": [{
            "type": "text",
            "text": prompt,
        }],
    })
}

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc::UnboundedSender;
use tokio::sync::oneshot;

// Agent 状态
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    pub agent_type: String,
    pub status: AgentStatus,
    pub workspace_path: String,
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
#[allow(dead_code)]
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
pub(crate) struct PlanEntry {
    pub(crate) content: String,
    pub(crate) status: String,
}

#[derive(Debug)]
pub(crate) enum ListenerCommand {
    UserPrompt {
        content: String,
        session_id: Option<String>,
    },
    CancelPrompt,
    SetModel {
        model: String,
        response: oneshot::Sender<Result<String, String>>,
    },
    SetThink {
        enable: bool,
        config: String,
        response: oneshot::Sender<Result<bool, String>>,
    },
}

pub(crate) type MessageSender = UnboundedSender<ListenerCommand>;

// 连接响应
#[derive(Serialize)]
pub struct ConnectResponse {
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRuntimeItem {
    pub agent_type: String,
    pub skill_name: String,
    pub title: String,
    pub description: String,
    pub path: String,
    pub source: String,
    pub discovered_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileItem {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified_at: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::ConnectResponse;
    use serde_json::json;

    #[test]
    fn connect_response_serializes_without_port() {
        let payload = serde_json::to_value(ConnectResponse {
            success: true,
            error: None,
        })
        .expect("serialize connect response");

        assert_eq!(
            payload,
            json!({
                "success": true,
                "error": null
            })
        );
    }
}

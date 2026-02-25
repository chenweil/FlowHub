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
    UserPrompt(String),
    CancelPrompt,
    SetModel {
        model: String,
        response: oneshot::Sender<Result<String, String>>,
    },
}

pub(crate) type MessageSender = UnboundedSender<ListenerCommand>;

// 连接响应
#[derive(Serialize)]
pub struct ConnectResponse {
    pub success: bool,
    pub port: u16,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ModelOption {
    pub label: String,
    pub value: String,
}

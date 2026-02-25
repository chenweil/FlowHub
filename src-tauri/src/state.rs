use tokio::process::Child;
use tokio::sync::Mutex;

use crate::manager::AgentManager;
use crate::models::{AgentInfo, MessageSender};

// Agent 实例
#[allow(dead_code)]
pub struct AgentInstance {
    pub info: AgentInfo,
    pub process: Option<Child>,
    pub port: u16,
    pub iflow_path: String,
    pub model: Option<String>,
    pub(crate) message_sender: Option<MessageSender>,
}

// 应用状态
pub struct AppState {
    pub agent_manager: AgentManager,
    pub storage_lock: Mutex<()>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            agent_manager: AgentManager::default(),
            storage_lock: Mutex::new(()),
        }
    }
}

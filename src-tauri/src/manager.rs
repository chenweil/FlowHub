use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::RwLock;

use crate::models::MessageSender;
use crate::state::AgentInstance;

#[derive(Clone)]
pub struct AgentManager {
    agents: Arc<RwLock<HashMap<String, AgentInstance>>>,
}

impl Default for AgentManager {
    fn default() -> Self {
        Self {
            agents: Arc::new(RwLock::new(HashMap::new())),
        }
    }
}

impl AgentManager {
    pub async fn upsert(&self, agent_id: String, instance: AgentInstance) {
        let mut agents = self.agents.write().await;
        agents.insert(agent_id, instance);
    }

    pub async fn stats(&self) -> (usize, Vec<String>) {
        let agents = self.agents.read().await;
        let ids = agents.keys().cloned().collect::<Vec<_>>();
        (agents.len(), ids)
    }

    pub async fn sender_of(&self, agent_id: &str) -> (bool, Option<MessageSender>) {
        let agents = self.agents.read().await;
        if let Some(instance) = agents.get(agent_id) {
            (true, instance.message_sender.clone())
        } else {
            (false, None)
        }
    }

    pub async fn remove(&self, agent_id: &str) -> Option<AgentInstance> {
        let mut agents = self.agents.write().await;
        agents.remove(agent_id)
    }
}

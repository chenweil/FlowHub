// src/features/agents/state.ts — agent-related state fragments from global store
import type { Agent, ThinkSupportStatus } from '../../types';
import { state as globalState } from '../../store';

// Re-export think support helpers that interact with state
export function getThinkSupportByModel(modelName: string | undefined): ThinkSupportStatus {
  const key = normalizeThinkModelKey(modelName);
  if (!key) {
    return 'unknown';
  }
  return globalState.thinkSupportByModel[key] || 'unknown';
}

export function setThinkSupportByModel(modelName: string | undefined, status: ThinkSupportStatus): void {
  const key = normalizeThinkModelKey(modelName);
  if (!key) {
    return;
  }
  globalState.thinkSupportByModel[key] = status;
}

function normalizeThinkModelKey(modelName: string | undefined): string | null {
  if (typeof modelName !== 'string') {
    return null;
  }
  const normalized = modelName.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

// Current agent query
export function getCurrentAgent(): Agent | null {
  if (!globalState.currentAgentId) return null;
  return globalState.agents.find((a) => a.id === globalState.currentAgentId) || null;
}

export function isCurrentAgentBusy(): boolean {
  const currentAgent = getCurrentAgent();
  return Boolean(currentAgent && globalState.inflightSessionByAgent[currentAgent.id]);
}

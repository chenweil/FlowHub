// src/features/agents/reconnect.ts — auto-reconnect logic for saved agents
import { connectIflow } from '../../services/tauri';
import type { Agent } from '../../types';
import { state } from '../../store';
import { readLastConnectedAgentId, markLastConnectedAgent, normalizeConnectionErrorMessage } from './utils';

export type AutoReconnectMode = 'all' | 'last' | 'off';
const AUTO_RECONNECT_MODE_STORAGE_KEY = 'iflow-auto-reconnect-mode';
export const AUTO_RECONNECT_MODE_DEFAULT: AutoReconnectMode = 'last';

export function normalizeAutoReconnectMode(rawValue: string | null | undefined): AutoReconnectMode {
  const normalized = String(rawValue || '').trim().toLowerCase();
  if (normalized === 'all' || normalized === 'last' || normalized === 'off') {
    return normalized;
  }
  return AUTO_RECONNECT_MODE_DEFAULT;
}

export function getAutoReconnectMode(): AutoReconnectMode {
  try {
    return normalizeAutoReconnectMode(localStorage.getItem(AUTO_RECONNECT_MODE_STORAGE_KEY));
  } catch (error) {
    console.error('Read auto reconnect mode failed:', error);
    return AUTO_RECONNECT_MODE_DEFAULT;
  }
}

export function setAutoReconnectMode(mode: AutoReconnectMode): void {
  try {
    localStorage.setItem(AUTO_RECONNECT_MODE_STORAGE_KEY, mode);
  } catch (error) {
    console.error('Save auto reconnect mode failed:', error);
  }
}

export interface ReconnectAgentOptions {
  silent?: boolean;
  updateStatus?: boolean;
  skipModelCache?: boolean;
}

export async function reconnectAgent(agentId: string): Promise<{ success: boolean; error?: string }> {
  return reconnectAgentWithOptions(agentId, { silent: false, updateStatus: true });
}

async function reconnectAgentWithOptions(
  agentId: string,
  options: ReconnectAgentOptions
): Promise<{ success: boolean; error?: string }> {
  const { silent = false, updateStatus = true, skipModelCache = false } = options;
  const agent = state.agents.find((a) => a.id === agentId);
  if (!agent) {
    return { success: false, error: 'Agent not found' };
  }

  if (agent.status === 'connecting' || agent.status === 'connected') {
    return { success: true };
  }

  const { renderAgentList } = await import('./actions');
  const { updateAgentStatusUI, updateConnectionStatus } = await import('./ui');
  const previousStatus = agent.status;
  let connectionError: string | undefined;
  if (updateStatus) {
    agent.status = 'connecting';
    updateAgentStatusUI(agent.status);
    if (!silent) renderAgentList();
  }

  try {
    const result = await connectIflow(agent.id, agent.iflowPath || 'iflow', agent.workspacePath, agent.selectedModel || null);

    agent.port = result.port;
    agent.status = 'connected';

    updateAgentStatusUI('connected');
    updateConnectionStatus(true);
    markLastConnectedAgent(agentId);

    if (!skipModelCache) {
      const { loadAgentModelOptions } = await import('./model');
      void loadAgentModelOptions(agent, true);
    }

    if (!silent) renderAgentList();
    return { success: true };
  } catch (error) {
    agent.status = previousStatus;
    connectionError = normalizeConnectionErrorMessage(error);

    if (!silent) {
      updateAgentStatusUI(agent.status);
      updateConnectionStatus(false);
      renderAgentList();
      const { showError } = await import('./utils');
      showError(`连接失败: ${connectionError}`);
    }

    return { success: false, error: connectionError };
  }
}

export async function autoReconnectSavedAgents(): Promise<void> {
  const mode = getAutoReconnectMode();
  if (mode === 'off') return;

  const agentsToConnect: Agent[] = [];

  if (mode === 'all') {
    agentsToConnect.push(...state.agents);
  } else if (mode === 'last') {
    const lastAgentId = readLastConnectedAgentId();
    const lastAgent = lastAgentId ? state.agents.find((a) => a.id === lastAgentId) : null;
    if (lastAgent) {
      agentsToConnect.push(lastAgent);
    } else if (state.agents.length > 0) {
      agentsToConnect.push(state.agents[0]);
    }
  }

  const results = await Promise.allSettled(
    agentsToConnect.map(async (agent) => {
      if (agent.status === 'disconnected' || agent.status === 'error') {
        await reconnectAgentWithOptions(agent.id, { silent: true, updateStatus: false, skipModelCache: true });
      }
    })
  );

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error(`Auto-reconnect failed for agent ${agentsToConnect[index]?.id}:`, result.reason);
    }
  });

  const { updateConnectionStatus } = await import('./ui');
  const connectedCount = agentsToConnect.filter(
    (a) => a.status === 'connected'
  ).length;
  if (connectedCount > 0) {
    updateConnectionStatus(true);
  }
}

export function parseAgentAutoReconnectCommand(content: string): { kind: 'show' | 'set' | 'invalid'; mode?: AutoReconnectMode } | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('/agents')) {
    return null;
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length < 2 || parts[1].toLowerCase() !== 'autoreconnect') {
    return null;
  }

  if (parts.length === 2) {
    return { kind: 'show' };
  }

  const mode = normalizeAutoReconnectMode(parts[2]);
  const rawMode = parts[2].trim().toLowerCase();
  if (mode !== rawMode) {
    return { kind: 'invalid' };
  }
  return { kind: 'set', mode };
}

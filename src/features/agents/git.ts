// src/features/agents/git.ts — Git changes management for agents
import { listGitChanges } from '../../services/tauri';
import type { GitFileChange } from '../../types';
import { state } from '../../store';
import { gitChangesPanelEl } from '../../dom';

export function showGitChangesForAgent(agentId: string, forceOpen = false): void {
  if (agentId !== state.currentAgentId) {
    return;
  }
  const changes = state.gitChangesByAgent[agentId] || [];
  const loading = Boolean(state.gitChangesLoadingByAgent[agentId]);
  const error = state.gitChangesErrorByAgent[agentId] || '';
  const lastRefreshedAt = state.gitChangesLastRefreshedAtByAgent[agentId];
  const disableRefresh = Boolean(state.inflightSessionByAgent[agentId]);

  void import('../ui').then(({ showGitChanges }) => {
    showGitChanges(changes, { loading, error, lastRefreshedAt, disableRefresh, forceOpen });
  });
}

export function resetGitChangesForAgent(agentId: string): void {
  delete state.gitChangesByAgent[agentId];
  delete state.gitChangesLoadingByAgent[agentId];
  delete state.gitChangesErrorByAgent[agentId];
  delete state.gitChangesLastRefreshedAtByAgent[agentId];
  if (agentId === state.currentAgentId) {
    gitChangesPanelEl.classList.add('hidden');
  }
}

export async function refreshAgentGitChanges(agentId: string): Promise<void> {
  const agent = state.agents.find((item) => item.id === agentId);
  if (!agent) {
    console.warn(`refreshAgentGitChanges: agent not found (${agentId})`);
    return;
  }

  state.gitChangesLoadingByAgent[agentId] = true;
  state.gitChangesErrorByAgent[agentId] = '';
  showGitChangesForAgent(agentId);

  try {
    const changes = await listGitChanges(agent.workspacePath);
    const normalized: GitFileChange[] = Array.isArray(changes) ? changes : [];
    state.gitChangesByAgent[agentId] = normalized;
    state.gitChangesErrorByAgent[agentId] = '';
  } catch (error) {
    state.gitChangesByAgent[agentId] = [];
    state.gitChangesErrorByAgent[agentId] = String(error);
  } finally {
    state.gitChangesLoadingByAgent[agentId] = false;
    state.gitChangesLastRefreshedAtByAgent[agentId] = Date.now();
    showGitChangesForAgent(agentId);
  }
}

export async function refreshCurrentAgentGitChanges(): Promise<void> {
  if (!state.currentAgentId) {
    return;
  }
  await refreshAgentGitChanges(state.currentAgentId);
}

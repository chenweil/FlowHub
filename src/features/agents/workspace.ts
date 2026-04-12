// src/features/agents/workspace.ts — Workspace files management for agents
import { listWorkspaceFiles } from '../../services/tauri';
import type { FileItem } from '../../types';
import { state } from '../../store';
import { workspaceFilesPanelEl, messageInputEl } from '../../dom';

export function showWorkspaceFilesForAgent(agentId: string, forceOpen = false): void {
  if (agentId !== state.currentAgentId) {
    return;
  }
  const files = state.workspaceFilesByAgent[agentId] || [];
  const loading = Boolean(state.workspaceFilesLoadingByAgent[agentId]);
  const error = state.workspaceFilesErrorByAgent[agentId] || '';
  const lastRefreshedAt = state.workspaceFilesLastRefreshedAtByAgent[agentId];
  const disableRefresh = Boolean(state.inflightSessionByAgent[agentId]);

  void import('../ui').then(({ showWorkspaceFiles }) => {
    showWorkspaceFiles(files, { loading, error, lastRefreshedAt, disableRefresh, forceOpen });
  });
}

export function resetWorkspaceFilesForAgent(agentId: string): void {
  delete state.workspaceFilesByAgent[agentId];
  delete state.workspaceFilesLoadingByAgent[agentId];
  delete state.workspaceFilesErrorByAgent[agentId];
  delete state.workspaceFilesLastRefreshedAtByAgent[agentId];
  if (agentId === state.currentAgentId) {
    workspaceFilesPanelEl.classList.add('hidden');
  }
}

export async function refreshAgentWorkspaceFiles(agentId: string): Promise<void> {
  const agent = state.agents.find((item) => item.id === agentId);
  if (!agent) {
    console.warn(`refreshAgentWorkspaceFiles: agent not found (${agentId})`);
    return;
  }

  state.workspaceFilesLoadingByAgent[agentId] = true;
  state.workspaceFilesErrorByAgent[agentId] = '';
  showWorkspaceFilesForAgent(agentId);

  try {
    const files = await listWorkspaceFiles(agent.workspacePath);
    const normalized: FileItem[] = Array.isArray(files) ? files : [];
    state.workspaceFilesByAgent[agentId] = normalized;
    state.workspaceFilesErrorByAgent[agentId] = '';
  } catch (error) {
    state.workspaceFilesByAgent[agentId] = [];
    state.workspaceFilesErrorByAgent[agentId] = String(error);
  } finally {
    state.workspaceFilesLoadingByAgent[agentId] = false;
    state.workspaceFilesLastRefreshedAtByAgent[agentId] = Date.now();
    showWorkspaceFilesForAgent(agentId);
  }
}

export async function refreshCurrentAgentWorkspaceFiles(): Promise<void> {
  if (!state.currentAgentId) {
    return;
  }
  await refreshAgentWorkspaceFiles(state.currentAgentId);
}

// Insert @filepath at cursor position in message input
export function insertFilePathAtCursor(filePath: string): void {
  const input = messageInputEl;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? input.value.length;
  const textBefore = input.value.substring(0, start);
  const textAfter = input.value.substring(end);

  // Insert @filepath with a space before it if there's content
  const prefix = textBefore.length > 0 && !textBefore.endsWith(' ') ? ' @' : '@';
  const insertText = `${prefix}${filePath}`;

  input.value = textBefore + insertText + textAfter;
  input.focus();

  // Move cursor after the inserted text
  const newPos = start + insertText.length;
  input.setSelectionRange(newPos, newPos);

  // Trigger input event to update any listeners
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

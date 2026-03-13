// src/features/agents/actions.ts — Agent CRUD operations
import { connectIflow, disconnectAgent } from '../../services/tauri';
import { shortAgentId, getWorkspaceName } from '../../lib/utils';
import { escapeHtml } from '../../lib/html';
import { showConfirmDialog } from '../../dom';
import type { Agent } from '../../types';
import { state } from '../../store';
import {
  agentListEl,
  currentAgentNameEl,
  clearChatBtnEl,
  toolCallsPanelEl,
  gitChangesPanelEl,
  renameAgentNameInputEl,
  renameAgentModalEl,
} from '../../dom';
import { AGENTS_STORAGE_KEY, saveSessions, saveSessionMessages } from '../storage';
import {
  renderSessionList,
  ensureAgentHasSessions,
  getSessionsForAgent,
  selectSession,
} from '../sessions';
import { normalizeConnectionErrorMessage, markLastConnectedAgent, removeLastConnectedAgentIfMatches, showLoading, hideLoading, showSuccess, showError } from './utils';
import { updateAgentStatusUI, updateConnectionStatus, updateCurrentAgentModelUI, updateCurrentAgentThinkUI, closeCurrentAgentModelMenu } from './ui';
import { refreshAgentGitChanges, resetGitChangesForAgent } from './git';
import { loadAgentModelOptions } from './model';

// ── Add Agent ─────────────────────────────────────────────────────────────────

export async function addAgent(name: string, iflowPath: string, workspacePath: string) {
  try {
    showLoading('正在连接 iFlow...');

    const agentId = `iflow-${Date.now()}`;
    const result = await connectIflow(agentId, iflowPath, workspacePath, null);

    if (!result.success) {
      showError(result.error || '连接失败');
      return;
    }

    const agent: Agent = {
      id: agentId,
      name,
      type: 'iflow',
      status: 'connected',
      workspacePath,
      iflowPath,
      thinkEnabled: false,
      port: result.port,
    };

    state.agents.push(agent);
    markLastConnectedAgent(agentId);
    ensureAgentHasSessions(agentId);

    await saveAgents();
    await saveSessions();
    await saveSessionMessages();

    renderAgentList();
    selectAgent(agentId);
    showSuccess('iFlow 连接成功！');
  } catch (error) {
    console.error('Connection error:', error);
    showError(`连接错误: ${normalizeConnectionErrorMessage(error)}`);
  } finally {
    hideLoading();
  }
}

// ── Select Agent ──────────────────────────────────────────────────────────────

export function selectAgent(agentId: string) {
  closeCurrentAgentModelMenu();

  if (state.currentAgentId && state.currentAgentId !== agentId) {
    void import('../ui').then(({ closeArtifactPreviewModal, closeGitDiffModal }) => {
      closeArtifactPreviewModal();
      closeGitDiffModal();
    });
  }

  state.currentAgentId = agentId;
  const agent = state.agents.find((a) => a.id === agentId);
  if (!agent) {
    updateCurrentAgentModelUI();
    updateCurrentAgentThinkUI();
    return;
  }

  currentAgentNameEl.textContent = agent.name;
  updateAgentStatusUI(agent.status);

  const isConnected = agent.status === 'connected';
  clearChatBtnEl.textContent = '清空当前会话';

  ensureAgentHasSessions(agentId);

  const sessionList = getSessionsForAgent(agentId);
  if (sessionList.length > 0) {
    selectSession(sessionList[0].id);
  } else {
    state.currentSessionId = null;
    state.messages = [];
    void import('../ui').then(({ renderMessages }) => {
      renderMessages();
    });
    renderSessionList();
  }

  renderAgentList();

  updateCurrentAgentModelUI();
  updateCurrentAgentThinkUI();
  updateConnectionStatus(isConnected);

  const existingToolCalls = state.toolCallsByAgent[agentId] || [];
  if (existingToolCalls.length > 0) {
    void import('../ui').then(({ showToolCalls }) => {
      showToolCalls(existingToolCalls);
    });
  } else {
    toolCallsPanelEl.classList.add('hidden');
  }

  void import('../app').then(({ refreshComposerState }) => {
    refreshComposerState();
  });

  void refreshAgentGitChanges(agent.id);

  if (isConnected) {
    void import('../sessions').then(({ syncIflowHistorySessions }) => {
      syncIflowHistorySessions(agent);
    });
    void loadAgentModelOptions(agent).then(() => {
      if (state.currentAgentId === agent.id) {
        updateCurrentAgentModelUI();
      }
    });
  }
}

// ── Delete Agent ──────────────────────────────────────────────────────────────

export async function deleteAgent(agentId: string) {
  const agent = state.agents.find((a) => a.id === agentId);
  if (!agent) {
    showError('未找到对应 Agent，删除失败');
    return;
  }

  const confirmed = await showConfirmDialog(
    '删除 Agent',
    `确定要删除 Agent "${agent.name}" 吗？此操作不可撤销。`
  );
  if (!confirmed) {
    return;
  }

  const deletingCurrentAgent = state.currentAgentId === agentId;

  if (agent.status === 'connected') {
    void disconnectAgent(agentId).catch((e) => {
      console.error('断开连接失败:', e);
    });
  }

  state.agents = state.agents.filter((a) => a.id !== agentId);
  removeLastConnectedAgentIfMatches(agentId);

  if (state.modelSwitchingAgentId === agentId) {
    state.modelSwitchingAgentId = null;
  }
  delete state.inflightSessionByAgent[agentId];
  delete state.registryByAgent[agentId];
  delete state.toolCallsByAgent[agentId];
  delete state.modelOptionsCacheByAgent[agentId];

  resetGitChangesForAgent(agentId);

  const removedSessions = state.sessionsByAgent[agentId] || [];
  delete state.sessionsByAgent[agentId];
  for (const session of removedSessions) {
    delete state.messagesBySession[session.id];
  }

  if (deletingCurrentAgent) {
    closeCurrentAgentModelMenu();
    state.currentAgentId = null;
    state.currentSessionId = null;
    state.messages = [];
    toolCallsPanelEl.classList.add('hidden');
    gitChangesPanelEl.classList.add('hidden');
    currentAgentNameEl.textContent = '选择一个 Agent';
    updateAgentStatusUI('disconnected');
    updateCurrentAgentModelUI();
    updateConnectionStatus(false);
  }

  await saveAgents();
  await saveSessions();
  await saveSessionMessages();
  renderAgentList();
  renderSessionList();

  showSuccess(`Agent "${agent.name}" 已删除`);

  void import('../ui').then(({ clearArtifactPreviewCacheForAgent, closeArtifactPreviewModal, renderMessages }) => {
    clearArtifactPreviewCacheForAgent(agentId);
    if (deletingCurrentAgent) {
      closeArtifactPreviewModal();
      renderMessages();
    }
  });

  void import('../app').then(({ refreshComposerState }) => {
    refreshComposerState();
  });
}

// ── Rename Agent ──────────────────────────────────────────────────────────────

export async function renameAgent(agentId: string) {
  const agent = state.agents.find((a) => a.id === agentId);
  if (!agent) {
    return;
  }
  state.renamingAgentId = agent.id;
  renameAgentNameInputEl.value = agent.name;
  renameAgentModalEl.classList.remove('hidden');
  window.requestAnimationFrame(() => {
    renameAgentNameInputEl.focus();
    renameAgentNameInputEl.select();
  });
}

export function hideRenameAgentModal() {
  state.renamingAgentId = null;
  renameAgentModalEl.classList.add('hidden');
}

export async function submitRenameAgent() {
  if (!state.renamingAgentId) {
    return;
  }

  const agent = state.agents.find((a) => a.id === state.renamingAgentId);
  if (!agent) {
    hideRenameAgentModal();
    return;
  }

  const nextName = renameAgentNameInputEl.value.trim();
  if (!nextName) {
    showError('Agent 名称不能为空');
    renameAgentNameInputEl.focus();
    return;
  }

  const normalizedName = nextName.slice(0, 40);
  if (normalizedName === agent.name) {
    hideRenameAgentModal();
    return;
  }

  agent.name = normalizedName;
  await saveAgents();
  if (state.currentAgentId === agent.id) {
    currentAgentNameEl.textContent = agent.name;
  }
  renderAgentList();
  hideRenameAgentModal();

  showSuccess('Agent 名称已更新');
}

// ── Agent List UI ─────────────────────────────────────────────────────────────

function handleAgentAction(action: string, agentId: string) {
  if (!agentId) {
    return;
  }
  if (action === 'delete') {
    void deleteAgent(agentId);
    return;
  }
  if (action === 'rename') {
    void renameAgent(agentId);
    return;
  }
  if (action === 'reconnect') {
    void import('./reconnect').then(({ reconnectAgent }) => {
      reconnectAgent(agentId);
    });
  }
}

let lastAgentClickId = '';
let lastAgentClickTime = 0;

export function onAgentListClick(event: MouseEvent) {
  const rawTarget = event.target;
  const target =
    rawTarget instanceof Element
      ? rawTarget
      : rawTarget instanceof Node
        ? rawTarget.parentElement
        : null;
  if (!target) {
    return;
  }

  const deleteBtn = target.closest('button.btn-delete[data-agent-id]') as HTMLButtonElement | null;
  if (deleteBtn?.dataset.agentId) {
    event.preventDefault();
    event.stopPropagation();
    void deleteAgent(deleteBtn.dataset.agentId);
    return;
  }

  const actionBtn = target.closest('button[data-action]') as HTMLButtonElement | null;
  if (actionBtn) {
    event.preventDefault();
    event.stopPropagation();
    const action = actionBtn.dataset.action;
    const agentId = actionBtn.dataset.agentId;
    if (!agentId) {
      return;
    }
    if (action === 'delete') {
      void deleteAgent(agentId);
      return;
    }
    if (action === 'rename') {
      void renameAgent(agentId);
      return;
    }
    if (action === 'reconnect') {
      void import('./reconnect').then(({ reconnectAgent }) => {
        reconnectAgent(agentId);
      });
      return;
    }
  }

  const agentItem = target.closest('.agent-item[data-agent-id]') as HTMLDivElement | null;
  if (agentItem?.dataset.agentId) {
    const agentId = agentItem.dataset.agentId;
    const now = Date.now();
    if (agentId === lastAgentClickId && now - lastAgentClickTime < 400) {
      lastAgentClickId = '';
      lastAgentClickTime = 0;
      void import('./reconnect').then(({ reconnectAgent }) => {
        reconnectAgent(agentId);
      });
      return;
    }
    lastAgentClickId = agentId;
    lastAgentClickTime = now;
    selectAgent(agentId);
  }
}

export function renderAgentList() {
  agentListEl.innerHTML = state.agents
    .map(
      (agent) => `
    <div class="agent-item ${agent.id === state.currentAgentId ? 'active' : ''}" data-agent-id="${agent.id}">
      <div class="agent-icon">iF</div>
      <div class="agent-info">
        <div class="agent-name">${escapeHtml(agent.name)}</div>
        <div class="agent-status" title="${escapeHtml(agent.workspacePath)}">${escapeHtml(getWorkspaceName(agent.workspacePath))}</div>
        <div class="agent-meta">ID: ${escapeHtml(shortAgentId(agent.id))}</div>
      </div>
      <div class="agent-actions">
        <div class="status-indicator ${agent.status}"></div>
        <button class="btn-edit" data-action="rename" data-agent-id="${agent.id}" title="编辑名称">✎</button>
        ${
          agent.status !== 'connected'
            ? `<button class="btn-reconnect" data-action="reconnect" data-agent-id="${agent.id}" title="重连 Agent">↻</button>`
            : ''
        }
        <button class="btn-delete" data-action="delete" data-agent-id="${agent.id}" title="删除">×</button>
      </div>
    </div>
  `
    )
    .join('');

  // 显式绑定按钮事件
  const actionButtons = agentListEl.querySelectorAll('button[data-action][data-agent-id]');
  actionButtons.forEach((button) => {
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const action = button.getAttribute('data-action') || '';
      const agentId = button.getAttribute('data-agent-id') || '';
      handleAgentAction(action, agentId);
    });
  });
}

// ── Persistence ───────────────────────────────────────────────────────────────

import { loadSessionStore, migrateLegacyHistoryIfNeeded, pruneSessionDataByAgents } from '../storage';
import { autoReconnectSavedAgents } from './reconnect';

export async function loadAgents() {
  try {
    await loadSessionStore();
    await migrateLegacyHistoryIfNeeded();

    const saved = localStorage.getItem(AGENTS_STORAGE_KEY);
    if (!saved) {
      renderAgentList();
      renderSessionList();
      updateCurrentAgentModelUI();
      updateCurrentAgentThinkUI();
      return;
    }

    state.agents = JSON.parse(saved) as Agent[];
    state.agents = state.agents.map((agent) => ({
      ...agent,
      iflowPath: agent.iflowPath || 'iflow',
      thinkEnabled: Boolean(agent.thinkEnabled),
      status: 'disconnected' as const,
      port: undefined,
    }));

    pruneSessionDataByAgents();
    await saveAgents();
    await saveSessions();
    await saveSessionMessages();

    renderAgentList();
    renderSessionList();
    updateCurrentAgentModelUI();
    updateCurrentAgentThinkUI();
    await autoReconnectSavedAgents();
  } catch (e) {
    console.error('Failed to load agents:', e);
  }
}

export async function saveAgents() {
  try {
    localStorage.setItem(AGENTS_STORAGE_KEY, JSON.stringify(state.agents));
  } catch (e) {
    console.error('Failed to save agents:', e);
  }
}

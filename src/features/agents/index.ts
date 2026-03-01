// src/features/agents/index.ts — agent management, model management, and tool calls
import {
  connectIflow,
  disconnectAgent,
  listAvailableModels,
  listGitChanges,
  switchAgentModel as tauriSwitchAgentModel,
  toggleAgentThink as tauriToggleAgentThink,
} from '../../services/tauri';
import { shortAgentId, getWorkspaceName } from '../../lib/utils';
import { escapeHtml } from '../../lib/html';
import type {
  Agent,
  Message,
  ToolCall,
  RegistryCommand,
  RegistryMcpServer,
  ModelOption,
  ThinkSupportStatus,
  ParsedModelSlashCommand,
  GitFileChange,
} from '../../types';
import { state } from '../../store';
import {
  agentListEl,
  currentAgentNameEl,
  currentAgentStatusEl,
  currentAgentModelBtnEl,
  currentAgentModelTextEl,
  currentAgentModelMenuEl,
  toggleThinkBtnEl,
  toolCallsPanelEl,
  toolCallsListEl,
  gitChangesPanelEl,
  clearChatBtnEl,
  connectionStatusEl,
  renameAgentNameInputEl,
  renameAgentModalEl,
} from '../../dom';
import {
  AGENTS_STORAGE_KEY,
  loadSessionStore,
  saveSessions,
  saveSessionMessages,
  migrateLegacyHistoryIfNeeded,
  pruneSessionDataByAgents,
} from '../storage';
import {
  renderSessionList,
  ensureAgentHasSessions,
  getSessionsForAgent,
  getMessagesForSession,
  selectSession,
  commitSessionMessages,
  syncIflowHistorySessions,
} from '../sessions';

// ── Utility helpers ───────────────────────────────────────────────────────────

export function readTextFromUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => readTextFromUnknown(item))
      .filter((item) => Boolean(item))
      .join(' ')
      .trim();
  }

  if (value && typeof value === 'object') {
    return readTextFromUnknown((value as Record<string, unknown>).text);
  }

  return '';
}

export function isCurrentAgentBusy(): boolean {
  const currentAgent = state.currentAgentId ? state.agents.find((agent) => agent.id === state.currentAgentId) : null;
  return Boolean(currentAgent && state.inflightSessionByAgent[currentAgent.id]);
}

const THINK_UNSUPPORTED_HINTS = [
  'not support',
  'not supported',
  'unsupported',
  'does not support',
  'method not found',
  'unknown method',
  'not implemented',
  'unavailable',
  '不支持',
  '不可用',
  '未实现',
];

function readErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

function normalizeThinkModelKey(modelName: string | undefined): string | null {
  if (typeof modelName !== 'string') {
    return null;
  }
  const normalized = modelName.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function getThinkSupportByModel(modelName: string | undefined): ThinkSupportStatus {
  const key = normalizeThinkModelKey(modelName);
  if (!key) {
    return 'unknown';
  }
  return state.thinkSupportByModel[key] || 'unknown';
}

function setThinkSupportByModel(modelName: string | undefined, status: ThinkSupportStatus) {
  const key = normalizeThinkModelKey(modelName);
  if (!key) {
    return;
  }
  state.thinkSupportByModel[key] = status;
}

function isThinkUnsupportedError(error: unknown): boolean {
  const message = readErrorMessage(error).toLowerCase();
  if (THINK_UNSUPPORTED_HINTS.some((hint) => message.includes(hint))) {
    return true;
  }

  const hasThinkContext = message.includes('set_think') || message.includes('think');
  const hasInvalidParams = message.includes('invalid params') || message.includes('invalid parameters');
  return hasThinkContext && hasInvalidParams;
}

// ── Agent registry ────────────────────────────────────────────────────────────

export function normalizeRegistryCommands(rawEntries: unknown[] | undefined): RegistryCommand[] {
  if (!Array.isArray(rawEntries)) {
    return [];
  }

  const normalized: RegistryCommand[] = [];
  const seen = new Set<string>();

  for (const entry of rawEntries) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const rawName = readTextFromUnknown((entry as Record<string, unknown>).name);
    if (!rawName) {
      continue;
    }

    const name = rawName.startsWith('/') ? rawName : `/${rawName}`;
    const dedupeKey = name.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }

    const description = readTextFromUnknown((entry as Record<string, unknown>).description);
    const scope = readTextFromUnknown((entry as Record<string, unknown>).scope);
    normalized.push({ name, description, scope });
    seen.add(dedupeKey);
  }

  return normalized;
}

export function normalizeRegistryMcpServers(rawEntries: unknown[] | undefined): RegistryMcpServer[] {
  if (!Array.isArray(rawEntries)) {
    return [];
  }

  const normalized: RegistryMcpServer[] = [];
  const seen = new Set<string>();

  for (const entry of rawEntries) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const rawName = readTextFromUnknown((entry as Record<string, unknown>).name);
    if (!rawName) {
      continue;
    }

    const dedupeKey = rawName.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }

    const description = readTextFromUnknown((entry as Record<string, unknown>).description);
    normalized.push({ name: rawName, description });
    seen.add(dedupeKey);
  }

  return normalized;
}

export function applyAgentRegistry(agentId: string, rawCommands: unknown[] | undefined, rawMcpServers: unknown[] | undefined) {
  const commands = normalizeRegistryCommands(rawCommands);
  const mcpServers = normalizeRegistryMcpServers(rawMcpServers);
  if (commands.length === 0 && mcpServers.length === 0) {
    return;
  }

  state.registryByAgent[agentId] = {
    commands,
    mcpServers,
  };

  if (agentId === state.currentAgentId) {
    void import('../app').then(({ updateSlashCommandMenu }) => {
      updateSlashCommandMenu();
    });
  }
}

export function applyAgentModelRegistry(
  agentId: string,
  rawModels: unknown[] | undefined,
  rawCurrentModel: unknown
) {
  const models = Array.isArray(rawModels)
    ? rawModels.map((item) => normalizeModelOption(item)).filter((item): item is ModelOption => Boolean(item))
    : [];

  if (models.length > 0) {
    state.modelOptionsCacheByAgent[agentId] = models;
  }

  const currentModel =
    typeof rawCurrentModel === 'string' && rawCurrentModel.trim().length > 0
      ? rawCurrentModel.trim()
      : null;

  const agent = state.agents.find((item) => item.id === agentId);
  if (!agent) {
    return;
  }

  if (currentModel && agent.selectedModel !== currentModel) {
    agent.selectedModel = currentModel;
    void saveAgents();
    renderAgentList();
  }

  if (state.currentAgentId === agentId) {
    updateCurrentAgentModelUI();
    updateCurrentAgentThinkUI();
    if (state.modelSelectorOpen) {
      renderCurrentAgentModelMenu(agent, state.modelOptionsCacheByAgent[agentId] || []);
    }
  }
}

// ── Tool calls ────────────────────────────────────────────────────────────────

export function normalizeToolCallStatus(rawStatus: string | undefined): ToolCall['status'] {
  if (rawStatus === 'running' || rawStatus === 'completed' || rawStatus === 'error') {
    return rawStatus;
  }
  return 'pending';
}

export function normalizeToolCallItem(raw: ToolCall): ToolCall {
  return {
    id: raw.id?.trim() || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: raw.name?.trim() || 'unknown_tool',
    status: normalizeToolCallStatus(raw.status),
    arguments: raw.arguments,
    output: typeof raw.output === 'string' ? raw.output : undefined,
  };
}

export function mergeToolCalls(agentId: string, incoming: ToolCall[]) {
  const current = state.toolCallsByAgent[agentId] || [];
  const merged = [...current];

  for (const rawItem of incoming) {
    const item = normalizeToolCallItem(rawItem);
    const index = merged.findIndex((existing) => existing.id === item.id);
    if (index < 0) {
      merged.push(item);
      continue;
    }

    const existing = merged[index];
    merged[index] = {
      ...existing,
      name: item.name || existing.name,
      status: item.status || existing.status,
      arguments: item.arguments ?? existing.arguments,
      output: item.output ?? existing.output,
    };
  }

  state.toolCallsByAgent[agentId] = merged;
  if (agentId === state.currentAgentId) {
    void import('../ui').then(({ showToolCalls }) => {
      showToolCalls(merged);
    });
  }
}

export function resetToolCallsForAgent(agentId: string) {
  delete state.toolCallsByAgent[agentId];
  if (agentId === state.currentAgentId) {
    toolCallsListEl.innerHTML = '';
    toolCallsPanelEl.classList.add('hidden');
  }
}

export function openCurrentAgentToolCallsPanel() {
  if (!state.currentAgentId) {
    return;
  }

  const currentToolCalls = state.toolCallsByAgent[state.currentAgentId] || [];
  void import('../ui').then(({ showToolCalls }) => {
    showToolCalls(currentToolCalls, { forceOpen: true });
  });
}

export function showGitChangesForAgent(agentId: string) {
  if (agentId !== state.currentAgentId) {
    return;
  }
  const changes = state.gitChangesByAgent[agentId] || [];
  const loading = Boolean(state.gitChangesLoadingByAgent[agentId]);
  const error = state.gitChangesErrorByAgent[agentId] || '';
  const lastRefreshedAt = state.gitChangesLastRefreshedAtByAgent[agentId];
  const disableRefresh = Boolean(state.inflightSessionByAgent[agentId]);

  void import('../ui').then(({ showGitChanges }) => {
    showGitChanges(changes, { loading, error, lastRefreshedAt, disableRefresh });
  });
}

export function resetGitChangesForAgent(agentId: string) {
  delete state.gitChangesByAgent[agentId];
  delete state.gitChangesLoadingByAgent[agentId];
  delete state.gitChangesErrorByAgent[agentId];
  delete state.gitChangesLastRefreshedAtByAgent[agentId];
  if (agentId === state.currentAgentId) {
    gitChangesPanelEl.classList.add('hidden');
  }
}

export async function refreshAgentGitChanges(agentId: string) {
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

export async function refreshCurrentAgentGitChanges() {
  if (!state.currentAgentId) {
    return;
  }
  await refreshAgentGitChanges(state.currentAgentId);
}

// ── Model selector ────────────────────────────────────────────────────────────

export function closeCurrentAgentModelMenu() {
  state.modelSelectorOpen = false;
  currentAgentModelBtnEl.setAttribute('aria-expanded', 'false');
  currentAgentModelMenuEl.classList.add('hidden');
}

export async function toggleCurrentAgentModelMenu() {
  const agent = state.currentAgentId ? state.agents.find((item) => item.id === state.currentAgentId) : null;
  if (!agent || agent.status !== 'connected') {
    return;
  }

  if (state.modelSelectorOpen) {
    closeCurrentAgentModelMenu();
    return;
  }

  state.modelSelectorOpen = true;
  currentAgentModelBtnEl.setAttribute('aria-expanded', 'true');
  currentAgentModelMenuEl.classList.remove('hidden');
  currentAgentModelMenuEl.innerHTML = '<div class="model-selector-state">正在加载模型列表...</div>';

  const options = await loadAgentModelOptions(agent);
  if (!state.modelSelectorOpen || state.currentAgentId !== agent.id) {
    return;
  }
  renderCurrentAgentModelMenu(agent, options);
}

export function resolveModelDisplayName(option: ModelOption): string {
  const label = option.label.trim();
  const value = option.value.trim();
  return label.length > 0 ? label : value;
}

export function isModelOptionActive(agent: Agent, option: ModelOption, index: number): boolean {
  const selected = agent.selectedModel?.trim().toLowerCase();
  if (!selected) {
    return index === 0;
  }
  return (
    option.value.trim().toLowerCase() === selected || option.label.trim().toLowerCase() === selected
  );
}

export function renderCurrentAgentModelMenu(agent: Agent, options: ModelOption[]) {
  if (options.length === 0) {
    currentAgentModelMenuEl.innerHTML =
      '<div class="model-selector-state">当前无法读取模型列表，请稍后重试。</div>';
    return;
  }

  currentAgentModelMenuEl.innerHTML = options
    .map((option, index) => {
      const active = isModelOptionActive(agent, option, index);
      return `
      <button
        type="button"
        class="model-option-item ${active ? 'active' : ''}"
        data-model-value="${escapeHtml(option.value)}"
      >
        <span class="model-option-name">${escapeHtml(resolveModelDisplayName(option))}</span>
        <span class="model-option-tag">${active ? '当前' : ''}</span>
      </button>
    `;
    })
    .join('');
}

export async function onCurrentAgentModelMenuClick(event: MouseEvent) {
  const target = event.target as HTMLElement;
  const optionBtn = target.closest('button[data-model-value]') as HTMLButtonElement | null;
  if (!optionBtn) {
    return;
  }

  const modelName = optionBtn.dataset.modelValue?.trim();
  const agent = state.currentAgentId ? state.agents.find((item) => item.id === state.currentAgentId) : null;
  if (!agent || !modelName || agent.status !== 'connected') {
    return;
  }

  const selected = agent.selectedModel?.trim().toLowerCase();
  if (selected === modelName.toLowerCase()) {
    closeCurrentAgentModelMenu();
    return;
  }

  closeCurrentAgentModelMenu();
  const error = await switchAgentModel(agent, modelName);
  if (error) {
    showError(`模型切换失败：${error}`);
    return;
  }
  showSuccess(`已切换模型：${modelName}`);
}

export function updateCurrentAgentModelUI() {
  const agent = state.currentAgentId ? state.agents.find((item) => item.id === state.currentAgentId) : null;
  if (!agent) {
    currentAgentModelBtnEl.disabled = true;
    currentAgentModelTextEl.textContent = '模型：未连接';
    closeCurrentAgentModelMenu();
    return;
  }

  if (state.modelSwitchingAgentId === agent.id) {
    currentAgentModelBtnEl.disabled = true;
    currentAgentModelTextEl.textContent = '模型：切换中...';
    return;
  }

  currentAgentModelTextEl.textContent = `模型：${currentAgentModelLabel(agent)}`;
  currentAgentModelBtnEl.title = currentAgentModelLabel(agent);
  currentAgentModelBtnEl.disabled = agent.status !== 'connected';

  if (agent.status !== 'connected') {
    closeCurrentAgentModelMenu();
  }
}

export function updateCurrentAgentThinkUI() {
  const agent = state.currentAgentId ? state.agents.find((item) => item.id === state.currentAgentId) : null;
  if (!agent) {
    toggleThinkBtnEl.disabled = true;
    toggleThinkBtnEl.classList.remove('active', 'loading', 'unsupported');
    toggleThinkBtnEl.textContent = '思考：关';
    toggleThinkBtnEl.title = '思考：未连接';
    return;
  }

  const supportStatus = getThinkSupportByModel(agent.selectedModel);
  const unsupported = supportStatus === 'unsupported';
  const enabled = !unsupported && Boolean(agent.thinkEnabled);
  const switching = state.thinkSwitchingAgentId === agent.id;
  toggleThinkBtnEl.classList.toggle('active', enabled);
  toggleThinkBtnEl.classList.toggle('loading', switching);
  toggleThinkBtnEl.classList.toggle('unsupported', unsupported);
  toggleThinkBtnEl.textContent = unsupported ? '思考：不支持' : `思考：${enabled ? '开' : '关'}`;
  toggleThinkBtnEl.title = switching
    ? '切换中...'
    : unsupported
      ? '当前模型不支持思考模式'
      : enabled
        ? '点击关闭思考模式'
        : '点击开启思考模式';
  toggleThinkBtnEl.disabled = agent.status !== 'connected' || switching || unsupported;
}

export async function toggleCurrentAgentThink() {
  const agent = state.currentAgentId ? state.agents.find((item) => item.id === state.currentAgentId) : null;
  if (!agent || agent.status !== 'connected') {
    return;
  }
  if (state.thinkSwitchingAgentId === agent.id) {
    return;
  }
  if (getThinkSupportByModel(agent.selectedModel) === 'unsupported') {
    showError('当前模型不支持思考模式');
    return;
  }

  const nextEnabled = !Boolean(agent.thinkEnabled);
  state.thinkSwitchingAgentId = agent.id;
  updateCurrentAgentThinkUI();

  try {
    await tauriToggleAgentThink(agent.id, nextEnabled, 'think');
    setThinkSupportByModel(agent.selectedModel, 'supported');
    agent.thinkEnabled = nextEnabled;
    await saveAgents();
    showSuccess(`思考模式已${nextEnabled ? '开启' : '关闭'}`);
  } catch (error) {
    const errorMessage = readErrorMessage(error);
    console.error('Think toggle error:', errorMessage);
    if (isThinkUnsupportedError(error)) {
      setThinkSupportByModel(agent.selectedModel, 'unsupported');
      agent.thinkEnabled = false;
      await saveAgents();
      showError('当前模型不支持思考模式');
    } else {
      showError(`切换思考模式失败: ${errorMessage}`);
    }
  } finally {
    state.thinkSwitchingAgentId = null;
    updateCurrentAgentThinkUI();
  }
}

// ── Agent list UI ─────────────────────────────────────────────────────────────

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
      void reconnectAgent(agentId);
      return;
    }
  }

  const agentItem = target.closest('.agent-item[data-agent-id]') as HTMLDivElement | null;
  if (agentItem?.dataset.agentId) {
    selectAgent(agentItem.dataset.agentId);
  }
}

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
    void reconnectAgent(agentId);
  }
}

// 添加 Agent
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
    ensureAgentHasSessions(agentId);

    await saveAgents();
    await saveSessions();
    await saveSessionMessages();

    renderAgentList();
    selectAgent(agentId);
    showSuccess('iFlow 连接成功！');
  } catch (error) {
    console.error('Connection error:', error);
    showError(`连接错误: ${String(error)}`);
  } finally {
    hideLoading();
  }
}

// 选择 Agent
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
    void syncIflowHistorySessions(agent);
    void loadAgentModelOptions(agent).then(() => {
      if (state.currentAgentId === agent.id) {
        updateCurrentAgentModelUI();
      }
    });
  }
}

export async function deleteAgent(agentId: string) {
  const agent = state.agents.find((a) => a.id === agentId);
  if (!agent) {
    showError('未找到对应 Agent，删除失败');
    return;
  }

  const deletingCurrentAgent = state.currentAgentId === agentId;

  if (agent.status === 'connected') {
    // 断开连接放到后台执行，避免接口卡住导致删除按钮看起来“无响应”。
    void disconnectAgent(agentId).catch((e) => {
      console.error('断开连接失败:', e);
    });
  }

  state.agents = state.agents.filter((a) => a.id !== agentId);
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

// 渲染 Agent 列表
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
          agent.status === 'disconnected'
            ? `<button class="btn-reconnect" data-action="reconnect" data-agent-id="${agent.id}" title="重新连接">↻</button>`
            : ''
        }
        <button class="btn-delete" data-action="delete" data-agent-id="${agent.id}" title="删除">×</button>
      </div>
    </div>
  `
    )
    .join('');

  // 显式绑定按钮事件，避免某些 WebView 下委托 click 命中不稳定。
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

export async function reconnectAgent(agentId: string) {
  const agent = state.agents.find((a) => a.id === agentId);
  if (!agent) {
    return;
  }

  agent.status = 'connecting';
  renderAgentList();

  try {
    const result = await connectIflow(agent.id, agent.iflowPath || 'iflow', agent.workspacePath, agent.selectedModel || null);

    if (!result.success) {
      agent.status = 'error';
      showError(result.error || '连接失败');
      renderAgentList();
      updateCurrentAgentModelUI();
      return;
    }

    agent.status = 'connected';
    agent.port = result.port;
    if (agent.thinkEnabled) {
      try {
        await tauriToggleAgentThink(agent.id, true, 'think');
        setThinkSupportByModel(agent.selectedModel, 'supported');
      } catch (error) {
        if (isThinkUnsupportedError(error)) {
          setThinkSupportByModel(agent.selectedModel, 'unsupported');
          agent.thinkEnabled = false;
          console.warn('Restore think mode failed: current model does not support think mode');
        } else {
          console.error('Restore think mode after reconnect failed:', error);
        }
      }
    }
    await saveAgents();
    selectAgent(agent.id);
    showSuccess('重新连接成功！');
  } catch (error) {
    console.error('Reconnection error:', error);
    agent.status = 'error';
    showError(`连接错误: ${String(error)}`);
  }

  renderAgentList();
  updateCurrentAgentModelUI();
  updateCurrentAgentThinkUI();
  void import('../app').then(({ refreshComposerState }) => {
    refreshComposerState();
  });
}

// 更新 Agent 状态 UI
export function updateAgentStatusUI(status: Agent['status']) {
  const statusText = {
    disconnected: '离线',
    connecting: '连接中...',
    connected: '在线',
    error: '错误',
  }[status];

  currentAgentStatusEl.textContent = statusText;
  currentAgentStatusEl.className = `badge${status === 'connected' ? ' connected' : ''}`;
  updateCurrentAgentModelUI();
  updateCurrentAgentThinkUI();
}

// 更新连接状态
export function updateConnectionStatus(connected: boolean) {
  const dot = connectionStatusEl.querySelector('.status-dot') as HTMLSpanElement;
  const text = connectionStatusEl.querySelector('span:last-child') as HTMLSpanElement;
  if (connected) {
    dot.className = 'status-dot connected';
    text.textContent = '已连接';
  } else {
    dot.className = 'status-dot disconnected';
    text.textContent = '未连接';
  }
}

// ── Model management ──────────────────────────────────────────────────────────

export function parseModelSlashCommand(content: string): ParsedModelSlashCommand | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const parts = trimmed.split(/\s+/);
  const command = parts[0].toLowerCase();
  if (command !== '/model') {
    return null;
  }

  if (parts.length === 1) {
    return { kind: 'help' };
  }

  const subCommand = parts[1].toLowerCase();
  if (subCommand === 'list') {
    const filterKeyword = parts.slice(2).join(' ').trim();
    return {
      kind: 'help',
      filterKeyword: filterKeyword.length > 0 ? filterKeyword : undefined,
    };
  }

  if (subCommand === 'current') {
    return { kind: 'current' };
  }

  const targetModel = parts.slice(1).join(' ').trim();
  if (!targetModel) {
    return { kind: 'help' };
  }

  return {
    kind: 'switch',
    targetModel,
  };
}

export function normalizeModelOption(raw: unknown): ModelOption | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const value = typeof record.value === 'string' ? record.value.trim() : '';
  if (!value) {
    return null;
  }

  const labelCandidate = typeof record.label === 'string' ? record.label.trim() : '';
  return {
    value,
    label: labelCandidate || value,
  };
}

export function filterModelOptions(models: ModelOption[], keyword?: string): ModelOption[] {
  if (!keyword) {
    return models;
  }

  const normalized = keyword.trim().toLowerCase();
  if (!normalized) {
    return models;
  }

  return models.filter((item) => {
    const haystack = `${item.label} ${item.value}`.toLowerCase();
    return haystack.includes(normalized);
  });
}

export function formatModelItem(item: ModelOption, index: number): string {
  const labelDiffers = item.label.toLowerCase() !== item.value.toLowerCase();
  return labelDiffers ? `${index}. ${item.value}（${item.label}）` : `${index}. ${item.value}`;
}

export async function loadAgentModelOptions(agent: Agent, forceRefresh = false): Promise<ModelOption[]> {
  if (!forceRefresh && state.modelOptionsCacheByAgent[agent.id] && state.modelOptionsCacheByAgent[agent.id].length > 0) {
    return state.modelOptionsCacheByAgent[agent.id];
  }

  try {
    const raw = await listAvailableModels(agent.iflowPath || 'iflow');
    const normalized = Array.isArray(raw)
      ? raw.map((item) => normalizeModelOption(item)).filter((item): item is ModelOption => Boolean(item))
      : [];
    if (normalized.length > 0) {
      state.modelOptionsCacheByAgent[agent.id] = normalized;
      if (state.currentAgentId === agent.id) {
        updateCurrentAgentModelUI();
      }
    }
    return normalized;
  } catch (error) {
    console.error('Load model list error:', error);
    return [];
  }
}

export function resolveModelName(input: string, models: ModelOption[]): {
  modelName: string;
  fromIndex: boolean;
  invalidIndex: boolean;
  fromAlias: boolean;
} {
  const normalized = input.trim();
  if (!normalized) {
    return { modelName: '', fromIndex: false, invalidIndex: false, fromAlias: false };
  }

  if (/^\d+$/.test(normalized)) {
    const index = Number.parseInt(normalized, 10);
    if (index >= 1 && index <= models.length) {
      return { modelName: models[index - 1].value, fromIndex: true, invalidIndex: false, fromAlias: false };
    }
    return { modelName: '', fromIndex: false, invalidIndex: true, fromAlias: false };
  }

  const targetLowerCase = normalized.toLowerCase();
  const matched = models.find(
    (item) =>
      item.value.toLowerCase() === targetLowerCase || item.label.toLowerCase() === targetLowerCase
  );
  if (matched) {
    return {
      modelName: matched.value,
      fromIndex: false,
      invalidIndex: false,
      fromAlias: matched.value.toLowerCase() !== targetLowerCase,
    };
  }

  return { modelName: normalized, fromIndex: false, invalidIndex: false, fromAlias: false };
}

export function formatModelList(models: ModelOption[], keyword?: string): string {
  const filtered = filterModelOptions(models, keyword);
  if (filtered.length === 0) {
    return `🧠 未找到匹配模型：${keyword || ''}\n可先输入 /model list 查看全部模型`;
  }

  const lines = filtered.map((model, index) => formatModelItem(model, index + 1));

  const suffix = keyword ? `（筛选：${keyword}）` : '';
  return `🧠 可选模型${suffix}：\n${lines.join('\n')}\n\n用法：\n/model current\n/model <模型名>\n/model <编号>\n示例：/model 1`;
}

export function currentAgentModelLabel(agent: Agent): string {
  const selected = agent.selectedModel?.trim();
  if (selected && selected.length > 0) {
    return selected;
  }

  const cached = state.modelOptionsCacheByAgent[agent.id];
  if (cached && cached.length > 0) {
    return `${resolveModelDisplayName(cached[0])}（默认）`;
  }
  return 'iFlow 默认模型';
}

export function parseAboutPayload(content: string): Record<string, unknown> | null {
  const trimmed = content.trim();
  if (!trimmed) {
    return null;
  }

  const parseCandidate = (candidate: string): Record<string, unknown> | null => {
    if (!candidate.startsWith('{') || !candidate.endsWith('}')) {
      return null;
    }
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return null;
      }
      const parsedType = (parsed as Record<string, unknown>).type;
      if (typeof parsedType !== 'string' || parsedType.toLowerCase() !== 'about') {
        return null;
      }
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  const direct = parseCandidate(trimmed);
  if (direct) {
    return direct;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const fromFence = parseCandidate(fenced[1].trim());
    if (fromFence) {
      return fromFence;
    }
  }

  const inlineObject = trimmed.match(/\{[\s\S]*\}/);
  if (inlineObject?.[0]) {
    return parseCandidate(inlineObject[0].trim());
  }

  return null;
}

export function extractModelNameFromAboutPayload(payload: Record<string, unknown>): string | null {
  const candidateFields = [payload.modelVersion, payload.model, payload.modelName];
  for (const field of candidateFields) {
    if (typeof field === 'string') {
      const normalized = field.trim();
      if (normalized.length > 0) {
        return normalized;
      }
    }
  }
  return null;
}

export function syncAgentModelFromAboutContent(agentId: string, content: string) {
  const aboutPayload = parseAboutPayload(content);
  if (!aboutPayload) {
    return;
  }

  const detectedModel = extractModelNameFromAboutPayload(aboutPayload);
  if (!detectedModel) {
    return;
  }

  const agent = state.agents.find((item) => item.id === agentId);
  if (!agent || agent.selectedModel === detectedModel) {
    return;
  }

  agent.selectedModel = detectedModel;
  void saveAgents();
  renderAgentList();
  if (state.currentAgentId === agentId) {
    updateCurrentAgentModelUI();
    updateCurrentAgentThinkUI();
  }
}

export async function switchAgentModel(agent: Agent, modelName: string): Promise<string | null> {
  const targetModel = modelName.trim();
  if (!targetModel) {
    return '模型名称不能为空';
  }

  state.modelSwitchingAgentId = agent.id;
  agent.status = 'connecting';
  renderAgentList();
  if (state.currentAgentId === agent.id) {
    updateAgentStatusUI(agent.status);
  }
  void import('../app').then(({ refreshComposerState }) => {
    refreshComposerState();
  });

  try {
    const result = await tauriSwitchAgentModel(agent.id, agent.iflowPath || 'iflow', agent.workspacePath, targetModel);

    if (!result.success) {
      throw new Error(result.error || '模型切换失败');
    }

    agent.status = 'connected';
    agent.port = result.port;
    agent.selectedModel = targetModel;
    if (agent.thinkEnabled) {
      try {
        await tauriToggleAgentThink(agent.id, true, 'think');
        setThinkSupportByModel(agent.selectedModel, 'supported');
      } catch (error) {
        if (isThinkUnsupportedError(error)) {
          setThinkSupportByModel(agent.selectedModel, 'unsupported');
          agent.thinkEnabled = false;
          console.warn('Restore think mode after model switch failed: target model does not support think mode');
        } else {
          console.error('Restore think mode after model switch failed:', error);
        }
      }
    }
    await saveAgents();
    renderAgentList();
    if (state.currentAgentId === agent.id) {
      updateAgentStatusUI(agent.status);
    }
    void import('../app').then(({ refreshComposerState }) => {
      refreshComposerState();
    });
    return null;
  } catch (error) {
    console.error('Model switch error:', error);
    agent.status = 'error';
    await saveAgents();
    renderAgentList();
    if (state.currentAgentId === agent.id) {
      updateAgentStatusUI(agent.status);
    }
    void import('../app').then(({ refreshComposerState }) => {
      refreshComposerState();
    });
    return String(error);
  } finally {
    state.modelSwitchingAgentId = null;
    if (state.currentAgentId === agent.id) {
      updateCurrentAgentModelUI();
      updateCurrentAgentThinkUI();
    }
  }
}

export async function handleLocalModelCommand(
  content: string,
  agentId: string,
  sessionId: string
): Promise<boolean> {
  const command = parseModelSlashCommand(content);
  if (!command) {
    return false;
  }

  const agent = state.agents.find((item) => item.id === agentId);
  if (!agent) {
    showError('当前 Agent 不存在');
    return true;
  }

  const sessionMessages = getMessagesForSession(sessionId);
  const userMessage: Message = {
    id: `msg-${Date.now()}-model-user`,
    role: 'user',
    content,
    timestamp: new Date(),
  };
  sessionMessages.push(userMessage);
  commitSessionMessages(sessionId, sessionMessages);

  const modelOptions =
    command.kind === 'current'
      ? state.modelOptionsCacheByAgent[agent.id] || []
      : await loadAgentModelOptions(agent, false);

  if (command.kind === 'help') {
    const listText =
      modelOptions.length > 0
        ? formatModelList(modelOptions, command.filterKeyword)
        : '⚠ 当前无法读取 iFlow 模型列表。\n你仍可使用 /model <模型名> 直接切换。';
    const helpMessage: Message = {
      id: `msg-${Date.now()}-model-help`,
      role: 'system',
      content: `${listText}\n\n当前模型（客户端记录）：${currentAgentModelLabel(agent)}`,
      timestamp: new Date(),
    };
    sessionMessages.push(helpMessage);
    commitSessionMessages(sessionId, sessionMessages);
    return true;
  }

  if (command.kind === 'current') {
    const currentMessage: Message = {
      id: `msg-${Date.now()}-model-current`,
      role: 'system',
      content: `🧩 当前模型（客户端记录）：${currentAgentModelLabel(agent)}\n\n说明：自然语言询问"你是什么模型"可能不可靠。\n如需核验，请发送 /about，返回 JSON 中的 modelVersion 会自动同步到这里。`,
      timestamp: new Date(),
    };
    sessionMessages.push(currentMessage);
    commitSessionMessages(sessionId, sessionMessages);
    return true;
  }

  const resolved = resolveModelName(command.targetModel || '', modelOptions);
  if (!resolved.modelName) {
    const invalidMessage: Message = {
      id: `msg-${Date.now()}-model-invalid`,
      role: 'system',
      content: resolved.invalidIndex
        ? modelOptions.length > 0
          ? `⚠ 模型编号超出范围。\n\n${formatModelList(modelOptions)}`
          : '⚠ 当前无法使用编号切换模型，因为模型列表暂不可用。\n请改用：/model <模型名>'
        : modelOptions.length > 0
          ? `⚠ 无效模型参数。\n\n${formatModelList(modelOptions)}`
          : '⚠ 无效模型参数。\n请使用：/model <模型名>',
      timestamp: new Date(),
    };
    sessionMessages.push(invalidMessage);
    commitSessionMessages(sessionId, sessionMessages);
    return true;
  }

  const modelName = resolved.modelName;
  const progressMessage: Message = {
    id: `msg-${Date.now()}-model-progress`,
    role: 'system',
    content: `🔄 正在切换模型到 ${modelName}...`,
    timestamp: new Date(),
  };
  sessionMessages.push(progressMessage);
  commitSessionMessages(sessionId, sessionMessages);

  const switchError = await switchAgentModel(agent, modelName);
  if (!switchError) {
    progressMessage.content = `✅ 已切换到模型：${modelName}`;
    if (resolved.fromIndex) {
      progressMessage.content += '（通过编号选择）';
    }
    if (resolved.fromAlias) {
      progressMessage.content += '（通过显示名匹配）';
    }
    progressMessage.content += '\n可发送 /model current 查看客户端记录，或发送 /about 核验服务端实际模型。';
    progressMessage.timestamp = new Date();
    commitSessionMessages(sessionId, sessionMessages);
  } else {
    progressMessage.content = `❌ 模型切换失败：${switchError}`;
    progressMessage.timestamp = new Date();
    commitSessionMessages(sessionId, sessionMessages);
  }

  return true;
}

// ── Agent persistence ─────────────────────────────────────────────────────────

// 加载 Agent 列表
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
  } catch (e) {
    console.error('Failed to load agents:', e);
  }
}

// 保存 Agent 列表
export async function saveAgents() {
  try {
    localStorage.setItem(AGENTS_STORAGE_KEY, JSON.stringify(state.agents));
  } catch (e) {
    console.error('Failed to save agents:', e);
  }
}

// ── UI feedback ───────────────────────────────────────────────────────────────

export function showLoading(message: string) {
  console.log('Loading:', message);
}

export function hideLoading() {
  console.log('Loading hidden');
}

export function showSuccess(message: string) {
  console.log('Success:', message);
}

export function showError(message: string) {
  console.error('Error:', message);
  alert(message);
}

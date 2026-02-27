// src/features/app.ts — all application logic (extracted from main.ts)
import {
  onStreamMessage,
  onToolCall,
  onCommandRegistry,
  onModelRegistry,
  onAcpSession,
  onTaskFinish,
  onAgentError,
} from '../services/events';
import {
  convertFileSrc,
  getVersion,
  readHtmlArtifact,
  resolveHtmlArtifactPath,
  clearIflowHistorySessions,
  connectIflow,
  listIflowHistorySessions,
  loadIflowHistoryMessages,
  disconnectAgent,
  deleteIflowHistorySession,
  listAvailableModels,
  switchAgentModel as tauriSwitchAgentModel,
  sendMessage as tauriSendMessage,
  stopMessage,
  loadStorageSnapshot as tauriLoadStorageSnapshot,
  saveStorageSnapshot as tauriSaveStorageSnapshot,
} from '../services/tauri';
import { generateAcpSessionId, shortAgentId, getWorkspaceName, streamTypeToRole, normalizeStoredRole, formatTime, formatSessionMeta } from '../lib/utils';
import { escapeHtml } from '../lib/html';
import { formatMessageContent, normalizeTitleSource } from '../lib/markdown';
import type { Agent, Session, Message, ToolCall, RegistryCommand, RegistryMcpServer, ModelOption, SlashMenuItem, StoredSession, StoredMessage, StoredSessionMap, StoredMessageMap, LegacyMessageHistoryMap, StorageSnapshot, IflowHistoryMessageRecord, ComposerState, StreamMessageType, ThemeMode, ParsedModelSlashCommand } from '../types';
import { state } from '../store';
import {
  addAgentBtnEl,
  agentListEl,
  sessionListEl,
  chatMessagesEl,
  messageInputEl,
  sendBtnEl,
  addAgentModalEl,
  closeModalBtnEl,
  cancelAddAgentBtnEl,
  confirmAddAgentBtnEl,
  renameAgentModalEl,
  closeRenameAgentModalBtnEl,
  cancelRenameAgentBtnEl,
  confirmRenameAgentBtnEl,
  renameAgentNameInputEl,
  currentAgentNameEl,
  currentAgentStatusEl,
  currentAgentModelBtnEl,
  currentAgentModelTextEl,
  currentAgentModelMenuEl,
  toolCallsPanelEl,
  toolCallsListEl,
  closeToolPanelBtnEl,
  newSessionBtnEl,
  clearChatBtnEl,
  connectionStatusEl,
  clearAllSessionsBtnEl,
  inputStatusHintEl,
  slashCommandMenuEl,
  artifactPreviewModalEl,
  closeArtifactPreviewBtnEl,
  artifactPreviewPathEl,
  artifactPreviewFrameEl,
  themeToggleBtnEl,
  appVersionEl,
} from '../dom';

const AGENTS_STORAGE_KEY = 'iflow-agents';
const SESSIONS_STORAGE_KEY = 'iflow-sessions';
const SESSION_MESSAGES_STORAGE_KEY = 'iflow-session-messages';
const LEGACY_MESSAGE_HISTORY_STORAGE_KEY = 'iflow-message-history';
const SEND_BUTTON_SEND_ICON = `
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <line x1="22" y1="2" x2="11" y2="13"></line>
    <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
  </svg>
`;
const SEND_BUTTON_STOP_ICON = `
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <rect x="6" y="6" width="12" height="12" rx="2"></rect>
  </svg>
`;
const DEFAULT_SLASH_COMMANDS: ReadonlyArray<{ command: string; description: string }> = [
  { command: '/help', description: '显示帮助与命令说明' },
  { command: '/model list', description: '查看可选模型列表' },
  { command: '/model current', description: '查看当前模型（客户端记录）' },
  { command: '/model <name|编号>', description: '切换当前 Agent 模型（本地实现）' },
  { command: '/commands', description: '列出可用命令' },
  { command: '/tools', description: '查看工具列表' },
  { command: '/memory show', description: '查看当前记忆' },
  { command: '/stats', description: '查看会话统计' },
  { command: '/mcp list', description: '查看 MCP 列表' },
  { command: '/agents list', description: '查看可用 Agent' },
];
const TITLE_GENERIC_PHRASES = new Set<string>([
  '继续',
  '好的',
  '谢谢',
  '请继续',
  '帮我',
  '请帮我',
  '开始',
  'ok',
  'okay',
  'thanks',
]);
const ASSISTANT_QUICK_REPLIES: ReadonlyArray<string> = ['继续', '好的'];
const HTML_ARTIFACT_PATH_PATTERN = /\.html?$/i;
const HTML_ARTIFACT_JSON_PATH_PATTERN =
  /["']?(?:file_path|absolute_path|path)["']?\s*[:=]\s*["']([^"'\n]+\.html?)["']/gi;
const HTML_ARTIFACT_GENERIC_PATH_PATTERN =
  /(?:file:\/\/)?(?:[A-Za-z]:[\\/]|\/|\.{1,2}\/|~\/)[^\s"'`<>|]+\.html?/gi;
const HTML_ARTIFACT_BARE_FILE_PATTERN = /[^\s"'`<>|/\\]+\.html?/gi;
const ARTIFACT_PREVIEW_CACHE_LIMIT = 8;
const ARTIFACT_PREVIEW_READ_TIMEOUT_MS = 12000;
const ARTIFACT_PREVIEW_CACHE_URL_PREFIX = 'url:';
const ARTIFACT_PREVIEW_CACHE_HTML_PREFIX = 'html:';

// 初始化
// 主题管理
const THEME_STORAGE_KEY = 'iflow-theme';
const THEME_CYCLE: Record<ThemeMode, ThemeMode> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_ICON: Record<ThemeMode, string> = { system: '◑', light: '☀', dark: '☾' };
const THEME_TITLE: Record<ThemeMode, string> = { system: '跟随系统', light: '亮色模式', dark: '暗色模式' };


export function applyTheme(mode: ThemeMode) {
  const root = document.documentElement;
  root.classList.remove('theme-light', 'theme-dark');
  if (mode !== 'system') root.classList.add(`theme-${mode}`);
  themeToggleBtnEl.textContent = THEME_ICON[mode];
  themeToggleBtnEl.title = THEME_TITLE[mode];
}


export async function syncAppVersion() {
  try {
    const version = await getVersion();
    appVersionEl.textContent = `v${version}`;
  } catch (error) {
    console.error('Load app version failed:', error);
    appVersionEl.textContent = 'v--';
  }
}

export function setSendButtonMode(mode: 'send' | 'stop', disabled: boolean) {
  sendBtnEl.disabled = disabled;
  sendBtnEl.classList.toggle('btn-stop', mode === 'stop');
  sendBtnEl.setAttribute('aria-label', mode === 'stop' ? '停止生成' : '发送消息');
  sendBtnEl.title = mode === 'stop' ? '停止生成' : '发送消息';
  sendBtnEl.innerHTML = mode === 'stop' ? SEND_BUTTON_STOP_ICON : SEND_BUTTON_SEND_ICON;
}

export function setComposerState(state: ComposerState, hint: string) {
  messageInputEl.classList.remove('composer-ready', 'composer-busy', 'composer-disabled');
  messageInputEl.classList.add(`composer-${state}`);
  inputStatusHintEl.textContent = hint;

  if (state === 'ready') {
    messageInputEl.disabled = false;
    setSendButtonMode('send', false);
    messageInputEl.placeholder = '输入消息...';
    updateSlashCommandMenu();
    return;
  }

  messageInputEl.disabled = true;
  if (state === 'busy') {
    setSendButtonMode('stop', false);
    messageInputEl.placeholder = '正在回复中，可点击停止按钮中断';
  } else {
    setSendButtonMode('send', true);
    messageInputEl.placeholder = '请选择 Agent 后开始对话...';
  }
  hideSlashCommandMenu();
}

export function refreshComposerState() {
  const currentAgent = state.currentAgentId ? state.agents.find((agent) => agent.id === state.currentAgentId) : null;
  const isConnected = currentAgent?.status === 'connected';
  const hasSession = Boolean(state.currentSessionId);
  const isBusy = isCurrentAgentBusy();

  if (!isConnected || !hasSession) {
    setComposerState('disabled', '请选择在线 Agent 与会话后输入');
    newSessionBtnEl.disabled = !isConnected;
    clearChatBtnEl.disabled = true;
    return;
  }

  if (isBusy) {
    setComposerState('busy', '正在回复中，可点击停止按钮中断');
    newSessionBtnEl.disabled = true;
    clearChatBtnEl.disabled = true;
    return;
  }

  setComposerState('ready', '当前会话已完成，可继续输入');
  newSessionBtnEl.disabled = false;
  clearChatBtnEl.disabled = false;
}

export function isCurrentAgentBusy(): boolean {
  const currentAgent = state.currentAgentId ? state.agents.find((agent) => agent.id === state.currentAgentId) : null;
  return Boolean(currentAgent && state.inflightSessionByAgent[currentAgent.id]);
}

// 设置 Tauri 事件监听
export function setupTauriEventListeners() {
  console.log('Setting up Tauri event listeners...');

  onStreamMessage((payload) => {
    if (!payload.agentId || !payload.content) {
      return;
    }

    if (payload.agentId === state.currentAgentId && state.messageTimeout) {
      clearTimeout(state.messageTimeout);
      state.messageTimeout = null;
    }

    const targetSessionId =
      state.inflightSessionByAgent[payload.agentId] ||
      (payload.agentId === state.currentAgentId ? state.currentSessionId : null);

    if (!targetSessionId) {
      return;
    }

    appendStreamMessage(payload.agentId, targetSessionId, payload.content, payload.type);
  });

  onToolCall((payload) => {
    if (payload.agentId && Array.isArray(payload.toolCalls)) {
      mergeToolCalls(payload.agentId, payload.toolCalls);
    }
  });

  onCommandRegistry((payload) => {
    if (!payload.agentId) {
      return;
    }

    applyAgentRegistry(payload.agentId, payload.commands, payload.mcpServers);
  });

  onModelRegistry((payload) => {
    if (!payload.agentId) {
      return;
    }

    applyAgentModelRegistry(payload.agentId, payload.models, payload.currentModel);
  });

  onAcpSession((payload) => {
    if (!payload.agentId || !payload.sessionId) {
      return;
    }
    applyAcpSessionBinding(payload.agentId, payload.sessionId);
  });

  onTaskFinish((payload) => {
    if (!payload.agentId) {
      return;
    }

    const targetSessionId = state.inflightSessionByAgent[payload.agentId];
    if (targetSessionId) {
      delete state.inflightSessionByAgent[payload.agentId];
    }

    if (payload.agentId === state.currentAgentId) {
      if (state.messageTimeout) {
        clearTimeout(state.messageTimeout);
        state.messageTimeout = null;
      }

      state.messages = state.messages.filter((m) => !m.id.includes('-sending') && !m.id.includes('-processing'));
      renderMessages();
      refreshComposerState();
    } else if (targetSessionId) {
      const sessionMessages = getMessagesForSession(targetSessionId).filter(
        (m) => !m.id.includes('-sending') && !m.id.includes('-processing')
      );
      state.messagesBySession[targetSessionId] = sessionMessages;
      void saveSessionMessages();
      renderSessionList();
      refreshComposerState();
    }
  });

  onAgentError((payload) => {
    if (payload.agentId) {
      delete state.inflightSessionByAgent[payload.agentId];
    }
    if (payload.agentId && payload.agentId !== state.currentAgentId) {
      return;
    }
    showError(`错误: ${payload.error || '未知错误'}`);
    refreshComposerState();
  });
}

// 追加流式消息
export function appendStreamMessage(
  agentId: string,
  sessionId: string,
  content: string,
  messageType: StreamMessageType | undefined
) {
  const sessionMessages = getMessagesForSession(sessionId).filter(
    (m) => !m.id.includes('-sending') && !m.id.includes('-processing')
  );

  const role = streamTypeToRole(messageType);
  let normalizedContent = content;
  if (role === 'thought') {
    normalizedContent = normalizedContent.replace(/^💭\s*/, '');
  }
  if (!normalizedContent.trim()) {
    return;
  }

  let lastMessage = sessionMessages[sessionMessages.length - 1];
  const canAppendToLast = role !== 'system' && role !== 'user' && lastMessage?.role === role;

  if (!canAppendToLast) {
    lastMessage = {
      id: `msg-${Date.now()}`,
      role,
      content: '',
      timestamp: new Date(),
      agentId,
    };
    sessionMessages.push(lastMessage);
  }

  lastMessage.content += normalizedContent;
  lastMessage.timestamp = new Date();
  if (role === 'assistant') {
    syncAgentModelFromAboutContent(agentId, lastMessage.content);
  }
  state.messagesBySession[sessionId] = sessionMessages;
  touchSessionById(sessionId, sessionMessages);
  void saveSessionMessages();

  if (sessionId === state.currentSessionId) {
    state.messages = sessionMessages;
    renderMessages();
    scrollToBottom();
  } else {
    renderSessionList();
  }
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
    updateSlashCommandMenu();
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
    if (state.modelSelectorOpen) {
      renderCurrentAgentModelMenu(agent, state.modelOptionsCacheByAgent[agentId] || []);
    }
  }
}

export function applyAcpSessionBinding(agentId: string, acpSessionId: string) {
  const normalizedSessionId = acpSessionId.trim();
  if (!normalizedSessionId) {
    return;
  }

  const preferredSessionId =
    state.inflightSessionByAgent[agentId] ||
    (agentId === state.currentAgentId && state.currentSessionId ? state.currentSessionId : null);
  const sessionList = state.sessionsByAgent[agentId] || [];

  let targetSession = preferredSessionId
    ? sessionList.find((item) => item.id === preferredSessionId)
    : null;
  if (!targetSession) {
    targetSession = sessionList.find((item) => item.acpSessionId === normalizedSessionId) || null;
  }
  if (!targetSession) {
    return;
  }

  // iFlow 历史会话的 sessionId 绑定到磁盘日志文件名，不应被运行时 ACP session 覆盖。
  if (targetSession.source === 'iflow-log') {
    return;
  }

  if (targetSession.acpSessionId === normalizedSessionId) {
    return;
  }

  targetSession.acpSessionId = normalizedSessionId;
  if (!targetSession.source) {
    targetSession.source = 'local';
  }
  void saveSessions();
  if (targetSession.agentId === state.currentAgentId) {
    renderSessionList();
  }
}

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

export function getSlashQueryFromInput(): string | null {
  const firstLine = messageInputEl.value.split('\n')[0].replace(/^\s+/, '');
  if (!firstLine.startsWith('/')) {
    return null;
  }

  if (/\s/.test(firstLine)) {
    return null;
  }

  const token = firstLine.slice(1);
  if (token.includes('/')) {
    return null;
  }

  return token.toLowerCase();
}

export function buildSlashMenuItemsForCurrentAgent(): SlashMenuItem[] {
  const items: SlashMenuItem[] = [];
  const seen = new Set<string>();
  const currentRegistry = state.currentAgentId ? state.registryByAgent[state.currentAgentId] : undefined;

  const pushUnique = (item: SlashMenuItem) => {
    const dedupeKey = item.insertText.toLowerCase();
    if (seen.has(dedupeKey)) {
      return;
    }
    seen.add(dedupeKey);
    items.push(item);
  };

  currentRegistry?.commands.forEach((entry, index) => {
    const hint = entry.scope || 'command';
    pushUnique({
      id: `command-${index}-${entry.name}`,
      label: entry.name,
      insertText: entry.name,
      description: entry.description || '已安装命令',
      hint,
      category: 'command',
      searchable: `${entry.name} ${entry.description} ${hint}`.toLowerCase(),
    });
  });

  currentRegistry?.mcpServers.forEach((entry, index) => {
    const commandText = `/mcp get ${entry.name}`;
    const description = entry.description || `查看 MCP 服务 ${entry.name}`;
    pushUnique({
      id: `mcp-${index}-${entry.name}`,
      label: commandText,
      insertText: commandText,
      description,
      hint: 'mcp',
      category: 'mcp',
      searchable: `${commandText} ${entry.name} ${description}`.toLowerCase(),
    });
  });

  DEFAULT_SLASH_COMMANDS.forEach((entry, index) => {
    pushUnique({
      id: `builtin-${index}-${entry.command}`,
      label: entry.command,
      insertText: entry.command,
      description: entry.description,
      hint: 'builtin',
      category: 'builtin',
      searchable: `${entry.command} ${entry.description}`.toLowerCase(),
    });
  });

  return items;
}

export function updateSlashCommandMenu() {
  const query = getSlashQueryFromInput();
  if (query === null || messageInputEl.disabled || !state.currentAgentId) {
    hideSlashCommandMenu();
    return;
  }

  const candidateItems = buildSlashMenuItemsForCurrentAgent();
  const filteredItems =
    query.length === 0
      ? candidateItems
      : candidateItems.filter((item) => item.searchable.includes(query));

  state.slashMenuItems = filteredItems.slice(0, 12);
  if (state.slashMenuItems.length === 0) {
    state.slashMenuVisible = true;
    state.slashMenuActiveIndex = 0;
    slashCommandMenuEl.classList.remove('hidden');
    slashCommandMenuEl.innerHTML = `<div class="slash-command-empty">未找到匹配命令：/${escapeHtml(query)}</div>`;
    return;
  }

  if (!state.slashMenuVisible) {
    state.slashMenuActiveIndex = 0;
  } else if (state.slashMenuActiveIndex >= state.slashMenuItems.length) {
    state.slashMenuActiveIndex = state.slashMenuItems.length - 1;
  }

  state.slashMenuVisible = true;
  slashCommandMenuEl.classList.remove('hidden');
  slashCommandMenuEl.innerHTML = state.slashMenuItems
    .map((item, index) => {
      const activeClass = index === state.slashMenuActiveIndex ? 'active' : '';
      const desc = escapeHtml(item.description || (item.category === 'mcp' ? 'MCP 服务' : '命令'));
      return `
      <button type="button" class="slash-command-item ${activeClass}" data-index="${index}">
        <div class="slash-command-main">
          <div class="slash-command-name">${escapeHtml(item.label)}</div>
          <div class="slash-command-desc">${desc}</div>
        </div>
        <span class="slash-command-hint">${escapeHtml(item.hint)}</span>
      </button>
    `;
    })
    .join('');
  ensureSlashMenuActiveItemVisible();
}

export function hideSlashCommandMenu() {
  state.slashMenuVisible = false;
  state.slashMenuItems = [];
  state.slashMenuActiveIndex = 0;
  slashCommandMenuEl.classList.add('hidden');
  slashCommandMenuEl.innerHTML = '';
}

export function ensureSlashMenuActiveItemVisible() {
  if (!state.slashMenuVisible || state.slashMenuItems.length === 0) {
    return;
  }

  const activeItemEl = slashCommandMenuEl.querySelector(
    `.slash-command-item[data-index="${state.slashMenuActiveIndex}"]`
  ) as HTMLButtonElement | null;

  if (!activeItemEl) {
    return;
  }

  const containerTop = slashCommandMenuEl.scrollTop;
  const containerBottom = containerTop + slashCommandMenuEl.clientHeight;
  const itemTop = activeItemEl.offsetTop;
  const itemBottom = itemTop + activeItemEl.offsetHeight;

  if (itemTop < containerTop) {
    slashCommandMenuEl.scrollTop = itemTop;
    return;
  }

  if (itemBottom > containerBottom) {
    slashCommandMenuEl.scrollTop = itemBottom - slashCommandMenuEl.clientHeight;
  }
}

export function moveSlashMenuSelection(offset: number) {
  if (state.slashMenuItems.length === 0) {
    return;
  }
  const total = state.slashMenuItems.length;
  state.slashMenuActiveIndex = (state.slashMenuActiveIndex + offset + total) % total;
  updateSlashCommandMenu();
}

export function applySlashMenuItem(index: number): boolean {
  const item = state.slashMenuItems[index];
  if (!item) {
    return false;
  }

  messageInputEl.value = `${item.insertText} `;
  messageInputEl.style.height = 'auto';
  messageInputEl.style.height = `${messageInputEl.scrollHeight}px`;
  hideSlashCommandMenu();
  messageInputEl.focus();
  return true;
}

export function handleSlashMenuKeydown(event: KeyboardEvent): boolean {
  if (!state.slashMenuVisible) {
    return false;
  }

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    moveSlashMenuSelection(1);
    return true;
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault();
    moveSlashMenuSelection(-1);
    return true;
  }

  if (event.key === 'Escape') {
    event.preventDefault();
    hideSlashCommandMenu();
    return true;
  }

  if (event.key === 'Tab') {
    event.preventDefault();
    if (state.slashMenuItems.length === 0) {
      hideSlashCommandMenu();
      return true;
    }
    return applySlashMenuItem(state.slashMenuActiveIndex);
  }

  if (event.key === 'Enter' && !event.shiftKey) {
    if (state.slashMenuItems.length === 0) {
      hideSlashCommandMenu();
      return false;
    }
    event.preventDefault();
    return applySlashMenuItem(state.slashMenuActiveIndex);
  }

  return false;
}

// 设置事件监听
export function setupEventListeners() {
  console.log('Setting up event listeners...');

  themeToggleBtnEl.addEventListener('click', () => {
    state.currentTheme = THEME_CYCLE[state.currentTheme];
    applyTheme(state.currentTheme);
    localStorage.setItem(THEME_STORAGE_KEY, state.currentTheme);
  });

  addAgentBtnEl.addEventListener('click', () => {
    addAgentModalEl.classList.remove('hidden');
  });

  closeModalBtnEl.addEventListener('click', hideModal);
  cancelAddAgentBtnEl.addEventListener('click', hideModal);
  closeArtifactPreviewBtnEl.addEventListener('click', closeArtifactPreviewModal);
  artifactPreviewModalEl.addEventListener('click', (event) => {
    if (event.target === artifactPreviewModalEl) {
      closeArtifactPreviewModal();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') {
      return;
    }
    if (!artifactPreviewModalEl.classList.contains('hidden')) {
      closeArtifactPreviewModal();
      return;
    }
    if (!renameAgentModalEl.classList.contains('hidden')) {
      hideRenameAgentModal();
    }
  });

  confirmAddAgentBtnEl.addEventListener('click', async () => {
    const nameInput = document.getElementById('agent-name') as HTMLInputElement;
    const pathInput = document.getElementById('iflow-path') as HTMLInputElement;
    const workspaceInput = document.getElementById('workspace-path') as HTMLInputElement;

    const name = nameInput.value.trim() || 'iFlow';
    const iflowPath = pathInput.value.trim() || 'iflow';
    const workspacePath = workspaceInput.value.trim() || '/Users/chenweilong/playground';

    hideModal();
    await addAgent(name, iflowPath, workspacePath);

    nameInput.value = 'iFlow';
    pathInput.value = '';
  });

  closeRenameAgentModalBtnEl.addEventListener('click', hideRenameAgentModal);
  cancelRenameAgentBtnEl.addEventListener('click', hideRenameAgentModal);
  renameAgentModalEl.addEventListener('click', (event) => {
    if (event.target === renameAgentModalEl) {
      hideRenameAgentModal();
    }
  });
  confirmRenameAgentBtnEl.addEventListener('click', () => {
    void submitRenameAgent();
  });
  renameAgentNameInputEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void submitRenameAgent();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      hideRenameAgentModal();
    }
  });

  messageInputEl.addEventListener('keydown', (e) => {
    if (handleSlashMenuKeydown(e)) {
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  });

  messageInputEl.addEventListener('input', () => {
    messageInputEl.style.height = 'auto';
    messageInputEl.style.height = `${messageInputEl.scrollHeight}px`;
    updateSlashCommandMenu();
  });

  messageInputEl.addEventListener('blur', () => {
    window.setTimeout(() => {
      hideSlashCommandMenu();
    }, 120);
  });

  slashCommandMenuEl.addEventListener('mousedown', (event) => {
    const target = event.target as HTMLElement;
    const itemEl = target.closest('.slash-command-item[data-index]') as HTMLElement | null;
    if (!itemEl || !itemEl.dataset.index) {
      return;
    }

    event.preventDefault();
    const index = Number(itemEl.dataset.index);
    if (Number.isNaN(index)) {
      return;
    }

    applySlashMenuItem(index);
  });

  sendBtnEl.addEventListener('click', () => {
    if (isCurrentAgentBusy()) {
      void stopCurrentMessage();
      return;
    }
    void sendMessage();
  });
  chatMessagesEl.addEventListener('click', onChatMessagesClick);
  toolCallsListEl.addEventListener('click', onToolCallsClick);
  currentAgentModelBtnEl.addEventListener('click', (event) => {
    event.stopPropagation();
    void toggleCurrentAgentModelMenu();
  });
  currentAgentModelMenuEl.addEventListener('click', (event) => {
    void onCurrentAgentModelMenuClick(event);
  });
  document.addEventListener('click', onDocumentClick);
  agentListEl.addEventListener('click', onAgentListClick);
  sessionListEl.addEventListener('click', onSessionListClick);

  newSessionBtnEl.addEventListener('click', startNewSession);
  clearChatBtnEl.addEventListener('click', clearChat);
  closeToolPanelBtnEl.addEventListener('click', () => {
    toolCallsPanelEl.classList.add('hidden');
  });

  clearAllSessionsBtnEl.addEventListener('click', () => {
    void clearCurrentAgentSessions();
  });
}

export function hideModal() {
  addAgentModalEl.classList.add('hidden');
}

export function onDocumentClick(event: MouseEvent) {
  if (!state.modelSelectorOpen) {
    return;
  }
  const target = event.target as HTMLElement;
  if (
    target.closest('#current-agent-model-btn') ||
    target.closest('#current-agent-model-menu')
  ) {
    return;
  }
  closeCurrentAgentModelMenu();
}

export function canUseConversationQuickAction(): boolean {
  if (!state.currentAgentId || !state.currentSessionId) {
    return false;
  }
  const agent = state.agents.find((item) => item.id === state.currentAgentId);
  return Boolean(agent && agent.status === 'connected' && !state.inflightSessionByAgent[agent.id]);
}

export async function sendPresetMessage(content: string, blockedHint: string) {
  const text = content.trim();
  if (!text) {
    return;
  }

  if (!canUseConversationQuickAction()) {
    showError(blockedHint);
    return;
  }

  messageInputEl.value = text;
  messageInputEl.style.height = 'auto';
  messageInputEl.style.height = `${messageInputEl.scrollHeight}px`;
  hideSlashCommandMenu();
  await sendMessage();
}

export async function sendQuickReply(text: string) {
  await sendPresetMessage(text, '当前无法快捷发送，请等待回复完成或检查连接状态');
}

export async function retryUserMessageById(messageId: string) {
  const userMessage = state.messages.find((item) => item.id === messageId && item.role === 'user');
  if (!userMessage) {
    showError('未找到可重试的问题');
    return;
  }
  await sendPresetMessage(userMessage.content, '当前无法重试，请等待回复完成或检查连接状态');
}

export function stripArtifactPathPunctuation(token: string): string {
  return token
    .replace(/^[`"'([{<\u300c\u300e\u3010\u3014\u2018\u201c]+/, '')
    .replace(/[`"')\]}>.,;:!?\u3002\uff0c\uff1b\uff1a\uff01\uff1f\u3001\u300d\u300f\u3011\u3015\u2019\u201d]+$/, '')
    .trim();
}

export function normalizeArtifactPathInput(raw: string): string {
  let candidate = raw.trim();
  if (/^@(?=\/|\.{1,2}\/|~\/|[A-Za-z]:[\\/])/.test(candidate)) {
    candidate = candidate.slice(1);
  }
  return candidate;
}

export function normalizeArtifactPathCandidate(raw: string): string | null {
  let candidate = stripArtifactPathPunctuation(raw);
  if (!candidate) {
    return null;
  }

  candidate = candidate
    .replace(/\\\//g, '/')
    .replace(/^[`"']?(?:file_path|absolute_path|path)[`"']?\s*[:=]\s*/i, '');
  candidate = stripArtifactPathPunctuation(candidate);
  if (!candidate) {
    return null;
  }

  candidate = candidate.replace(/^\[diff\]\s*/i, '').trim();
  if (!candidate) {
    return null;
  }
  candidate = normalizeArtifactPathInput(candidate);
  if (!candidate) {
    return null;
  }

  if (!HTML_ARTIFACT_PATH_PATTERN.test(candidate)) {
    return null;
  }

  if (/^https?:\/\//i.test(candidate)) {
    return null;
  }

  return candidate;
}

export function extractHtmlArtifactPaths(text: string): string[] {
  if (!text.trim()) {
    return [];
  }

  const unique = new Set<string>();
  const addCandidate = (value: string) => {
    const normalized = normalizeArtifactPathCandidate(value);
    if (normalized) {
      unique.add(normalized);
    }
  };

  HTML_ARTIFACT_JSON_PATH_PATTERN.lastIndex = 0;
  let jsonMatch = HTML_ARTIFACT_JSON_PATH_PATTERN.exec(text);
  while (jsonMatch) {
    addCandidate(jsonMatch[1]);
    jsonMatch = HTML_ARTIFACT_JSON_PATH_PATTERN.exec(text);
  }

  HTML_ARTIFACT_GENERIC_PATH_PATTERN.lastIndex = 0;
  let genericMatch = HTML_ARTIFACT_GENERIC_PATH_PATTERN.exec(text);
  while (genericMatch) {
    addCandidate(genericMatch[0]);
    genericMatch = HTML_ARTIFACT_GENERIC_PATH_PATTERN.exec(text);
  }

  HTML_ARTIFACT_BARE_FILE_PATTERN.lastIndex = 0;
  let bareMatch = HTML_ARTIFACT_BARE_FILE_PATTERN.exec(text);
  while (bareMatch) {
    const matchStart = bareMatch.index;
    if (matchStart > 0) {
      const previousChar = text[matchStart - 1];
      if (previousChar === '/' || previousChar === '\\') {
        bareMatch = HTML_ARTIFACT_BARE_FILE_PATTERN.exec(text);
        continue;
      }
    }
    addCandidate(bareMatch[0]);
    bareMatch = HTML_ARTIFACT_BARE_FILE_PATTERN.exec(text);
  }

  const markdownLinkPattern = /\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let markdownMatch = markdownLinkPattern.exec(text);
  while (markdownMatch) {
    addCandidate(markdownMatch[1]);
    markdownMatch = markdownLinkPattern.exec(text);
  }

  const tokens = text.split(/\s+/);
  for (const token of tokens) {
    addCandidate(token);
  }

  return Array.from(unique).slice(0, 6);
}

export function artifactFileName(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

export function renderArtifactPreviewActions(text: string): string {
  const paths = extractHtmlArtifactPaths(text);
  if (paths.length === 0) {
    return '';
  }

  return `
    <div class="artifact-actions">
      ${paths
        .map((path) => {
          const encodedPath = encodeURIComponent(path);
          const title = escapeHtml(path);
          const fileName = escapeHtml(artifactFileName(path));
          return `
            <button
              type="button"
              class="artifact-preview-btn"
              data-artifact-preview-path="${encodedPath}"
              title="${title}"
            >
              预览 HTML · ${fileName}
            </button>
          `;
        })
        .join('')}
    </div>
  `;
}

export function decodeArtifactPath(encodedPath: string): string | null {
  try {
    return decodeURIComponent(encodedPath);
  } catch {
    return null;
  }
}

export function renderArtifactPlaceholder(title: string, description: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #e6edf3; display: grid; place-items: center; min-height: 100vh; }
    .box { padding: 20px 24px; border: 1px solid #30363d; border-radius: 10px; background: #161b22; max-width: 680px; }
    h1 { margin: 0 0 10px; font-size: 16px; }
    p { margin: 0; color: #9ba7b4; line-height: 1.6; font-size: 13px; }
  </style>
</head>
<body>
  <div class="box">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(description)}</p>
  </div>
</body>
</html>`;
}

export function buildArtifactPreviewCacheKey(agentId: string, normalizedPath: string): string {
  return `${agentId}::${normalizedPath}`;
}

export function touchArtifactCacheKey(key: string) {
  const existingIndex = state.artifactPreviewCacheOrder.indexOf(key);
  if (existingIndex >= 0) {
    state.artifactPreviewCacheOrder.splice(existingIndex, 1);
  }
  state.artifactPreviewCacheOrder.push(key);
}

export function setArtifactPreviewCache(key: string, html: string) {
  state.artifactPreviewCacheByKey.set(key, html);
  touchArtifactCacheKey(key);

  while (state.artifactPreviewCacheOrder.length > ARTIFACT_PREVIEW_CACHE_LIMIT) {
    const oldestKey = state.artifactPreviewCacheOrder.shift();
    if (!oldestKey) {
      continue;
    }
    state.artifactPreviewCacheByKey.delete(oldestKey);
    if (state.artifactPreviewLastKey === oldestKey) {
      state.artifactPreviewLastKey = null;
    }
  }
}

export function getArtifactPreviewCache(key: string): string | null {
  const payload = state.artifactPreviewCacheByKey.get(key);
  if (!payload) {
    return null;
  }
  touchArtifactCacheKey(key);
  return payload;
}

export function encodeArtifactPreviewCacheEntry(mode: 'url' | 'html', value: string): string {
  return `${mode === 'url' ? ARTIFACT_PREVIEW_CACHE_URL_PREFIX : ARTIFACT_PREVIEW_CACHE_HTML_PREFIX}${value}`;
}

export function decodeArtifactPreviewCacheEntry(payload: string): { mode: 'url' | 'html'; value: string } | null {
  if (payload.startsWith(ARTIFACT_PREVIEW_CACHE_URL_PREFIX)) {
    return {
      mode: 'url',
      value: payload.slice(ARTIFACT_PREVIEW_CACHE_URL_PREFIX.length),
    };
  }
  if (payload.startsWith(ARTIFACT_PREVIEW_CACHE_HTML_PREFIX)) {
    return {
      mode: 'html',
      value: payload.slice(ARTIFACT_PREVIEW_CACHE_HTML_PREFIX.length),
    };
  }
  return null;
}

export function applyArtifactPreviewContent(mode: 'url' | 'html', value: string) {
  if (mode === 'url') {
    artifactPreviewFrameEl.srcdoc = '';
    artifactPreviewFrameEl.src = value;
    return;
  }

  artifactPreviewFrameEl.removeAttribute('src');
  artifactPreviewFrameEl.srcdoc = value;
}

export function createArtifactPreviewTimeoutPromise(): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    window.setTimeout(() => {
      reject(new Error(`读取超时（>${ARTIFACT_PREVIEW_READ_TIMEOUT_MS / 1000}s）`));
    }, ARTIFACT_PREVIEW_READ_TIMEOUT_MS);
  });
}

export function shouldIgnoreArtifactResponse(requestToken: number, expectedPath: string): boolean {
  if (state.artifactPreviewRequestToken === requestToken) {
    return false;
  }
  if (artifactPreviewModalEl.classList.contains('hidden')) {
    return true;
  }
  const currentPath = artifactPreviewPathEl.textContent?.trim() || '';
  return currentPath !== expectedPath;
}

export function clearArtifactPreviewCacheForAgent(agentId: string) {
  const prefix = `${agentId}::`;
  for (const key of Array.from(state.artifactPreviewCacheByKey.keys())) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    state.artifactPreviewCacheByKey.delete(key);
    state.artifactPreviewCacheOrder = state.artifactPreviewCacheOrder.filter((item) => item !== key);
    if (state.artifactPreviewLastKey === key) {
      state.artifactPreviewLastKey = null;
    }
  }
}

export function warmUpArtifactPreviewFrame() {
  if (artifactPreviewFrameEl.dataset.warmed === '1') {
    return;
  }
  artifactPreviewFrameEl.srcdoc = renderArtifactPlaceholder('HTML 预览', '预览容器已就绪');
  artifactPreviewFrameEl.dataset.warmed = '1';
}

export function closeArtifactPreviewModal() {
  state.artifactPreviewRequestToken += 1;
  artifactPreviewModalEl.classList.add('hidden');
  artifactPreviewPathEl.textContent = '';
}

export async function openArtifactPreview(path: string) {
  const agent = state.currentAgentId ? state.agents.find((item) => item.id === state.currentAgentId) : null;
  if (!agent || agent.status !== 'connected') {
    showError('请先连接当前 Agent，再预览 HTML Artifact');
    return;
  }

  const normalizedPath = normalizeArtifactPathInput(path.trim());
  if (!normalizedPath) {
    showError('无效的 Artifact 路径');
    return;
  }

  const cacheKey = buildArtifactPreviewCacheKey(agent.id, normalizedPath);
  artifactPreviewModalEl.classList.remove('hidden');
  artifactPreviewPathEl.textContent = normalizedPath;

  if (state.artifactPreviewLastKey === cacheKey) {
    return;
  }

  const cachedHtml = getArtifactPreviewCache(cacheKey);
  if (cachedHtml) {
    const cachedEntry = decodeArtifactPreviewCacheEntry(cachedHtml);
    if (cachedEntry) {
      applyArtifactPreviewContent(cachedEntry.mode, cachedEntry.value);
      state.artifactPreviewLastKey = cacheKey;
      return;
    }
    state.artifactPreviewCacheByKey.delete(cacheKey);
  }

  applyArtifactPreviewContent(
    'html',
    renderArtifactPlaceholder(
      '正在加载 HTML 预览',
      '正在读取文件内容，请稍候...'
    )
  );

  const requestToken = state.artifactPreviewRequestToken + 1;
  state.artifactPreviewRequestToken = requestToken;
  const hardTimeoutId = window.setTimeout(() => {
    if (shouldIgnoreArtifactResponse(requestToken, normalizedPath)) {
      return;
    }
    if (state.artifactPreviewLastKey === cacheKey) {
      return;
    }
    state.artifactPreviewLastKey = null;
    applyArtifactPreviewContent(
      'html',
      renderArtifactPlaceholder(
        'HTML 预览失败',
        `读取超时（>${ARTIFACT_PREVIEW_READ_TIMEOUT_MS / 1000}s）`
      )
    );
  }, ARTIFACT_PREVIEW_READ_TIMEOUT_MS + 1000);

  let readError: unknown = null;
  try {
    const html = await Promise.race([
      readHtmlArtifact(agent.id, normalizedPath),
      createArtifactPreviewTimeoutPromise(),
    ]);

    if (shouldIgnoreArtifactResponse(requestToken, normalizedPath)) {
      return;
    }

    setArtifactPreviewCache(cacheKey, encodeArtifactPreviewCacheEntry('html', html));
    state.artifactPreviewLastKey = cacheKey;
    applyArtifactPreviewContent('html', html);
    return;
  } catch (error) {
    readError = error;
  }

  try {
    const absolutePath = await Promise.race([
      resolveHtmlArtifactPath(agent.id, normalizedPath),
      createArtifactPreviewTimeoutPromise(),
    ]);

    if (shouldIgnoreArtifactResponse(requestToken, normalizedPath)) {
      return;
    }

    const assetUrl = convertFileSrc(absolutePath);
    setArtifactPreviewCache(cacheKey, encodeArtifactPreviewCacheEntry('url', assetUrl));
    state.artifactPreviewLastKey = cacheKey;
    applyArtifactPreviewContent('url', assetUrl);
  } catch (resolveError) {
    if (shouldIgnoreArtifactResponse(requestToken, normalizedPath)) {
      return;
    }
    if (!readError) {
      return;
    }

    state.artifactPreviewLastKey = null;
    const readMessage = readError instanceof Error ? readError.message : String(readError);
    const resolveMessage = resolveError instanceof Error ? resolveError.message : String(resolveError);
    applyArtifactPreviewContent(
      'html',
      renderArtifactPlaceholder(
        'HTML 预览失败',
        `内容读取失败：${readMessage}\nURL 预览失败：${resolveMessage}`
      )
    );
  } finally {
    window.clearTimeout(hardTimeoutId);
  }
}

export function onChatMessagesClick(event: MouseEvent) {
  const target = event.target as HTMLElement;
  const artifactBtn = target.closest('button[data-artifact-preview-path]') as HTMLButtonElement | null;
  if (artifactBtn?.dataset.artifactPreviewPath) {
    const path = decodeArtifactPath(artifactBtn.dataset.artifactPreviewPath);
    if (path) {
      event.preventDefault();
      void openArtifactPreview(path);
    }
    return;
  }

  const quickReplyBtn = target.closest('button[data-quick-reply]') as HTMLButtonElement | null;
  if (quickReplyBtn) {
    const reply = quickReplyBtn.dataset.quickReply;
    if (!reply) {
      return;
    }

    event.preventDefault();
    void sendQuickReply(reply);
    return;
  }

  const retryBtn = target.closest('button[data-retry-message-id]') as HTMLButtonElement | null;
  if (!retryBtn) {
    return;
  }

  const retryMessageId = retryBtn.dataset.retryMessageId;
  if (!retryMessageId) {
    return;
  }

  event.preventDefault();
  void retryUserMessageById(retryMessageId);
}

export function onToolCallsClick(event: MouseEvent) {
  const target = event.target as HTMLElement;
  const artifactBtn = target.closest('button[data-artifact-preview-path]') as HTMLButtonElement | null;
  if (!artifactBtn?.dataset.artifactPreviewPath) {
    return;
  }

  const path = decodeArtifactPath(artifactBtn.dataset.artifactPreviewPath);
  if (!path) {
    return;
  }

  event.preventDefault();
  void openArtifactPreview(path);
}

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
    showToolCalls(merged);
  }
}

export function resetToolCallsForAgent(agentId: string) {
  delete state.toolCallsByAgent[agentId];
  if (agentId === state.currentAgentId) {
    toolCallsListEl.innerHTML = '';
    toolCallsPanelEl.classList.add('hidden');
  }
}

export function onAgentListClick(event: MouseEvent) {
  const target = event.target as HTMLElement;
  const actionBtn = target.closest('button[data-action]') as HTMLButtonElement | null;
  if (actionBtn) {
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

export function onSessionListClick(event: MouseEvent) {
  const target = event.target as HTMLElement;
  const actionBtn = target.closest('button[data-action]') as HTMLButtonElement | null;
  if (actionBtn) {
    event.stopPropagation();
    const action = actionBtn.dataset.action;
    const sessionId = actionBtn.dataset.sessionId;
    if (!sessionId) {
      return;
    }
    if (action === 'delete-session') {
      void deleteSession(sessionId);
      return;
    }
  }

  const sessionItem = target.closest('.session-item[data-session-id]') as HTMLDivElement | null;
  if (!sessionItem?.dataset.sessionId) {
    return;
  }
  selectSession(sessionItem.dataset.sessionId);
}

export async function clearCurrentAgentSessions() {
  if (!state.currentAgentId) {
    showError('请先选择一个 Agent');
    return;
  }
  const agent = state.agents.find((item) => item.id === state.currentAgentId);
  if (!agent) {
    showError('当前 Agent 不存在');
    return;
  }
  if (!confirm(`确定要清除当前 Agent（${agent.workspacePath}）的所有会话记录吗？`)) {
    return;
  }

  try {
    await clearIflowHistorySessions(agent.workspacePath);
  } catch (error) {
    console.error('Clear iFlow history sessions error:', error);
    showError(`清除磁盘历史记录失败: ${String(error)}`);
    return;
  }

  const removedSessions = state.sessionsByAgent[state.currentAgentId] || [];
  for (const session of removedSessions) {
    delete state.messagesBySession[session.id];
  }
  state.sessionsByAgent[state.currentAgentId] = [];
  state.currentSessionId = null;
  state.messages = [];
  delete state.inflightSessionByAgent[state.currentAgentId];
  clearArtifactPreviewCacheForAgent(state.currentAgentId);
  closeArtifactPreviewModal();

  ensureAgentHasSessions(state.currentAgentId);
  const nextSessions = getSessionsForAgent(state.currentAgentId);
  if (nextSessions.length > 0) {
    state.currentSessionId = nextSessions[0].id;
    state.messages = getMessagesForSession(state.currentSessionId);
  }

  await saveSessions();
  await saveSessionMessages();

  renderSessionList();
  renderMessages();
  refreshComposerState();
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

export function parseDateOrNow(raw: string | Date): Date {
  if (raw instanceof Date) {
    return raw;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export function splitThinkTaggedContent(rawContent: string): { thoughts: string[]; answer: string } {
  const thoughts: string[] = [];
  const thinkTagPattern = /<\s*think\s*>([\s\S]*?)<\s*\/\s*think\s*>/gi;

  const answer = rawContent
    .replace(thinkTagPattern, (_full, thinkPart: string) => {
      const thought = String(thinkPart || '').trim();
      if (thought) {
        thoughts.push(thought);
      }
      return '\n';
    })
    .trim();

  return { thoughts, answer };
}

export function expandIflowHistoryMessageRecord(item: IflowHistoryMessageRecord): Message[] {
  const baseTimestamp = parseDateOrNow(item.timestamp);
  const baseId = String(item.id || '').trim() || `history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const content = String(item.content || '').trim();
  if (!content) {
    return [];
  }

  if (item.role === 'user') {
    return [
      {
        id: baseId,
        role: 'user',
        content,
        timestamp: baseTimestamp,
      },
    ];
  }

  const { thoughts, answer } = splitThinkTaggedContent(content);
  const expanded: Message[] = thoughts.map((thought, index) => ({
    id: `${baseId}-think-${index}`,
    role: 'thought',
    content: thought,
    timestamp: baseTimestamp,
  }));

  if (answer) {
    expanded.push({
      id: baseId,
      role: 'assistant',
      content: answer,
      timestamp: baseTimestamp,
    });
  } else if (expanded.length === 0) {
    expanded.push({
      id: baseId,
      role: 'assistant',
      content,
      timestamp: baseTimestamp,
    });
  }

  return expanded;
}

export function buildHistorySessionLocalId(agentId: string, acpSessionId: string): string {
  return `iflowlog-${agentId}-${acpSessionId}`;
}

export function dedupeSessionsByIdentity(sessionList: Session[]): Session[] {
  const ordered = [...sessionList].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  const deduped: Session[] = [];
  const seen = new Set<string>();

  for (const session of ordered) {
    const acpKey =
      typeof session.acpSessionId === 'string' && session.acpSessionId.trim().length > 0
        ? `acp:${session.acpSessionId.trim()}`
        : null;
    const key = acpKey || `id:${session.id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(session);
  }

  return deduped;
}

export async function syncIflowHistorySessions(agent: Agent): Promise<void> {
  if (agent.status !== 'connected') {
    return;
  }

  try {
    const histories = await listIflowHistorySessions(agent.workspacePath);
    const historyList = Array.isArray(histories) ? histories : [];

    ensureAgentHasSessions(agent.id);
    const sessionList = state.sessionsByAgent[agent.id] || [];
    let changed = false;
    let messagesChanged = false;
    const liveHistorySessionIds = new Set<string>();

    for (const history of historyList) {
      const acpSessionId = String(history.sessionId || '').trim();
      if (!acpSessionId) {
        continue;
      }
      liveHistorySessionIds.add(acpSessionId);

      const expectedHistorySessionId = buildHistorySessionLocalId(agent.id, acpSessionId);
      const existing = sessionList.find(
        (item) => item.acpSessionId === acpSessionId || item.id === expectedHistorySessionId
      );
      if (existing) {
        if (
          !existing.acpSessionId ||
          (existing.source === 'iflow-log' && !isIflowHistorySessionId(existing.acpSessionId))
        ) {
          existing.acpSessionId = acpSessionId;
          changed = true;
        }
        if (existing.source !== 'iflow-log' && existing.id === expectedHistorySessionId) {
          existing.source = 'iflow-log';
          changed = true;
        }
        const nextUpdatedAt = parseDateOrNow(history.updatedAt);
        if (nextUpdatedAt.getTime() > existing.updatedAt.getTime()) {
          existing.updatedAt = nextUpdatedAt;
          changed = true;
        }
        if (existing.source === 'iflow-log' && history.title && existing.title !== history.title) {
          existing.title = history.title;
          changed = true;
        }
        if (
          typeof history.messageCount === 'number' &&
          history.messageCount >= 0 &&
          existing.messageCountHint !== history.messageCount
        ) {
          existing.messageCountHint = history.messageCount;
          changed = true;
        }
        continue;
      }

      const imported: Session = {
        id: buildHistorySessionLocalId(agent.id, acpSessionId),
        agentId: agent.id,
        title: (history.title || acpSessionId).trim(),
        createdAt: parseDateOrNow(history.createdAt),
        updatedAt: parseDateOrNow(history.updatedAt),
        acpSessionId,
        source: 'iflow-log',
        messageCountHint:
          typeof history.messageCount === 'number' && history.messageCount >= 0
            ? history.messageCount
            : undefined,
      };
      sessionList.push(imported);
      changed = true;
    }

    const staleHistorySessions = sessionList.filter((item) => {
      if (item.source !== 'iflow-log') {
        return false;
      }

      const normalizedSessionId =
        item.acpSessionId?.trim() || inferLegacyHistorySessionId(agent.id, item.id) || '';
      if (!normalizedSessionId) {
        return true;
      }

      return !liveHistorySessionIds.has(normalizedSessionId);
    });
    if (staleHistorySessions.length > 0) {
      const staleSessionIds = new Set(staleHistorySessions.map((item) => item.id));
      state.sessionsByAgent[agent.id] = sessionList.filter((item) => !staleSessionIds.has(item.id));
      for (const staleSession of staleHistorySessions) {
        delete state.messagesBySession[staleSession.id];
      }
      changed = true;
      messagesChanged = true;
    } else {
      state.sessionsByAgent[agent.id] = sessionList;
    }

    const normalizedSessionList = state.sessionsByAgent[agent.id] || [];
    const dedupedSessions = dedupeSessionsByIdentity(normalizedSessionList);
    if (dedupedSessions.length !== normalizedSessionList.length) {
      state.sessionsByAgent[agent.id] = dedupedSessions;
      changed = true;
      const liveIds = new Set(dedupedSessions.map((item) => item.id));
      for (const sessionId of Object.keys(state.messagesBySession)) {
        if (!liveIds.has(sessionId) && sessionId.startsWith(`iflowlog-${agent.id}-`)) {
          delete state.messagesBySession[sessionId];
          messagesChanged = true;
        }
      }
    }

    if ((state.sessionsByAgent[agent.id] || []).length === 0) {
      ensureAgentHasSessions(agent.id);
      changed = true;
    }

    if (!changed) {
      return;
    }

    await saveSessions();
    if (messagesChanged) {
      await saveSessionMessages();
    }

    if (state.currentAgentId === agent.id) {
      const activeSessions = getSessionsForAgent(agent.id);
      const currentStillExists =
        Boolean(state.currentSessionId) && activeSessions.some((item) => item.id === state.currentSessionId);
      if (!currentStillExists) {
        state.currentSessionId = null;
        state.messages = [];
        const fallbackSession = activeSessions[0];
        if (fallbackSession) {
          selectSession(fallbackSession.id);
        } else {
          renderSessionList();
          renderMessages();
          refreshComposerState();
        }
      } else {
        renderSessionList();
        refreshComposerState();
      }
    }
  } catch (error) {
    console.error('Sync iFlow history sessions error:', error);
  }
}

export async function loadIflowHistoryMessagesForSession(session: Session): Promise<void> {
  let effectiveSessionId = session.acpSessionId?.trim() || '';
  if (!isIflowHistorySessionId(effectiveSessionId)) {
    const inferred = inferLegacyHistorySessionId(session.agentId, session.id);
    if (inferred && isIflowHistorySessionId(inferred)) {
      effectiveSessionId = inferred;
      if (session.acpSessionId !== inferred) {
        session.acpSessionId = inferred;
        void saveSessions();
        if (state.currentAgentId === session.agentId) {
          renderSessionList();
        }
      }
    }
  }
  if (!isIflowHistorySessionId(effectiveSessionId)) {
    if (state.currentSessionId === session.id) {
      state.messages = [
        {
          id: `msg-${Date.now()}-history-invalid-session-id`,
          role: 'system',
          content: '该历史会话缺少有效的 sessionId，无法加载历史内容',
          timestamp: new Date(),
        },
      ];
      renderMessages();
      refreshComposerState();
    }
    return;
  }
  const agent = state.agents.find((item) => item.id === session.agentId);
  if (!agent) {
    return;
  }

  try {
    const rawMessages = await loadIflowHistoryMessages(agent.workspacePath, effectiveSessionId);

    const normalized: Message[] = (Array.isArray(rawMessages) ? rawMessages : [])
      .flatMap((item) => expandIflowHistoryMessageRecord(item))
      .filter((item) => item.content.trim().length > 0);

    state.messagesBySession[session.id] = normalized;
    if (session.source === 'iflow-log') {
      session.messageCountHint = normalized.filter(
        (item) => item.role === 'user' || item.role === 'assistant'
      ).length;
    }

    if (state.currentSessionId === session.id) {
      state.messages = normalized;
      renderMessages();
      scrollToBottom();
      refreshComposerState();
    } else {
      renderSessionList();
    }
  } catch (error) {
    console.error('Load iFlow history messages error:', error);
    const detail = String(error);
    const isMissingHistoryFile =
      session.source === 'iflow-log' && detail.includes('Session file not found for');

    if (isMissingHistoryFile) {
      const scopedSessions = state.sessionsByAgent[session.agentId] || [];
      const filtered = scopedSessions.filter((item) => item.id !== session.id);
      if (filtered.length !== scopedSessions.length) {
        state.sessionsByAgent[session.agentId] = filtered;
        delete state.messagesBySession[session.id];

        if (state.sessionsByAgent[session.agentId].length === 0) {
          const fallback = createSession(session.agentId, '默认会话');
          state.sessionsByAgent[session.agentId].push(fallback);
          state.messagesBySession[fallback.id] = [];
        }

        await saveSessions();
        await saveSessionMessages();
      }

      if (state.currentAgentId === session.agentId) {
        const scoped = getSessionsForAgent(session.agentId);
        const currentStillExists =
          Boolean(state.currentSessionId) && scoped.some((item) => item.id === state.currentSessionId);
        if (!currentStillExists) {
          state.currentSessionId = null;
          state.messages = [];
          const fallbackSession = scoped[0];
          if (fallbackSession) {
            selectSession(fallbackSession.id);
          } else {
            renderSessionList();
            renderMessages();
            refreshComposerState();
          }
        } else {
          renderSessionList();
        }
      }

      showError('该历史会话文件已不存在，已从列表移除');
      return;
    }

    if (state.currentSessionId === session.id) {
      state.messages = [
        {
          id: `msg-${Date.now()}-history-load-failed`,
          role: 'system',
          content: `加载历史会话失败：${detail}`,
          timestamp: new Date(),
        },
      ];
      renderMessages();
      refreshComposerState();
      showError(`加载历史会话失败: ${detail}`);
    }
  }
}

// 选择 Agent
export function selectAgent(agentId: string) {
  closeCurrentAgentModelMenu();
  if (state.currentAgentId && state.currentAgentId !== agentId) {
    closeArtifactPreviewModal();
  }
  state.currentAgentId = agentId;
  const agent = state.agents.find((a) => a.id === agentId);
  if (!agent) {
    updateCurrentAgentModelUI();
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
    renderMessages();
    renderSessionList();
  }

  renderAgentList();
  updateCurrentAgentModelUI();
  updateConnectionStatus(isConnected);
  const existingToolCalls = state.toolCallsByAgent[agentId] || [];
  if (existingToolCalls.length > 0) {
    showToolCalls(existingToolCalls);
  } else {
    toolCallsPanelEl.classList.add('hidden');
  }
  refreshComposerState();
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
  if (!confirm('确定要删除这个 Agent 吗？')) {
    return;
  }

  const agent = state.agents.find((a) => a.id === agentId);
  if (agent?.status === 'connected') {
    try {
      await disconnectAgent(agentId);
    } catch (e) {
      console.error('断开连接失败:', e);
    }
  }

  state.agents = state.agents.filter((a) => a.id !== agentId);
  if (state.modelSwitchingAgentId === agentId) {
    state.modelSwitchingAgentId = null;
  }
  delete state.inflightSessionByAgent[agentId];
  delete state.registryByAgent[agentId];
  delete state.toolCallsByAgent[agentId];
  delete state.modelOptionsCacheByAgent[agentId];
  clearArtifactPreviewCacheForAgent(agentId);

  const removedSessions = state.sessionsByAgent[agentId] || [];
  delete state.sessionsByAgent[agentId];
  for (const session of removedSessions) {
    delete state.messagesBySession[session.id];
  }

  if (state.currentAgentId === agentId) {
    closeCurrentAgentModelMenu();
    closeArtifactPreviewModal();
    state.currentAgentId = null;
    state.currentSessionId = null;
    state.messages = [];
    renderMessages();
    toolCallsPanelEl.classList.add('hidden');
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
  refreshComposerState();
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
}

export function renderSessionList() {
  if (!state.currentAgentId) {
    sessionListEl.innerHTML = '<div class="session-empty">选择 Agent 后显示会话历史</div>';
    return;
  }

  const sessionList = getSessionsForAgent(state.currentAgentId);
  if (sessionList.length === 0) {
    sessionListEl.innerHTML = '<div class="session-empty">暂无会话，点击右上角「新建会话」</div>';
    return;
  }

  sessionListEl.innerHTML = sessionList
    .map((session) => {
      const loadedCount = (state.messagesBySession[session.id] || []).length;
      const messageCount = loadedCount > 0 ? loadedCount : session.messageCountHint || 0;
      return `
      <div class="session-item ${session.id === state.currentSessionId ? 'active' : ''}" data-session-id="${session.id}">
        <div class="session-row">
          <div class="session-title">${escapeHtml(session.title)}</div>
          <button class="btn-session-delete" data-action="delete-session" data-session-id="${session.id}" title="删除会话">×</button>
        </div>
        <div class="session-meta">${escapeHtml(formatSessionMeta(session.updatedAt, messageCount))}</div>
      </div>
    `;
    })
    .join('');
}

export async function deleteSession(sessionId: string) {
  if (!state.currentAgentId) {
    return;
  }
  const agent = state.agents.find((item) => item.id === state.currentAgentId);
  if (!agent) {
    return;
  }

  if (state.inflightSessionByAgent[state.currentAgentId] === sessionId) {
    showError('该会话正在回复中，暂时无法删除');
    return;
  }

  const currentSessions = state.sessionsByAgent[state.currentAgentId] || [];
  const targetSession = currentSessions.find((session) => session.id === sessionId);
  if (!targetSession) {
    return;
  }
  if (targetSession.source === 'iflow-log' && !targetSession.acpSessionId) {
    showError('历史会话缺少 sessionId，无法删除磁盘记录');
    return;
  }

  if (targetSession.acpSessionId) {
    try {
      const deleted = await deleteIflowHistorySession(agent.workspacePath, targetSession.acpSessionId);
      if (targetSession.source === 'iflow-log' && !deleted) {
        showError('未找到对应历史会话文件，未执行删除');
        return;
      }
    } catch (error) {
      console.error('Delete iFlow history session error:', error);
      showError(`删除磁盘历史记录失败: ${String(error)}`);
      return;
    }
  }

  state.sessionsByAgent[state.currentAgentId] = currentSessions.filter((session) => session.id !== sessionId);
  delete state.messagesBySession[sessionId];

  if (state.sessionsByAgent[state.currentAgentId].length === 0) {
    const fallback = createSession(state.currentAgentId, '默认会话');
    state.sessionsByAgent[state.currentAgentId].push(fallback);
    state.messagesBySession[fallback.id] = [];
  }

  const ordered = getSessionsForAgent(state.currentAgentId);
  const nextSessionId = ordered[0]?.id || null;

  if (state.currentSessionId === sessionId) {
    state.currentSessionId = null;
    state.messages = [];
    if (nextSessionId) {
      selectSession(nextSessionId);
    } else {
      renderMessages();
    }
  } else {
    renderSessionList();
  }

  await saveSessions();
  await saveSessionMessages();
  refreshComposerState();
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
  refreshComposerState();
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

// 发送消息
const MESSAGE_TIMEOUT_MS = 60000;

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

export function commitSessionMessages(sessionId: string, sessionMessages: Message[]) {
  state.messagesBySession[sessionId] = sessionMessages;
  touchSessionById(sessionId, sessionMessages);
  void saveSessionMessages();

  if (sessionId === state.currentSessionId) {
    state.messages = sessionMessages;
    renderMessages();
    scrollToBottom();
  } else {
    renderSessionList();
  }
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
  refreshComposerState();

  try {
    const result = await tauriSwitchAgentModel(agent.id, agent.iflowPath || 'iflow', agent.workspacePath, targetModel);

    if (!result.success) {
      throw new Error(result.error || '模型切换失败');
    }

    agent.status = 'connected';
    agent.port = result.port;
    agent.selectedModel = targetModel;
    await saveAgents();
    renderAgentList();
    if (state.currentAgentId === agent.id) {
      updateAgentStatusUI(agent.status);
    }
    refreshComposerState();
    return null;
  } catch (error) {
    console.error('Model switch error:', error);
    agent.status = 'error';
    await saveAgents();
    renderAgentList();
    if (state.currentAgentId === agent.id) {
      updateAgentStatusUI(agent.status);
    }
    refreshComposerState();
    return String(error);
  } finally {
    state.modelSwitchingAgentId = null;
    if (state.currentAgentId === agent.id) {
      updateCurrentAgentModelUI();
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
      content: `🧩 当前模型（客户端记录）：${currentAgentModelLabel(agent)}\n\n说明：自然语言询问“你是什么模型”可能不可靠。\n如需核验，请发送 /about，返回 JSON 中的 modelVersion 会自动同步到这里。`,
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

export async function sendMessage() {
  const content = messageInputEl.value.trim();
  const requestAgentId = state.currentAgentId;
  const requestSessionId = state.currentSessionId;
  if (!content || !requestAgentId || !requestSessionId || state.inflightSessionByAgent[requestAgentId]) {
    return;
  }

  resetToolCallsForAgent(requestAgentId);

  messageInputEl.value = '';
  messageInputEl.style.height = 'auto';
  hideSlashCommandMenu();

  const handledByLocalModelCommand = await handleLocalModelCommand(
    content,
    requestAgentId,
    requestSessionId
  );
  if (handledByLocalModelCommand) {
    return;
  }

  const sendingMessage: Message = {
    id: `msg-${Date.now()}-sending`,
    role: 'system',
    content: '📤 正在发送消息...',
    timestamp: new Date(),
  };
  state.messages.push(sendingMessage);
  renderMessages();
  scrollToBottom();

  const userMessage: Message = {
    id: `msg-${Date.now()}`,
    role: 'user',
    content,
    timestamp: new Date(),
  };
  state.messages.push(userMessage);
  touchCurrentSession();
  renderMessages();
  scrollToBottom();
  state.inflightSessionByAgent[requestAgentId] = requestSessionId;
  refreshComposerState();

  try {
    const targetSession = findSessionById(requestSessionId);
    if (targetSession && targetSession.source !== 'iflow-log' && !targetSession.acpSessionId) {
      targetSession.acpSessionId = generateAcpSessionId();
      void saveSessions();
    }
    await tauriSendMessage(requestAgentId, content, targetSession?.acpSessionId || null);

    state.messages = state.messages.filter((m) => m.id !== sendingMessage.id);
    renderMessages();

    if (state.inflightSessionByAgent[requestAgentId] !== requestSessionId) {
      return;
    }

    state.messageTimeout = window.setTimeout(() => {
      if (state.inflightSessionByAgent[requestAgentId] !== requestSessionId) {
        return;
      }
      const timeoutMessage: Message = {
        id: `msg-${Date.now()}-timeout`,
        role: 'system',
        content:
          '⏱️ 响应超时（60秒）。可能原因：\n1. iFlow 正在处理复杂任务\n2. 连接已断开\n3. iFlow 服务异常\n\n你可以：\n- 等待更长时间\n- 检查 iFlow 状态\n- 重新连接 Agent',
        timestamp: new Date(),
      };
      state.messages.push(timeoutMessage);
      renderMessages();

      delete state.inflightSessionByAgent[requestAgentId];
      refreshComposerState();
      showError('响应超时，请检查连接状态');
    }, MESSAGE_TIMEOUT_MS);
  } catch (error) {
    state.messages = state.messages.filter((m) => m.id !== sendingMessage.id);
    renderMessages();

    if (state.inflightSessionByAgent[requestAgentId] !== requestSessionId) {
      return;
    }

    showError(`发送失败: ${String(error)}`);
    delete state.inflightSessionByAgent[requestAgentId];
    refreshComposerState();
  }
}

export async function stopCurrentMessage() {
  const requestAgentId = state.currentAgentId;
  if (!requestAgentId || !state.inflightSessionByAgent[requestAgentId]) {
    return;
  }

  if (state.messageTimeout) {
    clearTimeout(state.messageTimeout);
    state.messageTimeout = null;
  }

  delete state.inflightSessionByAgent[requestAgentId];
  state.messages = state.messages.filter((m) => !m.id.includes('-sending') && !m.id.includes('-processing'));
  renderMessages();
  refreshComposerState();

  try {
    await stopMessage(requestAgentId);
  } catch (error) {
    showError(`停止请求失败: ${String(error)}`);
  }
}

// 显示工具调用
export function showToolCalls(toolCalls: ToolCall[]) {
  if (toolCalls.length === 0) {
    toolCallsPanelEl.classList.add('hidden');
    toolCallsListEl.innerHTML = '';
    return;
  }

  toolCallsListEl.innerHTML = [...toolCalls]
    .reverse()
    .map(
      (tc) => `
    <div class="tool-call-item">
      <div class="tool-name">${escapeHtml(tc.name)}</div>
      <div class="tool-status">状态: ${tc.status}</div>
      ${
        tc.arguments
          ? `<div class="tool-args">${escapeHtml(JSON.stringify(tc.arguments, null, 2))}</div>`
          : ''
      }
      ${tc.output ? `<div class="tool-output">${formatMessageContent(tc.output)}</div>` : ''}
      ${tc.output ? renderArtifactPreviewActions(tc.output) : ''}
    </div>
  `
    )
    .join('');

  toolCallsPanelEl.classList.remove('hidden');
}

// 渲染消息
export function renderMessages() {
  persistCurrentSessionMessages();
  let latestInteractiveMessageIndex = -1;
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    if (state.messages[i].role === 'assistant' || state.messages[i].role === 'user') {
      latestInteractiveMessageIndex = i;
      break;
    }
  }
  const quickActionEnabled = canUseConversationQuickAction();
  const thinkingIndicator = isCurrentAgentBusy()
    ? `<div class="thinking-indicator" aria-live="polite" aria-label="iFlow 正在思考">🤔</div>`
    : '';

  if (state.messages.length === 0) {
    const title = state.currentSessionId ? '当前会话暂无消息' : '👋 欢迎使用 flow hub';
    const hint = state.currentSessionId
      ? '开始输入消息，内容将保存在当前会话中。'
      : '从左侧选择一个 Agent 开始对话，或添加新的 Agent。';
    chatMessagesEl.innerHTML = `
      <div class="welcome-message">
        <h3>${title}</h3>
        <p>${hint}</p>
      </div>
      ${thinkingIndicator}
    `;
    return;
  }

  chatMessagesEl.innerHTML =
    state.messages
      .map((msg, index) => {
      if (msg.role === 'thought') {
        return `
        <div class="message thought">
          <div class="message-avatar">💭</div>
          <div class="message-content thought-content">
            <details class="thought-details">
              <summary>模型思考（默认折叠）</summary>
              <div class="thought-text">${formatMessageContent(msg.content)}</div>
            </details>
            <div class="message-time">${formatTime(msg.timestamp)}</div>
          </div>
        </div>
      `;
      }

      const avatar = msg.role === 'user' ? '👤' : msg.role === 'assistant' ? '🤖' : '⚙️';
      let quickReplySection = '';
      const isLatestInteractive = index === latestInteractiveMessageIndex;

      if (isLatestInteractive && msg.role === 'assistant') {
        let retryTargetMessageId = '';
        for (let i = index - 1; i >= 0; i -= 1) {
          if (state.messages[i].role === 'user') {
            retryTargetMessageId = state.messages[i].id;
            break;
          }
        }

        quickReplySection = `
          <div class="assistant-quick-replies">
            ${ASSISTANT_QUICK_REPLIES.map(
              (item) => `
              <button
                type="button"
                class="assistant-quick-reply-btn"
                data-quick-reply="${escapeHtml(item)}"
                ${quickActionEnabled ? '' : 'disabled'}
              >
                ${escapeHtml(item)}
              </button>
            `
            ).join('')}
            ${
              retryTargetMessageId
                ? `
                <button
                  type="button"
                  class="assistant-quick-reply-btn secondary"
                  data-retry-message-id="${escapeHtml(retryTargetMessageId)}"
                  ${quickActionEnabled ? '' : 'disabled'}
                >
                  重试上一问
                </button>
              `
                : ''
            }
          </div>
        `;
      }

      if (isLatestInteractive && msg.role === 'user') {
        quickReplySection = `
          <div class="assistant-quick-replies">
            <button
              type="button"
              class="assistant-quick-reply-btn secondary"
              data-retry-message-id="${escapeHtml(msg.id)}"
              ${quickActionEnabled ? '' : 'disabled'}
            >
              重试发送
            </button>
          </div>
        `;
      }

      return `
      <div class="message ${msg.role}">
        <div class="message-avatar">${avatar}</div>
        <div class="message-content">
          ${formatMessageContent(msg.content)}
          ${renderArtifactPreviewActions(msg.content)}
          <div class="message-time">${formatTime(msg.timestamp)}</div>
          ${quickReplySection}
        </div>
      </div>
    `;
      })
      .join('') + thinkingIndicator;
}

// 开始新会话
export function startNewSession() {
  if (!state.currentAgentId) {
    return;
  }

  const index = (state.sessionsByAgent[state.currentAgentId]?.length || 0) + 1;
  const session = createSession(state.currentAgentId, `会话 ${index}`);

  if (!state.sessionsByAgent[state.currentAgentId]) {
    state.sessionsByAgent[state.currentAgentId] = [];
  }
  state.sessionsByAgent[state.currentAgentId].push(session);
  state.messagesBySession[session.id] = [];

  state.currentSessionId = session.id;
  state.messages = [];

  void saveSessions();
  void saveSessionMessages();
  renderSessionList();
  renderMessages();
  refreshComposerState();
}

// 清空当前会话
export function clearChat() {
  if (!state.currentSessionId) {
    return;
  }

  state.messages = [];
  state.messagesBySession[state.currentSessionId] = [];
  touchCurrentSession();
  renderMessages();
  renderSessionList();
  refreshComposerState();
}

export function selectSession(sessionId: string) {
  if (!state.currentAgentId) {
    return;
  }

  const session = (state.sessionsByAgent[state.currentAgentId] || []).find((item) => item.id === sessionId);
  if (!session) {
    return;
  }

  state.currentSessionId = sessionId;
  const cachedMessages = getMessagesForSession(sessionId);
  state.messages = cachedMessages;
  if (session.source === 'iflow-log' && cachedMessages.length === 0) {
    state.messages = [
      {
        id: `msg-${Date.now()}-history-loading`,
        role: 'system',
        content: '正在加载 iFlow 历史会话内容...',
        timestamp: new Date(),
      },
    ];
    void loadIflowHistoryMessagesForSession(session);
  }
  renderSessionList();
  renderMessages();
  scrollToBottom();
  refreshComposerState();
}

// 滚动到底部
export function scrollToBottom() {
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

export function createSession(agentId: string, title = '新会话'): Session {
  const now = new Date();
  return {
    id: `sess-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    agentId,
    title,
    createdAt: now,
    updatedAt: now,
    acpSessionId: generateAcpSessionId(),
    source: 'local',
  };
}

export function ensureAgentHasSessions(agentId: string) {
  if (!state.sessionsByAgent[agentId]) {
    state.sessionsByAgent[agentId] = [];
  }
  if (state.sessionsByAgent[agentId].length > 0) {
    return;
  }

  const session = createSession(agentId, '默认会话');
  state.sessionsByAgent[agentId] = [session];
  state.messagesBySession[session.id] = [];
}

export function getSessionsForAgent(agentId: string): Session[] {
  return [...(state.sessionsByAgent[agentId] || [])].sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
  );
}

export function getMessagesForSession(sessionId: string): Message[] {
  return (state.messagesBySession[sessionId] || []).map((msg) => ({
    ...msg,
    timestamp: new Date(msg.timestamp),
  }));
}

export function findSessionById(sessionId: string): Session | null {
  for (const sessionList of Object.values(state.sessionsByAgent)) {
    const matched = sessionList.find((item) => item.id === sessionId);
    if (matched) {
      return matched;
    }
  }
  return null;
}

export function touchCurrentSession() {
  if (!state.currentAgentId || !state.currentSessionId) {
    return;
  }
  const session = (state.sessionsByAgent[state.currentAgentId] || []).find((item) => item.id === state.currentSessionId);
  if (!session) {
    return;
  }
  session.updatedAt = new Date();

  void saveSessions();
  renderSessionList();
}

export function touchSessionById(sessionId: string, sessionMessages?: Message[]) {
  for (const sessionList of Object.values(state.sessionsByAgent)) {
    const session = sessionList.find((item) => item.id === sessionId);
    if (!session) {
      continue;
    }
    maybeGenerateSessionTitle(session, sessionMessages ?? getMessagesForSession(sessionId));
    session.updatedAt = new Date();
    void saveSessions();
    return;
  }
}

export function maybeGenerateSessionTitle(session: Session, sessionMessages: Message[]) {
  const dialoguePair = getLatestDialoguePair(sessionMessages);
  if (!dialoguePair) {
    return;
  }

  const nextTitle = makeSessionTitleFromDialogue(
    dialoguePair.userMessage.content,
    dialoguePair.assistantMessage.content
  );
  if (nextTitle === session.title) {
    return;
  }
  session.title = nextTitle;
}

export function makeSessionTitleFromDialogue(userContent: string, assistantContent: string): string {
  const normalizedUser = normalizeTitleSource(userContent);
  const normalizedAssistant = normalizeTitleSource(assistantContent);

  const userPhrases = extractTitlePhrases(normalizedUser);
  const assistantPhrases = extractTitlePhrases(normalizedAssistant);
  const keywordTitle = composeKeywordTitle(userPhrases, assistantPhrases);

  if (keywordTitle) {
    return makeSessionTitle(keywordTitle);
  }

  const fallbackTitle = userPhrases[0] || assistantPhrases[0] || normalizedUser || normalizedAssistant || '新会话';
  return makeSessionTitle(fallbackTitle);
}

export function getLatestDialoguePair(
  sessionMessages: Message[]
): { userMessage: Message; assistantMessage: Message } | null {
  let latestUserIndex = -1;
  for (let i = sessionMessages.length - 1; i >= 0; i -= 1) {
    const message = sessionMessages[i];
    if (message.role === 'user' && Boolean(message.content.trim())) {
      latestUserIndex = i;
      break;
    }
  }

  if (latestUserIndex < 0) {
    return null;
  }

  let latestAssistantMessage: Message | null = null;
  for (let i = sessionMessages.length - 1; i > latestUserIndex; i -= 1) {
    const message = sessionMessages[i];
    if (message.role === 'assistant' && Boolean(message.content.trim())) {
      latestAssistantMessage = message;
      break;
    }
  }

  if (!latestAssistantMessage) {
    return null;
  }

  return {
    userMessage: sessionMessages[latestUserIndex],
    assistantMessage: latestAssistantMessage,
  };
}

export function composeKeywordTitle(userPhrases: string[], assistantPhrases: string[]): string {
  const keywords: string[] = [];

  for (const phrase of userPhrases) {
    appendTitleKeyword(keywords, phrase);
    if (keywords.length >= 2) {
      return keywords.join(' · ');
    }
  }

  for (const phrase of assistantPhrases) {
    appendTitleKeyword(keywords, phrase);
    if (keywords.length >= 2) {
      return keywords.join(' · ');
    }
  }

  return keywords.join(' · ');
}

export function appendTitleKeyword(target: string[], phrase: string) {
  const keyword = toTitleKeyword(phrase);
  if (!keyword || target.includes(keyword)) {
    return;
  }
  target.push(keyword);
}

export function toTitleKeyword(phrase: string): string {
  const cleaned = normalizeTitleSource(
    phrase
      .replace(
        /^(请问|请|帮我|麻烦|我想|我需要|我希望|我打算|可以|能否|请你|帮忙|让我|想要|我要|现在|先|再|继续)\s*/g,
        ''
      )
      .replace(/^(please|could you|can you|help me|i want to|i need to)\s+/i, '')
      .replace(/\b(please|help|could|would|can|you|me|i|to|the|a|an)\b/gi, ' ')
      .replace(/(一下|一下子|一下吧|一下哈|一下呢)$/g, '')
  );

  if (!cleaned) {
    return '';
  }

  const lowercase = cleaned.toLowerCase();
  if (TITLE_GENERIC_PHRASES.has(cleaned) || TITLE_GENERIC_PHRASES.has(lowercase)) {
    return '';
  }

  if (!isInformativeTitlePhrase(cleaned)) {
    return '';
  }

  return cleaned;
}

export function isInformativeTitlePhrase(phrase: string): boolean {
  const chineseChars = phrase.match(/[\u4e00-\u9fff]/g) || [];
  if (chineseChars.length >= 2) {
    return true;
  }

  const englishWords = phrase.match(/[a-zA-Z0-9_-]{3,}/g) || [];
  return englishWords.length > 0;
}

export function extractTitlePhrases(content: string): string[] {
  if (!content) {
    return [];
  }

  const normalized = normalizeTitleSource(content).replace(/[`*_>#~[\]()]/g, ' ');
  if (!normalized) {
    return [];
  }

  const sentenceParts = normalized
    .split(/[。！？!?；;，,\n\r]/)
    .map((part) => normalizeTitleSource(part))
    .filter((part) => Boolean(part));

  const phrases: string[] = [];
  for (const sentence of sentenceParts) {
    const fragments = sentence
      .split(/(?:并且|而且|以及|然后|同时|另外|还有| and | then )/i)
      .map((fragment) => normalizeTitleSource(fragment))
      .filter((fragment) => Boolean(fragment));

    for (const fragment of fragments) {
      if (phrases.includes(fragment)) {
        continue;
      }
      phrases.push(fragment);
      if (phrases.length >= 6) {
        return phrases;
      }
    }
  }

  return phrases;
}

export function makeSessionTitle(content: string): string {
  const oneLine = content.replace(/\s+/g, ' ').trim();
  if (!oneLine) {
    return '新会话';
  }
  if (oneLine.length <= 18) {
    return oneLine;
  }
  return `${oneLine.slice(0, 18)}...`;
}

export function inferLegacyHistorySessionId(agentId: string, sessionId: string): string | null {
  const prefix = `iflowlog-${agentId}-`;
  if (!sessionId.startsWith(prefix)) {
    return null;
  }
  const candidate = sessionId.slice(prefix.length).trim();
  if (!candidate.startsWith('session-')) {
    return null;
  }
  return candidate;
}

export function isIflowHistorySessionId(sessionId: string | undefined): boolean {
  return Boolean(sessionId && sessionId.trim().startsWith('session-'));
}

export function parseStoredSession(session: StoredSession): Session {
  const normalizedTitle =
    typeof session.title === 'string' && session.title.trim().length > 0
      ? session.title
      : '新会话';
  const rawAcpSessionId =
    typeof session.acpSessionId === 'string' && session.acpSessionId.trim().length > 0
      ? session.acpSessionId.trim()
      : undefined;
  const inferredAcpSessionId = inferLegacyHistorySessionId(session.agentId, session.id) || undefined;
  const normalizedAcpSessionId =
    session.source === 'iflow-log'
      ? isIflowHistorySessionId(rawAcpSessionId)
        ? rawAcpSessionId
        : inferredAcpSessionId
      : rawAcpSessionId || inferredAcpSessionId;
  const normalizedSource =
    session.source === 'iflow-log'
      ? 'iflow-log'
      : normalizedAcpSessionId && session.id === buildHistorySessionLocalId(session.agentId, normalizedAcpSessionId)
        ? 'iflow-log'
        : 'local';

  return {
    ...session,
    title: normalizedTitle,
    createdAt: new Date(session.createdAt),
    updatedAt: new Date(session.updatedAt),
    acpSessionId: normalizedAcpSessionId,
    source: normalizedSource,
    messageCountHint:
      typeof session.messageCountHint === 'number' && session.messageCountHint >= 0
        ? session.messageCountHint
        : undefined,
  };
}

export function toStoredSession(session: Session): StoredSession {
  return {
    ...session,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    acpSessionId: session.acpSessionId,
    source: session.source || 'local',
    messageCountHint: session.messageCountHint,
  };
}

export function parseStoredMessage(message: StoredMessage): Message {
  return {
    ...message,
    role: normalizeStoredRole(message.role),
    timestamp: new Date(message.timestamp),
  };
}

export function toStoredMessage(message: Message): StoredMessage {
  return {
    ...message,
    timestamp: message.timestamp.toISOString(),
  };
}

export function persistCurrentSessionMessages() {
  if (!state.currentSessionId) {
    return;
  }
  const session = findSessionById(state.currentSessionId);
  if (session?.source === 'iflow-log') {
    return;
  }
  state.messagesBySession[state.currentSessionId] = state.messages.map((msg) => ({
    ...msg,
    timestamp: new Date(msg.timestamp),
  }));
  void saveSessionMessages();
}

export function buildStoredSessionMap(): StoredSessionMap {
  const payload: StoredSessionMap = {};
  for (const [agentId, sessionList] of Object.entries(state.sessionsByAgent)) {
    payload[agentId] = sessionList.map(toStoredSession);
  }
  return payload;
}

export function buildStoredMessageMap(): StoredMessageMap {
  const payload: StoredMessageMap = {};
  for (const [sessionId, sessionMessages] of Object.entries(state.messagesBySession)) {
    const session = findSessionById(sessionId);
    if (session?.source === 'iflow-log') {
      continue;
    }
    payload[sessionId] = sessionMessages.map(toStoredMessage);
  }
  return payload;
}

export function buildStorageSnapshot(): StorageSnapshot {
  return {
    sessionsByAgent: buildStoredSessionMap(),
    messagesBySession: buildStoredMessageMap(),
  };
}

export function normalizeStoredSessions(parsed: StoredSessionMap | null | undefined): Record<string, Session[]> {
  const normalized: Record<string, Session[]> = {};
  if (!parsed) {
    return normalized;
  }
  for (const [agentId, storedSessions] of Object.entries(parsed)) {
    const parsedSessions = Array.isArray(storedSessions) ? storedSessions.map(parseStoredSession) : [];
    normalized[agentId] = dedupeSessionsByIdentity(parsedSessions);
  }
  return normalized;
}

export function normalizeStoredMessages(parsed: StoredMessageMap | null | undefined): Record<string, Message[]> {
  const normalized: Record<string, Message[]> = {};
  if (!parsed) {
    return normalized;
  }
  for (const [sessionId, storedMessages] of Object.entries(parsed)) {
    normalized[sessionId] = Array.isArray(storedMessages) ? storedMessages.map(parseStoredMessage) : [];
  }
  return normalized;
}

export function readStorageSnapshotFromLocalStorage(): StorageSnapshot | null {
  const sessionRaw = localStorage.getItem(SESSIONS_STORAGE_KEY);
  const messageRaw = localStorage.getItem(SESSION_MESSAGES_STORAGE_KEY);
  if (!sessionRaw && !messageRaw) {
    return null;
  }

  try {
    const sessionsByAgent = sessionRaw ? (JSON.parse(sessionRaw) as StoredSessionMap) : {};
    const messagesBySession = messageRaw ? (JSON.parse(messageRaw) as StoredMessageMap) : {};
    return {
      sessionsByAgent,
      messagesBySession,
    };
  } catch (e) {
    console.error('Failed to load session storage from localStorage:', e);
    return null;
  }
}

export function clearLocalStorageSessionData() {
  localStorage.removeItem(SESSIONS_STORAGE_KEY);
  localStorage.removeItem(SESSION_MESSAGES_STORAGE_KEY);
}

export async function loadStorageSnapshot(): Promise<StorageSnapshot | null> {
  try {
    const snapshot = await tauriLoadStorageSnapshot();
    if (!snapshot) {
      return null;
    }
    return {
      sessionsByAgent: snapshot.sessionsByAgent || {},
      messagesBySession: snapshot.messagesBySession || {},
    };
  } catch (e) {
    console.error('Failed to load session storage from backend:', e);
    return null;
  }
}

export async function saveStorageSnapshot(snapshot: StorageSnapshot): Promise<boolean> {
  try {
    await tauriSaveStorageSnapshot(snapshot);
    return true;
  } catch (e) {
    console.error('Failed to save session storage to backend:', e);
    return false;
  }
}

export async function persistStorageSnapshot(snapshot: StorageSnapshot): Promise<boolean> {
  const stored = await saveStorageSnapshot(snapshot);
  if (stored) {
    clearLocalStorageSessionData();
    return true;
  }

  try {
    localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(snapshot.sessionsByAgent));
    localStorage.setItem(SESSION_MESSAGES_STORAGE_KEY, JSON.stringify(snapshot.messagesBySession));
  } catch (e) {
    console.error('Failed to save session storage to localStorage:', e);
  }
  return false;
}

export function isStorageSnapshotEmpty(snapshot: StorageSnapshot): boolean {
  return (
    Object.keys(snapshot.sessionsByAgent).length === 0 &&
    Object.keys(snapshot.messagesBySession).length === 0
  );
}

export async function loadSessionStore() {
  const backendSnapshot = await loadStorageSnapshot();
  if (backendSnapshot) {
    state.sessionsByAgent = normalizeStoredSessions(backendSnapshot.sessionsByAgent);
    state.messagesBySession = normalizeStoredMessages(backendSnapshot.messagesBySession);

    if (isStorageSnapshotEmpty(backendSnapshot)) {
      const localSnapshot = readStorageSnapshotFromLocalStorage();
      if (localSnapshot) {
        state.sessionsByAgent = normalizeStoredSessions(localSnapshot.sessionsByAgent);
        state.messagesBySession = normalizeStoredMessages(localSnapshot.messagesBySession);
        await persistStorageSnapshot(localSnapshot);
      }
    }
    return;
  }

  const localSnapshot = readStorageSnapshotFromLocalStorage();
  if (!localSnapshot) {
    state.sessionsByAgent = {};
    state.messagesBySession = {};
    return;
  }

  state.sessionsByAgent = normalizeStoredSessions(localSnapshot.sessionsByAgent);
  state.messagesBySession = normalizeStoredMessages(localSnapshot.messagesBySession);
}

export async function saveSessions() {
  await persistStorageSnapshot(buildStorageSnapshot());
}

export async function saveSessionMessages() {
  await persistStorageSnapshot(buildStorageSnapshot());
}

export async function migrateLegacyHistoryIfNeeded() {
  const legacyRaw = localStorage.getItem(LEGACY_MESSAGE_HISTORY_STORAGE_KEY);
  if (!legacyRaw) {
    return;
  }

  try {
    const parsed = JSON.parse(legacyRaw) as LegacyMessageHistoryMap;
    for (const [agentId, storedMessages] of Object.entries(parsed)) {
      if (!Array.isArray(storedMessages)) {
        continue;
      }
      if (!state.sessionsByAgent[agentId] || state.sessionsByAgent[agentId].length === 0) {
        const migratedSession = createSession(agentId, '历史会话');
        state.sessionsByAgent[agentId] = [migratedSession];
      }

      const targetSession = state.sessionsByAgent[agentId][0];
      const normalizedMessages = storedMessages.map(parseStoredMessage);
      state.messagesBySession[targetSession.id] = normalizedMessages;

      if (normalizedMessages.length > 0) {
        const lastTimestamp = normalizedMessages[normalizedMessages.length - 1].timestamp;
        targetSession.updatedAt = new Date(lastTimestamp);
      }
    }

    localStorage.removeItem(LEGACY_MESSAGE_HISTORY_STORAGE_KEY);
    await saveSessions();
    await saveSessionMessages();
  } catch (e) {
    console.error('Failed to migrate legacy history:', e);
  }
}

export function pruneSessionDataByAgents() {
  const liveAgentIds = new Set(state.agents.map((agent) => agent.id));

  const prunedSessions: Record<string, Session[]> = {};
  for (const [agentId, sessionList] of Object.entries(state.sessionsByAgent)) {
    if (!liveAgentIds.has(agentId)) {
      continue;
    }
    prunedSessions[agentId] = sessionList;
  }
  state.sessionsByAgent = prunedSessions;

  const liveSessionIds = new Set(
    Object.values(state.sessionsByAgent)
      .flat()
      .map((session) => session.id)
  );

  const prunedMessages: Record<string, Message[]> = {};
  for (const [sessionId, sessionMessages] of Object.entries(state.messagesBySession)) {
    if (liveSessionIds.has(sessionId)) {
      prunedMessages[sessionId] = sessionMessages;
    }
  }
  state.messagesBySession = prunedMessages;
}

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
      return;
    }

    state.agents = JSON.parse(saved) as Agent[];
    state.agents = state.agents.map((agent) => ({
      ...agent,
      iflowPath: agent.iflowPath || 'iflow',
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

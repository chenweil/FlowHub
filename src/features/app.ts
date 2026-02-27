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
  sendMessage as tauriSendMessage,
  stopMessage,
} from '../services/tauri';
import { generateAcpSessionId, streamTypeToRole, formatTime } from '../lib/utils';
import { escapeHtml } from '../lib/html';
import { formatMessageContent } from '../lib/markdown';
import type { Message, ToolCall, SlashMenuItem, ComposerState, StreamMessageType, ThemeMode } from '../types';
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
  currentAgentModelBtnEl,
  currentAgentModelMenuEl,
  toolCallsPanelEl,
  toolCallsListEl,
  closeToolPanelBtnEl,
  newSessionBtnEl,
  clearChatBtnEl,
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
import {
  persistCurrentSessionMessages,
  saveSessions,
  saveSessionMessages,
} from './storage';
import {
  applyAcpSessionBinding,
  onSessionListClick,
  clearCurrentAgentSessions,
  renderSessionList,
  startNewSession,
  clearChat,
  getMessagesForSession,
  findSessionById,
  touchCurrentSession,
  touchSessionById,
} from './sessions';
import {
  isCurrentAgentBusy,
  applyAgentRegistry,
  applyAgentModelRegistry,
  onAgentListClick,
  addAgent,
  hideRenameAgentModal,
  submitRenameAgent,
  mergeToolCalls,
  resetToolCallsForAgent,
  closeCurrentAgentModelMenu,
  toggleCurrentAgentModelMenu,
  onCurrentAgentModelMenuClick,
  handleLocalModelCommand,
  syncAgentModelFromAboutContent,
  showError,
} from './agents';

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

// 发送消息
const MESSAGE_TIMEOUT_MS = 60000;

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

// 滚动到底部
export function scrollToBottom() {
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

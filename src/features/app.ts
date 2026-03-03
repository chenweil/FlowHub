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
  getVersion,
  sendMessage as tauriSendMessage,
  stopMessage,
  pickFolder,
} from '../services/tauri';
import { TIMEOUTS } from '../config';
import { generateAcpSessionId, streamTypeToRole } from '../lib/utils';
import { escapeHtml } from '../lib/html';
import type { Message, SlashMenuItem, ComposerState, StreamMessageType, ThemeMode } from '../types';
import { state, canUseConversationQuickAction } from '../store';
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
  workspacePathInputEl,
  browseWorkspacePathBtnEl,
  renameAgentModalEl,
  closeRenameAgentModalBtnEl,
  cancelRenameAgentBtnEl,
  confirmRenameAgentBtnEl,
  renameAgentNameInputEl,
  currentAgentModelBtnEl,
  currentAgentModelMenuEl,
  toggleThinkBtnEl,
  openToolCallsBtnEl,
  openGitChangesBtnEl,
  toolCallsPanelEl,
  toolCallsListEl,
  closeToolPanelBtnEl,
  gitChangesListEl,
  refreshGitChangesBtnEl,
  closeGitChangesPanelBtnEl,
  newSessionBtnEl,
  clearChatBtnEl,
  clearAllSessionsBtnEl,
  inputStatusHintEl,
  slashCommandMenuEl,
  artifactPreviewModalEl,
  closeArtifactPreviewBtnEl,
  gitDiffModalEl,
  closeGitDiffBtnEl,
  themeToggleBtnEl,
  notificationSoundSelectEl,
  appVersionEl,
} from '../dom';
import {
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
  openCurrentAgentToolCallsPanel,
  closeCurrentAgentModelMenu,
  toggleCurrentAgentModelMenu,
  onCurrentAgentModelMenuClick,
  handleLocalModelCommand,
  syncAgentModelFromAboutContent,
  toggleCurrentAgentThink,
  refreshAgentGitChanges,
  refreshCurrentAgentGitChanges,
  showGitChangesForAgent,
  showError,
} from './agents';
import {
  renderMessages,
  scrollToBottom,
  onChatMessagesClick,
  onToolCallsClick,
  closeArtifactPreviewModal,
  closeGitDiffModal,
  onGitChangesClick,
} from './ui';

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
// 初始化
// 主题管理
const THEME_STORAGE_KEY = 'iflow-theme';
const THEME_CYCLE: Record<ThemeMode, ThemeMode> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_ICON: Record<ThemeMode, string> = { system: '◑', light: '☀', dark: '☾' };
const THEME_TITLE: Record<ThemeMode, string> = { system: '跟随系统', light: '亮色模式', dark: '暗色模式' };
const NOTIFICATION_SOUND_STORAGE_KEY = 'iflow-notification-sound';
const NOTIFICATION_SOUND_NONE = 'none';
const NOTIFICATION_SOUND_DEFAULT = 'bell-happy.wav';
const NOTIFICATION_SOUND_OPTIONS: ReadonlyArray<{ id: string; label: string; src: string | null }> = [
  { id: NOTIFICATION_SOUND_NONE, label: '铃声：关闭', src: null },
  {
    id: 'bell-happy.wav',
    label: '铃声：Happy Bell',
    src: '/audio/bell/bell-happy.wav',
  },
  {
    id: 'chime-quick.wav',
    label: '铃声：Quick Chime',
    src: '/audio/bell/chime-quick.wav',
  },
  {
    id: 'ding-airport.wav',
    label: '铃声：Airport Ding',
    src: '/audio/bell/ding-airport.wav',
  },
  {
    id: 'bell-cartoon.wav',
    label: '铃声：Cartoon Bell',
    src: '/audio/bell/bell-cartoon.wav',
  },
  {
    id: 'alert-flute.wav',
    label: '铃声：Flute Alert',
    src: '/audio/bell/alert-flute.wav',
  },
  {
    id: 'tone-soft.wav',
    label: '铃声：Soft Interface',
    src: '/audio/bell/tone-soft.wav',
  },
  {
    id: 'beep-up.wav',
    label: '铃声：Upward Beep',
    src: '/audio/bell/beep-up.wav',
  },
];
const notificationAudioEl = new Audio();
notificationAudioEl.preload = 'auto';


export function applyTheme(mode: ThemeMode) {
  const root = document.documentElement;
  root.classList.remove('theme-light', 'theme-dark');
  if (mode !== 'system') root.classList.add(`theme-${mode}`);
  themeToggleBtnEl.textContent = THEME_ICON[mode];
  themeToggleBtnEl.title = THEME_TITLE[mode];
}

function normalizeNotificationSoundId(soundId: string | null | undefined): string {
  if (!soundId) {
    return NOTIFICATION_SOUND_DEFAULT;
  }
  const matched = NOTIFICATION_SOUND_OPTIONS.find((item) => item.id === soundId);
  return matched ? matched.id : NOTIFICATION_SOUND_DEFAULT;
}

function notificationSoundSrcById(soundId: string): string | null {
  const matched = NOTIFICATION_SOUND_OPTIONS.find((item) => item.id === soundId);
  return matched?.src || null;
}

function applyNotificationSoundSelection(soundId: string) {
  const normalized = normalizeNotificationSoundId(soundId);
  state.notificationSoundId = normalized;
  localStorage.setItem(NOTIFICATION_SOUND_STORAGE_KEY, normalized);
  notificationSoundSelectEl.value = normalized;
}

export function setupNotificationSoundSelector() {
  notificationSoundSelectEl.innerHTML = NOTIFICATION_SOUND_OPTIONS.map((item) => {
    return `<option value="${item.id}">${item.label}</option>`;
  }).join('');

  const saved = normalizeNotificationSoundId(state.notificationSoundId);
  applyNotificationSoundSelection(saved);
}

export async function playTaskFinishSound() {
  const source = notificationSoundSrcById(state.notificationSoundId);
  if (!source) {
    return;
  }

  try {
    notificationAudioEl.pause();
    notificationAudioEl.currentTime = 0;
    notificationAudioEl.src = source;
    await notificationAudioEl.play();
  } catch (error) {
    console.warn('Play task finish sound failed:', error);
  }
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
      void refreshAgentGitChanges(payload.agentId);
    } else if (targetSessionId) {
      const sessionMessages = getMessagesForSession(targetSessionId).filter(
        (m) => !m.id.includes('-sending') && !m.id.includes('-processing')
      );
      state.messagesBySession[targetSessionId] = sessionMessages;
      void saveSessionMessages();
      renderSessionList();
      refreshComposerState();
    }

    void playTaskFinishSound();
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
  setupNotificationSoundSelector();

  themeToggleBtnEl.addEventListener('click', () => {
    state.currentTheme = THEME_CYCLE[state.currentTheme];
    applyTheme(state.currentTheme);
    localStorage.setItem(THEME_STORAGE_KEY, state.currentTheme);
  });
  notificationSoundSelectEl.addEventListener('change', () => {
    applyNotificationSoundSelection(notificationSoundSelectEl.value);
    void playTaskFinishSound();
  });
  openToolCallsBtnEl.addEventListener('click', () => {
    if (!state.currentAgentId) {
      showError('请先选择 Agent');
      return;
    }
    openCurrentAgentToolCallsPanel();
  });
  openGitChangesBtnEl.addEventListener('click', () => {
    if (!state.currentAgentId) {
      showError('请先选择 Agent');
      return;
    }
    showGitChangesForAgent(state.currentAgentId);
    void refreshCurrentAgentGitChanges();
  });
  toggleThinkBtnEl.addEventListener('click', () => {
    void toggleCurrentAgentThink();
  });

  addAgentBtnEl.addEventListener('click', () => {
    addAgentModalEl.classList.remove('hidden');
  });

  closeModalBtnEl.addEventListener('click', hideModal);
  cancelAddAgentBtnEl.addEventListener('click', hideModal);
  closeArtifactPreviewBtnEl.addEventListener('click', closeArtifactPreviewModal);
  closeGitDiffBtnEl.addEventListener('click', closeGitDiffModal);
  artifactPreviewModalEl.addEventListener('click', (event) => {
    if (event.target === artifactPreviewModalEl) {
      closeArtifactPreviewModal();
    }
  });
  gitDiffModalEl.addEventListener('click', (event) => {
    if (event.target === gitDiffModalEl) {
      closeGitDiffModal();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') {
      return;
    }
    if (!gitDiffModalEl.classList.contains('hidden')) {
      closeGitDiffModal();
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

    const name = nameInput.value.trim() || 'iFlow';
    const iflowPath = pathInput.value.trim() || 'iflow';
    const workspacePath = workspacePathInputEl.value.trim();

    hideModal();
    await addAgent(name, iflowPath, workspacePath);

    nameInput.value = 'iFlow';
    pathInput.value = '';
  });

  browseWorkspacePathBtnEl.addEventListener('click', async () => {
    const originalText = browseWorkspacePathBtnEl.textContent;
    browseWorkspacePathBtnEl.disabled = true;
    browseWorkspacePathBtnEl.textContent = '选择中...';

    try {
      const selectedPath = await pickFolder(workspacePathInputEl.value.trim() || null);
      if (selectedPath) {
        workspacePathInputEl.value = selectedPath;
      }
    } catch (error) {
      console.error('Pick workspace folder failed:', error);
      showError(`选择文件夹失败: ${String(error)}`);
    } finally {
      browseWorkspacePathBtnEl.disabled = false;
      browseWorkspacePathBtnEl.textContent = originalText;
    }
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
  gitChangesListEl.addEventListener('click', onGitChangesClick);
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
  closeGitChangesPanelBtnEl.addEventListener('click', () => {
    closeGitChangesPanelBtnEl.closest('.git-changes-panel')?.classList.add('hidden');
  });
  refreshGitChangesBtnEl.addEventListener('click', () => {
    void refreshCurrentAgentGitChanges();
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

// 发送消息
const MESSAGE_TIMEOUT_MS = TIMEOUTS.messageSend;

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

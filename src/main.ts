// iFlow Workspace - Main Entry
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// DOM 元素
const addAgentBtnEl = document.getElementById('add-agent-btn') as HTMLButtonElement;
const agentListEl = document.getElementById('agent-list') as HTMLDivElement;
const sessionListEl = document.getElementById('session-list') as HTMLDivElement;
const chatMessagesEl = document.getElementById('chat-messages') as HTMLDivElement;
const messageInputEl = document.getElementById('message-input') as HTMLTextAreaElement;
const sendBtnEl = document.getElementById('send-btn') as HTMLButtonElement;
const addAgentModalEl = document.getElementById('add-agent-modal') as HTMLDivElement;
const closeModalBtnEl = document.getElementById('close-modal') as HTMLButtonElement;
const cancelAddAgentBtnEl = document.getElementById('cancel-add-agent') as HTMLButtonElement;
const confirmAddAgentBtnEl = document.getElementById('confirm-add-agent') as HTMLButtonElement;
const currentAgentNameEl = document.getElementById('current-agent-name') as HTMLHeadingElement;
const currentAgentStatusEl = document.getElementById('current-agent-status') as HTMLSpanElement;
const currentAgentModelBtnEl = document.getElementById('current-agent-model-btn') as HTMLButtonElement;
const currentAgentModelTextEl = document.getElementById('current-agent-model-text') as HTMLSpanElement;
const currentAgentModelMenuEl = document.getElementById('current-agent-model-menu') as HTMLDivElement;
const toolCallsPanelEl = document.getElementById('tool-calls-panel') as HTMLDivElement;
const toolCallsListEl = document.getElementById('tool-calls-list') as HTMLDivElement;
const closeToolPanelBtnEl = document.getElementById('close-tool-panel') as HTMLButtonElement;
const newSessionBtnEl = document.getElementById('new-session-btn') as HTMLButtonElement;
const clearChatBtnEl = document.getElementById('clear-chat-btn') as HTMLButtonElement;
const connectionStatusEl = document.getElementById('connection-status') as HTMLDivElement;
const clearAllAgentsBtnEl = document.getElementById('clear-all-agents') as HTMLButtonElement;
const inputStatusHintEl = document.getElementById('input-status-hint') as HTMLSpanElement;
const slashCommandMenuEl = document.getElementById('slash-command-menu') as HTMLDivElement;

// 类型定义
interface Agent {
  id: string;
  name: string;
  type: string;
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  workspacePath: string;
  iflowPath?: string;
  selectedModel?: string;
  port?: number;
}

interface Session {
  id: string;
  agentId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'thought';
  content: string;
  timestamp: Date;
  agentId?: string;
  toolCalls?: ToolCall[];
}

interface ToolCall {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  arguments?: Record<string, unknown>;
  output?: string;
}

interface RegistryCommand {
  name: string;
  description: string;
  scope: string;
}

interface RegistryMcpServer {
  name: string;
  description: string;
}

interface ModelOption {
  label: string;
  value: string;
}

interface AgentRegistry {
  commands: RegistryCommand[];
  mcpServers: RegistryMcpServer[];
}

interface SlashMenuItem {
  id: string;
  label: string;
  insertText: string;
  description: string;
  hint: string;
  category: 'command' | 'mcp' | 'builtin';
  searchable: string;
}

interface StoredSession {
  id: string;
  agentId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

interface StoredMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'thought';
  content: string;
  timestamp: string;
  agentId?: string;
}

type StoredSessionMap = Record<string, StoredSession[]>;
type StoredMessageMap = Record<string, StoredMessage[]>;
type LegacyMessageHistoryMap = Record<string, StoredMessage[]>;

interface StorageSnapshot {
  sessionsByAgent: StoredSessionMap;
  messagesBySession: StoredMessageMap;
}

// 状态
let agents: Agent[] = [];
let currentAgentId: string | null = null;
let currentSessionId: string | null = null;
let messages: Message[] = [];

let sessionsByAgent: Record<string, Session[]> = {};
let messagesBySession: Record<string, Message[]> = {};
let inflightSessionByAgent: Record<string, string> = {};
let registryByAgent: Record<string, AgentRegistry> = {};
let toolCallsByAgent: Record<string, ToolCall[]> = {};
let modelOptionsCacheByAgent: Record<string, ModelOption[]> = {};
let modelSelectorOpen = false;
let modelSwitchingAgentId: string | null = null;
let slashMenuItems: SlashMenuItem[] = [];
let slashMenuVisible = false;
let slashMenuActiveIndex = 0;

type ComposerState = 'ready' | 'busy' | 'disabled';
type StreamMessageType = 'content' | 'thought' | 'system' | 'plan';

const AGENTS_STORAGE_KEY = 'iflow-agents';
const SESSIONS_STORAGE_KEY = 'iflow-sessions';
const SESSION_MESSAGES_STORAGE_KEY = 'iflow-session-messages';
const LEGACY_MESSAGE_HISTORY_STORAGE_KEY = 'iflow-message-history';
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

// 初始化
async function init() {
  console.log('Initializing app...');
  await loadAgents();
  setupEventListeners();
  setupTauriEventListeners();
  updateCurrentAgentModelUI();
  refreshComposerState();
  console.log('App initialized');
}

function setComposerState(state: ComposerState, hint: string) {
  messageInputEl.classList.remove('composer-ready', 'composer-busy', 'composer-disabled');
  messageInputEl.classList.add(`composer-${state}`);
  inputStatusHintEl.textContent = hint;

  if (state === 'ready') {
    messageInputEl.disabled = false;
    sendBtnEl.disabled = false;
    messageInputEl.placeholder = '输入消息...';
    updateSlashCommandMenu();
    return;
  }

  messageInputEl.disabled = true;
  sendBtnEl.disabled = true;
  messageInputEl.placeholder = state === 'busy' ? '正在回复中，请等待...' : '请选择 Agent 后开始对话...';
  hideSlashCommandMenu();
}

function refreshComposerState() {
  const currentAgent = currentAgentId ? agents.find((agent) => agent.id === currentAgentId) : null;
  const isConnected = currentAgent?.status === 'connected';
  const hasSession = Boolean(currentSessionId);
  const isBusy = isCurrentAgentBusy();

  if (!isConnected || !hasSession) {
    setComposerState('disabled', '请选择在线 Agent 与会话后输入');
    newSessionBtnEl.disabled = !isConnected;
    clearChatBtnEl.disabled = true;
    return;
  }

  if (isBusy) {
    setComposerState('busy', '正在回复中，完成后可继续输入');
    newSessionBtnEl.disabled = true;
    clearChatBtnEl.disabled = true;
    return;
  }

  setComposerState('ready', '当前会话已完成，可继续输入');
  newSessionBtnEl.disabled = false;
  clearChatBtnEl.disabled = false;
}

function isCurrentAgentBusy(): boolean {
  const currentAgent = currentAgentId ? agents.find((agent) => agent.id === currentAgentId) : null;
  return Boolean(currentAgent && inflightSessionByAgent[currentAgent.id]);
}

// 设置 Tauri 事件监听
function setupTauriEventListeners() {
  console.log('Setting up Tauri event listeners...');

  listen('stream-message', (event) => {
    const payload = event.payload as { agentId?: string; content?: string; type?: StreamMessageType };
    if (!payload.agentId || !payload.content) {
      return;
    }

    if (payload.agentId === currentAgentId && messageTimeout) {
      clearTimeout(messageTimeout);
      messageTimeout = null;
    }

    const targetSessionId =
      inflightSessionByAgent[payload.agentId] ||
      (payload.agentId === currentAgentId ? currentSessionId : null);

    if (!targetSessionId) {
      return;
    }

    appendStreamMessage(payload.agentId, targetSessionId, payload.content, payload.type);
  });

  listen('tool-call', (event) => {
    const payload = event.payload as { agentId?: string; toolCalls?: ToolCall[] };
    if (payload.agentId && Array.isArray(payload.toolCalls)) {
      mergeToolCalls(payload.agentId, payload.toolCalls);
    }
  });

  listen('command-registry', (event) => {
    const payload = event.payload as {
      agentId?: string;
      commands?: unknown[];
      mcpServers?: unknown[];
    };
    if (!payload.agentId) {
      return;
    }

    applyAgentRegistry(payload.agentId, payload.commands, payload.mcpServers);
  });

  listen('model-registry', (event) => {
    const payload = event.payload as {
      agentId?: string;
      models?: unknown[];
      currentModel?: unknown;
    };
    if (!payload.agentId) {
      return;
    }

    applyAgentModelRegistry(payload.agentId, payload.models, payload.currentModel);
  });

  listen('task-finish', (event) => {
    const payload = event.payload as { agentId?: string };
    if (!payload.agentId) {
      return;
    }

    const targetSessionId = inflightSessionByAgent[payload.agentId];
    if (targetSessionId) {
      delete inflightSessionByAgent[payload.agentId];
    }

    if (payload.agentId === currentAgentId) {
      if (messageTimeout) {
        clearTimeout(messageTimeout);
        messageTimeout = null;
      }

      messages = messages.filter((m) => !m.id.includes('-sending') && !m.id.includes('-processing'));
      renderMessages();
      refreshComposerState();
    } else if (targetSessionId) {
      const sessionMessages = getMessagesForSession(targetSessionId).filter(
        (m) => !m.id.includes('-sending') && !m.id.includes('-processing')
      );
      messagesBySession[targetSessionId] = sessionMessages;
      void saveSessionMessages();
      renderSessionList();
      refreshComposerState();
    }
  });

  listen('agent-error', (event) => {
    const payload = event.payload as { agentId?: string; error?: string };
    if (payload.agentId) {
      delete inflightSessionByAgent[payload.agentId];
    }
    if (payload.agentId && payload.agentId !== currentAgentId) {
      return;
    }
    showError(`错误: ${payload.error || '未知错误'}`);
    refreshComposerState();
  });
}

// 追加流式消息
function appendStreamMessage(
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
  messagesBySession[sessionId] = sessionMessages;
  touchSessionById(sessionId, sessionMessages);
  void saveSessionMessages();

  if (sessionId === currentSessionId) {
    messages = sessionMessages;
    renderMessages();
    scrollToBottom();
  } else {
    renderSessionList();
  }
}

function applyAgentRegistry(agentId: string, rawCommands: unknown[] | undefined, rawMcpServers: unknown[] | undefined) {
  const commands = normalizeRegistryCommands(rawCommands);
  const mcpServers = normalizeRegistryMcpServers(rawMcpServers);
  if (commands.length === 0 && mcpServers.length === 0) {
    return;
  }

  registryByAgent[agentId] = {
    commands,
    mcpServers,
  };

  if (agentId === currentAgentId) {
    updateSlashCommandMenu();
  }
}

function applyAgentModelRegistry(
  agentId: string,
  rawModels: unknown[] | undefined,
  rawCurrentModel: unknown
) {
  const models = Array.isArray(rawModels)
    ? rawModels.map((item) => normalizeModelOption(item)).filter((item): item is ModelOption => Boolean(item))
    : [];

  if (models.length > 0) {
    modelOptionsCacheByAgent[agentId] = models;
  }

  const currentModel =
    typeof rawCurrentModel === 'string' && rawCurrentModel.trim().length > 0
      ? rawCurrentModel.trim()
      : null;

  const agent = agents.find((item) => item.id === agentId);
  if (!agent) {
    return;
  }

  if (currentModel && agent.selectedModel !== currentModel) {
    agent.selectedModel = currentModel;
    void saveAgents();
    renderAgentList();
  }

  if (currentAgentId === agentId) {
    updateCurrentAgentModelUI();
    if (modelSelectorOpen) {
      renderCurrentAgentModelMenu(agent, modelOptionsCacheByAgent[agentId] || []);
    }
  }
}

function normalizeRegistryCommands(rawEntries: unknown[] | undefined): RegistryCommand[] {
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

function normalizeRegistryMcpServers(rawEntries: unknown[] | undefined): RegistryMcpServer[] {
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

function readTextFromUnknown(value: unknown): string {
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

function getSlashQueryFromInput(): string | null {
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

function buildSlashMenuItemsForCurrentAgent(): SlashMenuItem[] {
  const items: SlashMenuItem[] = [];
  const seen = new Set<string>();
  const currentRegistry = currentAgentId ? registryByAgent[currentAgentId] : undefined;

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

function updateSlashCommandMenu() {
  const query = getSlashQueryFromInput();
  if (query === null || messageInputEl.disabled || !currentAgentId) {
    hideSlashCommandMenu();
    return;
  }

  const candidateItems = buildSlashMenuItemsForCurrentAgent();
  const filteredItems =
    query.length === 0
      ? candidateItems
      : candidateItems.filter((item) => item.searchable.includes(query));

  slashMenuItems = filteredItems.slice(0, 12);
  if (slashMenuItems.length === 0) {
    slashMenuVisible = true;
    slashMenuActiveIndex = 0;
    slashCommandMenuEl.classList.remove('hidden');
    slashCommandMenuEl.innerHTML = `<div class="slash-command-empty">未找到匹配命令：/${escapeHtml(query)}</div>`;
    return;
  }

  if (!slashMenuVisible) {
    slashMenuActiveIndex = 0;
  } else if (slashMenuActiveIndex >= slashMenuItems.length) {
    slashMenuActiveIndex = slashMenuItems.length - 1;
  }

  slashMenuVisible = true;
  slashCommandMenuEl.classList.remove('hidden');
  slashCommandMenuEl.innerHTML = slashMenuItems
    .map((item, index) => {
      const activeClass = index === slashMenuActiveIndex ? 'active' : '';
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
}

function hideSlashCommandMenu() {
  slashMenuVisible = false;
  slashMenuItems = [];
  slashMenuActiveIndex = 0;
  slashCommandMenuEl.classList.add('hidden');
  slashCommandMenuEl.innerHTML = '';
}

function moveSlashMenuSelection(offset: number) {
  if (slashMenuItems.length === 0) {
    return;
  }
  const total = slashMenuItems.length;
  slashMenuActiveIndex = (slashMenuActiveIndex + offset + total) % total;
  updateSlashCommandMenu();
}

function applySlashMenuItem(index: number): boolean {
  const item = slashMenuItems[index];
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

function handleSlashMenuKeydown(event: KeyboardEvent): boolean {
  if (!slashMenuVisible) {
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
    if (slashMenuItems.length === 0) {
      hideSlashCommandMenu();
      return true;
    }
    return applySlashMenuItem(slashMenuActiveIndex);
  }

  if (event.key === 'Enter' && !event.shiftKey) {
    if (slashMenuItems.length === 0) {
      hideSlashCommandMenu();
      return false;
    }
    event.preventDefault();
    return applySlashMenuItem(slashMenuActiveIndex);
  }

  return false;
}

// 设置事件监听
function setupEventListeners() {
  console.log('Setting up event listeners...');

  addAgentBtnEl.addEventListener('click', () => {
    addAgentModalEl.classList.remove('hidden');
  });

  closeModalBtnEl.addEventListener('click', hideModal);
  cancelAddAgentBtnEl.addEventListener('click', hideModal);

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
    void sendMessage();
  });
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

  clearAllAgentsBtnEl.addEventListener('click', () => {
    void clearAllAgents();
  });
}

function hideModal() {
  addAgentModalEl.classList.add('hidden');
}

function onDocumentClick(event: MouseEvent) {
  if (!modelSelectorOpen) {
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

function closeCurrentAgentModelMenu() {
  modelSelectorOpen = false;
  currentAgentModelBtnEl.setAttribute('aria-expanded', 'false');
  currentAgentModelMenuEl.classList.add('hidden');
}

async function toggleCurrentAgentModelMenu() {
  const agent = currentAgentId ? agents.find((item) => item.id === currentAgentId) : null;
  if (!agent || agent.status !== 'connected') {
    return;
  }

  if (modelSelectorOpen) {
    closeCurrentAgentModelMenu();
    return;
  }

  modelSelectorOpen = true;
  currentAgentModelBtnEl.setAttribute('aria-expanded', 'true');
  currentAgentModelMenuEl.classList.remove('hidden');
  currentAgentModelMenuEl.innerHTML = '<div class="model-selector-state">正在加载模型列表...</div>';

  const options = await loadAgentModelOptions(agent);
  if (!modelSelectorOpen || currentAgentId !== agent.id) {
    return;
  }
  renderCurrentAgentModelMenu(agent, options);
}

function resolveModelDisplayName(option: ModelOption): string {
  const label = option.label.trim();
  const value = option.value.trim();
  return label.length > 0 ? label : value;
}

function isModelOptionActive(agent: Agent, option: ModelOption, index: number): boolean {
  const selected = agent.selectedModel?.trim().toLowerCase();
  if (!selected) {
    return index === 0;
  }
  return (
    option.value.trim().toLowerCase() === selected || option.label.trim().toLowerCase() === selected
  );
}

function renderCurrentAgentModelMenu(agent: Agent, options: ModelOption[]) {
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

async function onCurrentAgentModelMenuClick(event: MouseEvent) {
  const target = event.target as HTMLElement;
  const optionBtn = target.closest('button[data-model-value]') as HTMLButtonElement | null;
  if (!optionBtn) {
    return;
  }

  const modelName = optionBtn.dataset.modelValue?.trim();
  const agent = currentAgentId ? agents.find((item) => item.id === currentAgentId) : null;
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

function updateCurrentAgentModelUI() {
  const agent = currentAgentId ? agents.find((item) => item.id === currentAgentId) : null;
  if (!agent) {
    currentAgentModelBtnEl.disabled = true;
    currentAgentModelTextEl.textContent = '模型：未连接';
    closeCurrentAgentModelMenu();
    return;
  }

  if (modelSwitchingAgentId === agent.id) {
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

function normalizeToolCallStatus(rawStatus: string | undefined): ToolCall['status'] {
  if (rawStatus === 'running' || rawStatus === 'completed' || rawStatus === 'error') {
    return rawStatus;
  }
  return 'pending';
}

function normalizeToolCallItem(raw: ToolCall): ToolCall {
  return {
    id: raw.id?.trim() || `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: raw.name?.trim() || 'unknown_tool',
    status: normalizeToolCallStatus(raw.status),
    arguments: raw.arguments,
    output: typeof raw.output === 'string' ? raw.output : undefined,
  };
}

function mergeToolCalls(agentId: string, incoming: ToolCall[]) {
  const current = toolCallsByAgent[agentId] || [];
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

  toolCallsByAgent[agentId] = merged;
  if (agentId === currentAgentId) {
    showToolCalls(merged);
  }
}

function resetToolCallsForAgent(agentId: string) {
  delete toolCallsByAgent[agentId];
  if (agentId === currentAgentId) {
    toolCallsListEl.innerHTML = '';
    toolCallsPanelEl.classList.add('hidden');
  }
}

function onAgentListClick(event: MouseEvent) {
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

function onSessionListClick(event: MouseEvent) {
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

async function clearAllAgents() {
  if (!confirm('确定要删除所有 Agent 吗？')) {
    return;
  }

  for (const agent of agents) {
    if (agent.status !== 'connected') {
      continue;
    }
    try {
      await invoke('disconnect_agent', { agentId: agent.id });
    } catch (e) {
      console.error('断开连接失败:', e);
    }
  }

  agents = [];
  currentAgentId = null;
  currentSessionId = null;
  messages = [];
  sessionsByAgent = {};
  messagesBySession = {};
  inflightSessionByAgent = {};
  registryByAgent = {};
  toolCallsByAgent = {};
  modelOptionsCacheByAgent = {};
  modelSwitchingAgentId = null;
  hideSlashCommandMenu();
  closeCurrentAgentModelMenu();

  await saveAgents();
  await saveSessions();
  await saveSessionMessages();

  renderAgentList();
  renderSessionList();
  renderMessages();
  toolCallsPanelEl.classList.add('hidden');
  currentAgentNameEl.textContent = '选择一个 Agent';
  updateAgentStatusUI('disconnected');
  updateCurrentAgentModelUI();
  updateConnectionStatus(false);
  refreshComposerState();
}

// 添加 Agent
async function addAgent(name: string, iflowPath: string, workspacePath: string) {
  try {
    showLoading('正在连接 iFlow...');

    const agentId = `iflow-${Date.now()}`;
    const result = await invoke<{
      success: boolean;
      port: number;
      error?: string;
    }>('connect_iflow', {
      agentId,
      iflowPath,
      workspacePath,
      model: null,
    });

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

    agents.push(agent);
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
function selectAgent(agentId: string) {
  closeCurrentAgentModelMenu();
  currentAgentId = agentId;
  const agent = agents.find((a) => a.id === agentId);
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
    currentSessionId = null;
    messages = [];
    renderMessages();
    renderSessionList();
  }

  renderAgentList();
  updateCurrentAgentModelUI();
  updateConnectionStatus(isConnected);
  const existingToolCalls = toolCallsByAgent[agentId] || [];
  if (existingToolCalls.length > 0) {
    showToolCalls(existingToolCalls);
  } else {
    toolCallsPanelEl.classList.add('hidden');
  }
  refreshComposerState();
  if (isConnected) {
    void loadAgentModelOptions(agent).then(() => {
      if (currentAgentId === agent.id) {
        updateCurrentAgentModelUI();
      }
    });
  }
}

async function deleteAgent(agentId: string) {
  if (!confirm('确定要删除这个 Agent 吗？')) {
    return;
  }

  const agent = agents.find((a) => a.id === agentId);
  if (agent?.status === 'connected') {
    try {
      await invoke('disconnect_agent', { agentId });
    } catch (e) {
      console.error('断开连接失败:', e);
    }
  }

  agents = agents.filter((a) => a.id !== agentId);
  if (modelSwitchingAgentId === agentId) {
    modelSwitchingAgentId = null;
  }
  delete inflightSessionByAgent[agentId];
  delete registryByAgent[agentId];
  delete toolCallsByAgent[agentId];
  delete modelOptionsCacheByAgent[agentId];

  const removedSessions = sessionsByAgent[agentId] || [];
  delete sessionsByAgent[agentId];
  for (const session of removedSessions) {
    delete messagesBySession[session.id];
  }

  if (currentAgentId === agentId) {
    closeCurrentAgentModelMenu();
    currentAgentId = null;
    currentSessionId = null;
    messages = [];
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

// 渲染 Agent 列表
function renderAgentList() {
  agentListEl.innerHTML = agents
    .map(
      (agent) => `
    <div class="agent-item ${agent.id === currentAgentId ? 'active' : ''}" data-agent-id="${agent.id}">
      <div class="agent-icon">iF</div>
      <div class="agent-info">
        <div class="agent-name">${escapeHtml(agent.name)}</div>
        <div class="agent-status" title="${escapeHtml(agent.workspacePath)}">${escapeHtml(getWorkspaceName(agent.workspacePath))}</div>
        <div class="agent-meta">ID: ${escapeHtml(shortAgentId(agent.id))}</div>
      </div>
      <div class="agent-actions">
        <div class="status-indicator ${agent.status}"></div>
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

function renderSessionList() {
  if (!currentAgentId) {
    sessionListEl.innerHTML = '<div class="session-empty">选择 Agent 后显示会话历史</div>';
    return;
  }

  const sessionList = getSessionsForAgent(currentAgentId);
  if (sessionList.length === 0) {
    sessionListEl.innerHTML = '<div class="session-empty">暂无会话，点击右上角「新建会话」</div>';
    return;
  }

  sessionListEl.innerHTML = sessionList
    .map((session) => {
      const messageCount = (messagesBySession[session.id] || []).length;
      return `
      <div class="session-item ${session.id === currentSessionId ? 'active' : ''}" data-session-id="${session.id}">
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

async function deleteSession(sessionId: string) {
  if (!currentAgentId) {
    return;
  }

  if (inflightSessionByAgent[currentAgentId] === sessionId) {
    showError('该会话正在回复中，暂时无法删除');
    return;
  }

  const currentSessions = sessionsByAgent[currentAgentId] || [];
  if (!currentSessions.some((session) => session.id === sessionId)) {
    return;
  }

  sessionsByAgent[currentAgentId] = currentSessions.filter((session) => session.id !== sessionId);
  delete messagesBySession[sessionId];

  if (sessionsByAgent[currentAgentId].length === 0) {
    const fallback = createSession(currentAgentId, '默认会话');
    sessionsByAgent[currentAgentId].push(fallback);
    messagesBySession[fallback.id] = [];
  }

  const ordered = getSessionsForAgent(currentAgentId);
  const nextSessionId = ordered[0]?.id || null;

  if (currentSessionId === sessionId) {
    currentSessionId = null;
    messages = [];
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

async function reconnectAgent(agentId: string) {
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) {
    return;
  }

  agent.status = 'connecting';
  renderAgentList();

  try {
    const result = await invoke<{
      success: boolean;
      port: number;
      error?: string;
    }>('connect_iflow', {
      agentId: agent.id,
      iflowPath: agent.iflowPath || 'iflow',
      workspacePath: agent.workspacePath,
      model: agent.selectedModel || null,
    });

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
function updateAgentStatusUI(status: Agent['status']) {
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
function updateConnectionStatus(connected: boolean) {
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
let messageTimeout: number | null = null;
const MESSAGE_TIMEOUT_MS = 60000;

interface ParsedModelSlashCommand {
  kind: 'help' | 'switch' | 'current';
  targetModel?: string;
  filterKeyword?: string;
}

function parseModelSlashCommand(content: string): ParsedModelSlashCommand | null {
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

function normalizeModelOption(raw: unknown): ModelOption | null {
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

function filterModelOptions(models: ModelOption[], keyword?: string): ModelOption[] {
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

function formatModelItem(item: ModelOption, index: number): string {
  const labelDiffers = item.label.toLowerCase() !== item.value.toLowerCase();
  return labelDiffers ? `${index}. ${item.value}（${item.label}）` : `${index}. ${item.value}`;
}

async function loadAgentModelOptions(agent: Agent, forceRefresh = false): Promise<ModelOption[]> {
  if (!forceRefresh && modelOptionsCacheByAgent[agent.id] && modelOptionsCacheByAgent[agent.id].length > 0) {
    return modelOptionsCacheByAgent[agent.id];
  }

  try {
    const raw = await invoke<unknown[]>('list_available_models', {
      iflowPath: agent.iflowPath || 'iflow',
    });
    const normalized = Array.isArray(raw)
      ? raw.map((item) => normalizeModelOption(item)).filter((item): item is ModelOption => Boolean(item))
      : [];
    if (normalized.length > 0) {
      modelOptionsCacheByAgent[agent.id] = normalized;
      if (currentAgentId === agent.id) {
        updateCurrentAgentModelUI();
      }
    }
    return normalized;
  } catch (error) {
    console.error('Load model list error:', error);
    return [];
  }
}

function resolveModelName(input: string, models: ModelOption[]): {
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

function formatModelList(models: ModelOption[], keyword?: string): string {
  const filtered = filterModelOptions(models, keyword);
  if (filtered.length === 0) {
    return `🧠 未找到匹配模型：${keyword || ''}\n可先输入 /model list 查看全部模型`;
  }

  const lines = filtered.map((model, index) => formatModelItem(model, index + 1));

  const suffix = keyword ? `（筛选：${keyword}）` : '';
  return `🧠 可选模型${suffix}：\n${lines.join('\n')}\n\n用法：\n/model current\n/model <模型名>\n/model <编号>\n示例：/model 1`;
}

function commitSessionMessages(sessionId: string, sessionMessages: Message[]) {
  messagesBySession[sessionId] = sessionMessages;
  touchSessionById(sessionId, sessionMessages);
  void saveSessionMessages();

  if (sessionId === currentSessionId) {
    messages = sessionMessages;
    renderMessages();
    scrollToBottom();
  } else {
    renderSessionList();
  }
}

function currentAgentModelLabel(agent: Agent): string {
  const selected = agent.selectedModel?.trim();
  if (selected && selected.length > 0) {
    return selected;
  }

  const cached = modelOptionsCacheByAgent[agent.id];
  if (cached && cached.length > 0) {
    return `${resolveModelDisplayName(cached[0])}（默认）`;
  }
  return 'iFlow 默认模型';
}

function parseAboutPayload(content: string): Record<string, unknown> | null {
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

function extractModelNameFromAboutPayload(payload: Record<string, unknown>): string | null {
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

function syncAgentModelFromAboutContent(agentId: string, content: string) {
  const aboutPayload = parseAboutPayload(content);
  if (!aboutPayload) {
    return;
  }

  const detectedModel = extractModelNameFromAboutPayload(aboutPayload);
  if (!detectedModel) {
    return;
  }

  const agent = agents.find((item) => item.id === agentId);
  if (!agent || agent.selectedModel === detectedModel) {
    return;
  }

  agent.selectedModel = detectedModel;
  void saveAgents();
  renderAgentList();
  if (currentAgentId === agentId) {
    updateCurrentAgentModelUI();
  }
}

async function switchAgentModel(agent: Agent, modelName: string): Promise<string | null> {
  const targetModel = modelName.trim();
  if (!targetModel) {
    return '模型名称不能为空';
  }

  modelSwitchingAgentId = agent.id;
  agent.status = 'connecting';
  renderAgentList();
  if (currentAgentId === agent.id) {
    updateAgentStatusUI(agent.status);
  }
  refreshComposerState();

  try {
    const result = await invoke<{
      success: boolean;
      port: number;
      error?: string;
    }>('switch_agent_model', {
      agentId: agent.id,
      iflowPath: agent.iflowPath || 'iflow',
      workspacePath: agent.workspacePath,
      model: targetModel,
    });

    if (!result.success) {
      throw new Error(result.error || '模型切换失败');
    }

    agent.status = 'connected';
    agent.port = result.port;
    agent.selectedModel = targetModel;
    await saveAgents();
    renderAgentList();
    if (currentAgentId === agent.id) {
      updateAgentStatusUI(agent.status);
    }
    refreshComposerState();
    return null;
  } catch (error) {
    console.error('Model switch error:', error);
    agent.status = 'error';
    await saveAgents();
    renderAgentList();
    if (currentAgentId === agent.id) {
      updateAgentStatusUI(agent.status);
    }
    refreshComposerState();
    return String(error);
  } finally {
    modelSwitchingAgentId = null;
    if (currentAgentId === agent.id) {
      updateCurrentAgentModelUI();
    }
  }
}

async function handleLocalModelCommand(
  content: string,
  agentId: string,
  sessionId: string
): Promise<boolean> {
  const command = parseModelSlashCommand(content);
  if (!command) {
    return false;
  }

  const agent = agents.find((item) => item.id === agentId);
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
      ? modelOptionsCacheByAgent[agent.id] || []
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

async function sendMessage() {
  const content = messageInputEl.value.trim();
  const requestAgentId = currentAgentId;
  const requestSessionId = currentSessionId;
  if (!content || !requestAgentId || !requestSessionId || inflightSessionByAgent[requestAgentId]) {
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
  messages.push(sendingMessage);
  renderMessages();
  scrollToBottom();

  const userMessage: Message = {
    id: `msg-${Date.now()}`,
    role: 'user',
    content,
    timestamp: new Date(),
  };
  messages.push(userMessage);
  touchCurrentSession();
  renderMessages();
  scrollToBottom();
  inflightSessionByAgent[requestAgentId] = requestSessionId;
  refreshComposerState();

  try {
    await invoke('send_message', {
      agentId: requestAgentId,
      content,
    });

    messages = messages.filter((m) => m.id !== sendingMessage.id);
    renderMessages();

    messageTimeout = window.setTimeout(() => {
      const timeoutMessage: Message = {
        id: `msg-${Date.now()}-timeout`,
        role: 'system',
        content:
          '⏱️ 响应超时（60秒）。可能原因：\n1. iFlow 正在处理复杂任务\n2. 连接已断开\n3. iFlow 服务异常\n\n你可以：\n- 等待更长时间\n- 检查 iFlow 状态\n- 重新连接 Agent',
        timestamp: new Date(),
      };
      messages.push(timeoutMessage);
      renderMessages();

      delete inflightSessionByAgent[requestAgentId];
      refreshComposerState();
      showError('响应超时，请检查连接状态');
    }, MESSAGE_TIMEOUT_MS);
  } catch (error) {
    messages = messages.filter((m) => m.id !== sendingMessage.id);
    renderMessages();

    showError(`发送失败: ${String(error)}`);
    delete inflightSessionByAgent[requestAgentId];
    refreshComposerState();
  }
}

// 显示工具调用
function showToolCalls(toolCalls: ToolCall[]) {
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
    </div>
  `
    )
    .join('');

  toolCallsPanelEl.classList.remove('hidden');
}

// 渲染消息
function renderMessages() {
  persistCurrentSessionMessages();
  const thinkingIndicator = isCurrentAgentBusy()
    ? `<div class="thinking-indicator" aria-live="polite" aria-label="iFlow 正在思考">🤔</div>`
    : '';

  if (messages.length === 0) {
    const title = currentSessionId ? '当前会话暂无消息' : '👋 欢迎使用 iFlow Workspace';
    const hint = currentSessionId
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
    messages
      .map((msg) => {
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
      return `
      <div class="message ${msg.role}">
        <div class="message-avatar">${avatar}</div>
        <div class="message-content">
          ${formatMessageContent(msg.content)}
          <div class="message-time">${formatTime(msg.timestamp)}</div>
        </div>
      </div>
    `;
      })
      .join('') + thinkingIndicator;
}

// 开始新会话
function startNewSession() {
  if (!currentAgentId) {
    return;
  }

  const index = (sessionsByAgent[currentAgentId]?.length || 0) + 1;
  const session = createSession(currentAgentId, `会话 ${index}`);

  if (!sessionsByAgent[currentAgentId]) {
    sessionsByAgent[currentAgentId] = [];
  }
  sessionsByAgent[currentAgentId].push(session);
  messagesBySession[session.id] = [];

  currentSessionId = session.id;
  messages = [];

  void saveSessions();
  void saveSessionMessages();
  renderSessionList();
  renderMessages();
  refreshComposerState();
}

// 清空当前会话
function clearChat() {
  if (!currentSessionId) {
    return;
  }

  messages = [];
  messagesBySession[currentSessionId] = [];
  touchCurrentSession();
  renderMessages();
  renderSessionList();
  refreshComposerState();
}

function selectSession(sessionId: string) {
  if (!currentAgentId) {
    return;
  }

  const session = (sessionsByAgent[currentAgentId] || []).find((item) => item.id === sessionId);
  if (!session) {
    return;
  }

  currentSessionId = sessionId;
  messages = getMessagesForSession(sessionId);
  renderSessionList();
  renderMessages();
  scrollToBottom();
  refreshComposerState();
}

// 滚动到底部
function scrollToBottom() {
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

function createSession(agentId: string, title = '新会话'): Session {
  const now = new Date();
  return {
    id: `sess-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
    agentId,
    title,
    createdAt: now,
    updatedAt: now,
  };
}

function ensureAgentHasSessions(agentId: string) {
  if (!sessionsByAgent[agentId]) {
    sessionsByAgent[agentId] = [];
  }
  if (sessionsByAgent[agentId].length > 0) {
    return;
  }

  const session = createSession(agentId, '默认会话');
  sessionsByAgent[agentId] = [session];
  messagesBySession[session.id] = [];
}

function getSessionsForAgent(agentId: string): Session[] {
  return [...(sessionsByAgent[agentId] || [])].sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime()
  );
}

function getMessagesForSession(sessionId: string): Message[] {
  return (messagesBySession[sessionId] || []).map((msg) => ({
    ...msg,
    timestamp: new Date(msg.timestamp),
  }));
}

function touchCurrentSession() {
  if (!currentAgentId || !currentSessionId) {
    return;
  }
  const session = (sessionsByAgent[currentAgentId] || []).find((item) => item.id === currentSessionId);
  if (!session) {
    return;
  }
  session.updatedAt = new Date();

  void saveSessions();
  renderSessionList();
}

function touchSessionById(sessionId: string, sessionMessages?: Message[]) {
  for (const sessionList of Object.values(sessionsByAgent)) {
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

function maybeGenerateSessionTitle(session: Session, sessionMessages: Message[]) {
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

function makeSessionTitleFromDialogue(userContent: string, assistantContent: string): string {
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

function getLatestDialoguePair(
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

function composeKeywordTitle(userPhrases: string[], assistantPhrases: string[]): string {
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

function appendTitleKeyword(target: string[], phrase: string) {
  const keyword = toTitleKeyword(phrase);
  if (!keyword || target.includes(keyword)) {
    return;
  }
  target.push(keyword);
}

function toTitleKeyword(phrase: string): string {
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

function isInformativeTitlePhrase(phrase: string): boolean {
  const chineseChars = phrase.match(/[\u4e00-\u9fff]/g) || [];
  if (chineseChars.length >= 2) {
    return true;
  }

  const englishWords = phrase.match(/[a-zA-Z0-9_-]{3,}/g) || [];
  return englishWords.length > 0;
}

function extractTitlePhrases(content: string): string[] {
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

function makeSessionTitle(content: string): string {
  const oneLine = content.replace(/\s+/g, ' ').trim();
  if (!oneLine) {
    return '新会话';
  }
  if (oneLine.length <= 18) {
    return oneLine;
  }
  return `${oneLine.slice(0, 18)}...`;
}

function normalizeTitleSource(content: string): string {
  return content.replace(/\s+/g, ' ').trim();
}

function shortAgentId(agentId: string): string {
  return agentId.length > 8 ? agentId.slice(-8) : agentId;
}

function getWorkspaceName(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : workspacePath;
}

function streamTypeToRole(messageType?: StreamMessageType): Message['role'] {
  if (messageType === 'thought') {
    return 'thought';
  }
  if (messageType === 'system' || messageType === 'plan') {
    return 'system';
  }
  return 'assistant';
}

function normalizeStoredRole(role: string): Message['role'] {
  if (role === 'user' || role === 'assistant' || role === 'system' || role === 'thought') {
    return role;
  }
  return 'assistant';
}

function parseStoredSession(session: StoredSession): Session {
  const normalizedTitle =
    typeof session.title === 'string' && session.title.trim().length > 0
      ? session.title
      : '新会话';

  return {
    ...session,
    title: normalizedTitle,
    createdAt: new Date(session.createdAt),
    updatedAt: new Date(session.updatedAt),
  };
}

function toStoredSession(session: Session): StoredSession {
  return {
    ...session,
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
  };
}

function parseStoredMessage(message: StoredMessage): Message {
  return {
    ...message,
    role: normalizeStoredRole(message.role),
    timestamp: new Date(message.timestamp),
  };
}

function toStoredMessage(message: Message): StoredMessage {
  return {
    ...message,
    timestamp: message.timestamp.toISOString(),
  };
}

function persistCurrentSessionMessages() {
  if (!currentSessionId) {
    return;
  }
  messagesBySession[currentSessionId] = messages.map((msg) => ({
    ...msg,
    timestamp: new Date(msg.timestamp),
  }));
  void saveSessionMessages();
}

function buildStoredSessionMap(): StoredSessionMap {
  const payload: StoredSessionMap = {};
  for (const [agentId, sessionList] of Object.entries(sessionsByAgent)) {
    payload[agentId] = sessionList.map(toStoredSession);
  }
  return payload;
}

function buildStoredMessageMap(): StoredMessageMap {
  const payload: StoredMessageMap = {};
  for (const [sessionId, sessionMessages] of Object.entries(messagesBySession)) {
    payload[sessionId] = sessionMessages.map(toStoredMessage);
  }
  return payload;
}

function buildStorageSnapshot(): StorageSnapshot {
  return {
    sessionsByAgent: buildStoredSessionMap(),
    messagesBySession: buildStoredMessageMap(),
  };
}

function normalizeStoredSessions(parsed: StoredSessionMap | null | undefined): Record<string, Session[]> {
  const normalized: Record<string, Session[]> = {};
  if (!parsed) {
    return normalized;
  }
  for (const [agentId, storedSessions] of Object.entries(parsed)) {
    normalized[agentId] = Array.isArray(storedSessions) ? storedSessions.map(parseStoredSession) : [];
  }
  return normalized;
}

function normalizeStoredMessages(parsed: StoredMessageMap | null | undefined): Record<string, Message[]> {
  const normalized: Record<string, Message[]> = {};
  if (!parsed) {
    return normalized;
  }
  for (const [sessionId, storedMessages] of Object.entries(parsed)) {
    normalized[sessionId] = Array.isArray(storedMessages) ? storedMessages.map(parseStoredMessage) : [];
  }
  return normalized;
}

function readStorageSnapshotFromLocalStorage(): StorageSnapshot | null {
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

function clearLocalStorageSessionData() {
  localStorage.removeItem(SESSIONS_STORAGE_KEY);
  localStorage.removeItem(SESSION_MESSAGES_STORAGE_KEY);
}

async function loadStorageSnapshot(): Promise<StorageSnapshot | null> {
  try {
    const snapshot = await invoke<StorageSnapshot>('load_storage_snapshot');
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

async function saveStorageSnapshot(snapshot: StorageSnapshot): Promise<boolean> {
  try {
    await invoke('save_storage_snapshot', { snapshot });
    return true;
  } catch (e) {
    console.error('Failed to save session storage to backend:', e);
    return false;
  }
}

async function persistStorageSnapshot(snapshot: StorageSnapshot): Promise<boolean> {
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

function isStorageSnapshotEmpty(snapshot: StorageSnapshot): boolean {
  return (
    Object.keys(snapshot.sessionsByAgent).length === 0 &&
    Object.keys(snapshot.messagesBySession).length === 0
  );
}

async function loadSessionStore() {
  const backendSnapshot = await loadStorageSnapshot();
  if (backendSnapshot) {
    sessionsByAgent = normalizeStoredSessions(backendSnapshot.sessionsByAgent);
    messagesBySession = normalizeStoredMessages(backendSnapshot.messagesBySession);

    if (isStorageSnapshotEmpty(backendSnapshot)) {
      const localSnapshot = readStorageSnapshotFromLocalStorage();
      if (localSnapshot) {
        sessionsByAgent = normalizeStoredSessions(localSnapshot.sessionsByAgent);
        messagesBySession = normalizeStoredMessages(localSnapshot.messagesBySession);
        await persistStorageSnapshot(localSnapshot);
      }
    }
    return;
  }

  const localSnapshot = readStorageSnapshotFromLocalStorage();
  if (!localSnapshot) {
    sessionsByAgent = {};
    messagesBySession = {};
    return;
  }

  sessionsByAgent = normalizeStoredSessions(localSnapshot.sessionsByAgent);
  messagesBySession = normalizeStoredMessages(localSnapshot.messagesBySession);
}

async function saveSessions() {
  await persistStorageSnapshot(buildStorageSnapshot());
}

async function saveSessionMessages() {
  await persistStorageSnapshot(buildStorageSnapshot());
}

async function migrateLegacyHistoryIfNeeded() {
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
      if (!sessionsByAgent[agentId] || sessionsByAgent[agentId].length === 0) {
        const migratedSession = createSession(agentId, '历史会话');
        sessionsByAgent[agentId] = [migratedSession];
      }

      const targetSession = sessionsByAgent[agentId][0];
      const normalizedMessages = storedMessages.map(parseStoredMessage);
      messagesBySession[targetSession.id] = normalizedMessages;

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

function pruneSessionDataByAgents() {
  const liveAgentIds = new Set(agents.map((agent) => agent.id));

  const prunedSessions: Record<string, Session[]> = {};
  for (const [agentId, sessionList] of Object.entries(sessionsByAgent)) {
    if (!liveAgentIds.has(agentId)) {
      continue;
    }
    prunedSessions[agentId] = sessionList;
  }
  sessionsByAgent = prunedSessions;

  const liveSessionIds = new Set(
    Object.values(sessionsByAgent)
      .flat()
      .map((session) => session.id)
  );

  const prunedMessages: Record<string, Message[]> = {};
  for (const [sessionId, sessionMessages] of Object.entries(messagesBySession)) {
    if (liveSessionIds.has(sessionId)) {
      prunedMessages[sessionId] = sessionMessages;
    }
  }
  messagesBySession = prunedMessages;
}

// 加载 Agent 列表
async function loadAgents() {
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

    agents = JSON.parse(saved) as Agent[];
    agents = agents.map((agent) => ({
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
async function saveAgents() {
  try {
    localStorage.setItem(AGENTS_STORAGE_KEY, JSON.stringify(agents));
  } catch (e) {
    console.error('Failed to save agents:', e);
  }
}

// 工具函数
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function formatMessageContent(text: string): string {
  return escapeHtml(text).replace(/\n/g, '<br>');
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatSessionMeta(updatedAt: Date, messageCount: number): string {
  const timeText = updatedAt.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${messageCount} 条消息 · ${timeText}`;
}

function showLoading(message: string) {
  console.log('Loading:', message);
}

function hideLoading() {
  console.log('Loading hidden');
}

function showSuccess(message: string) {
  console.log('Success:', message);
}

function showError(message: string) {
  console.error('Error:', message);
  alert(message);
}

// 启动应用
console.log('Starting app...');
init().catch(console.error);

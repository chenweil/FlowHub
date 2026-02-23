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
const toolCallsPanelEl = document.getElementById('tool-calls-panel') as HTMLDivElement;
const toolCallsListEl = document.getElementById('tool-calls-list') as HTMLDivElement;
const closeToolPanelBtnEl = document.getElementById('close-tool-panel') as HTMLButtonElement;
const newSessionBtnEl = document.getElementById('new-session-btn') as HTMLButtonElement;
const clearChatBtnEl = document.getElementById('clear-chat-btn') as HTMLButtonElement;
const connectionStatusEl = document.getElementById('connection-status') as HTMLDivElement;
const clearAllAgentsBtnEl = document.getElementById('clear-all-agents') as HTMLButtonElement;
const inputStatusHintEl = document.getElementById('input-status-hint') as HTMLSpanElement;

// 类型定义
interface Agent {
  id: string;
  name: string;
  type: string;
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  workspacePath: string;
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

// 状态
let agents: Agent[] = [];
let currentAgentId: string | null = null;
let currentSessionId: string | null = null;
let messages: Message[] = [];

let sessionsByAgent: Record<string, Session[]> = {};
let messagesBySession: Record<string, Message[]> = {};
let inflightSessionByAgent: Record<string, string> = {};

type ComposerState = 'ready' | 'busy' | 'disabled';
type StreamMessageType = 'content' | 'thought' | 'system' | 'plan';

const AGENTS_STORAGE_KEY = 'iflow-agents';
const SESSIONS_STORAGE_KEY = 'iflow-sessions';
const SESSION_MESSAGES_STORAGE_KEY = 'iflow-session-messages';
const LEGACY_MESSAGE_HISTORY_STORAGE_KEY = 'iflow-message-history';

// 初始化
async function init() {
  console.log('Initializing app...');
  await loadAgents();
  setupEventListeners();
  setupTauriEventListeners();
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
    return;
  }

  messageInputEl.disabled = true;
  sendBtnEl.disabled = true;
  messageInputEl.placeholder = state === 'busy' ? '正在回复中，请等待...' : '请选择 Agent 后开始对话...';
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
    if (payload.agentId === currentAgentId && Array.isArray(payload.toolCalls)) {
      showToolCalls(payload.toolCalls);
    }
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
  messagesBySession[sessionId] = sessionMessages;
  touchSessionById(sessionId);
  void saveSessionMessages();

  if (sessionId === currentSessionId) {
    messages = sessionMessages;
    renderMessages();
    scrollToBottom();
  } else {
    renderSessionList();
  }
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  });

  messageInputEl.addEventListener('input', () => {
    messageInputEl.style.height = 'auto';
    messageInputEl.style.height = `${messageInputEl.scrollHeight}px`;
  });

  sendBtnEl.addEventListener('click', () => {
    void sendMessage();
  });
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

  await saveAgents();
  await saveSessions();
  await saveSessionMessages();

  renderAgentList();
  renderSessionList();
  renderMessages();
  currentAgentNameEl.textContent = '选择一个 Agent';
  updateAgentStatusUI('disconnected');
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
  currentAgentId = agentId;
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) {
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
  updateConnectionStatus(isConnected);
  refreshComposerState();
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
  delete inflightSessionByAgent[agentId];

  const removedSessions = sessionsByAgent[agentId] || [];
  delete sessionsByAgent[agentId];
  for (const session of removedSessions) {
    delete messagesBySession[session.id];
  }

  if (currentAgentId === agentId) {
    currentAgentId = null;
    currentSessionId = null;
    messages = [];
    renderMessages();
    currentAgentNameEl.textContent = '选择一个 Agent';
    updateAgentStatusUI('disconnected');
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
      iflowPath: 'iflow',
      workspacePath: agent.workspacePath,
    });

    if (!result.success) {
      agent.status = 'error';
      showError(result.error || '连接失败');
      renderAgentList();
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

async function sendMessage() {
  const content = messageInputEl.value.trim();
  const requestAgentId = currentAgentId;
  const requestSessionId = currentSessionId;
  if (!content || !requestAgentId || !requestSessionId || inflightSessionByAgent[requestAgentId]) {
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
  touchCurrentSession(content);
  renderMessages();
  scrollToBottom();

  messageInputEl.value = '';
  messageInputEl.style.height = 'auto';
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
  toolCallsListEl.innerHTML = toolCalls
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

function touchCurrentSession(firstUserContent?: string) {
  if (!currentAgentId || !currentSessionId) {
    return;
  }
  const session = (sessionsByAgent[currentAgentId] || []).find((item) => item.id === currentSessionId);
  if (!session) {
    return;
  }

  if (firstUserContent && (session.title === '默认会话' || session.title.startsWith('会话 '))) {
    session.title = makeSessionTitle(firstUserContent);
  }
  session.updatedAt = new Date();

  void saveSessions();
  renderSessionList();
}

function touchSessionById(sessionId: string) {
  for (const sessionList of Object.values(sessionsByAgent)) {
    const session = sessionList.find((item) => item.id === sessionId);
    if (!session) {
      continue;
    }
    session.updatedAt = new Date();
    void saveSessions();
    return;
  }
}

function makeSessionTitle(content: string): string {
  const oneLine = content.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= 18) {
    return oneLine;
  }
  return `${oneLine.slice(0, 18)}...`;
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
  return {
    ...session,
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

async function loadSessions() {
  try {
    const raw = localStorage.getItem(SESSIONS_STORAGE_KEY);
    if (!raw) {
      sessionsByAgent = {};
      return;
    }

    const parsed = JSON.parse(raw) as StoredSessionMap;
    const normalized: Record<string, Session[]> = {};
    for (const [agentId, storedSessions] of Object.entries(parsed)) {
      normalized[agentId] = Array.isArray(storedSessions)
        ? storedSessions.map(parseStoredSession)
        : [];
    }
    sessionsByAgent = normalized;
  } catch (e) {
    console.error('Failed to load sessions:', e);
    sessionsByAgent = {};
  }
}

async function saveSessions() {
  try {
    const payload: StoredSessionMap = {};
    for (const [agentId, sessionList] of Object.entries(sessionsByAgent)) {
      payload[agentId] = sessionList.map(toStoredSession);
    }
    localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.error('Failed to save sessions:', e);
  }
}

async function loadSessionMessages() {
  try {
    const raw = localStorage.getItem(SESSION_MESSAGES_STORAGE_KEY);
    if (!raw) {
      messagesBySession = {};
      return;
    }

    const parsed = JSON.parse(raw) as StoredMessageMap;
    const normalized: Record<string, Message[]> = {};
    for (const [sessionId, storedMessages] of Object.entries(parsed)) {
      normalized[sessionId] = Array.isArray(storedMessages)
        ? storedMessages.map(parseStoredMessage)
        : [];
    }
    messagesBySession = normalized;
  } catch (e) {
    console.error('Failed to load session messages:', e);
    messagesBySession = {};
  }
}

async function saveSessionMessages() {
  try {
    const payload: StoredMessageMap = {};
    for (const [sessionId, sessionMessages] of Object.entries(messagesBySession)) {
      payload[sessionId] = sessionMessages.map(toStoredMessage);
    }
    localStorage.setItem(SESSION_MESSAGES_STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.error('Failed to save session messages:', e);
  }
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
    await loadSessions();
    await loadSessionMessages();
    await migrateLegacyHistoryIfNeeded();

    const saved = localStorage.getItem(AGENTS_STORAGE_KEY);
    if (!saved) {
      renderAgentList();
      renderSessionList();
      return;
    }

    agents = JSON.parse(saved) as Agent[];
    agents = agents.map((agent) => ({
      ...agent,
      status: 'disconnected' as const,
      port: undefined,
    }));

    pruneSessionDataByAgents();
    await saveAgents();
    await saveSessions();
    await saveSessionMessages();

    renderAgentList();
    renderSessionList();
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

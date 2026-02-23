// iFlow Workspace - Main Entry
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// DOM 元素
const addAgentBtnEl = document.getElementById('add-agent-btn') as HTMLButtonElement;
const agentListEl = document.getElementById('agent-list') as HTMLDivElement;
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

// 类型定义
interface Agent {
  id: string;
  name: string;
  type: string;
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  workspacePath: string;
  port?: number;
}

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  agentId?: string;
  toolCalls?: ToolCall[];
}

interface ToolCall {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  arguments?: Record<string, any>;
  output?: string;
}

// 状态
let agents: Agent[] = [];
let currentAgentId: string | null = null;
let messages: Message[] = [];
let isConnecting = false;
let isReceiving = false;

// 初始化
async function init() {
  console.log('Initializing app...');
  await loadAgents();
  setupEventListeners();
  setupTauriEventListeners();
  console.log('App initialized');
}

// 设置 Tauri 事件监听
function setupTauriEventListeners() {
  console.log('Setting up Tauri event listeners...');
  
  // 监听流式消息
  listen('stream-message', (event) => {
    console.log('Received stream-message event:', event);
    const payload = event.payload as any;
    if (payload.agentId === currentAgentId) {
      // 清除超时
      if (messageTimeout) {
        clearTimeout(messageTimeout);
        messageTimeout = null;
      }
      
      // 移除"处理中"消息
      messages = messages.filter(m => 
        !m.id.includes('-sending') && !m.id.includes('-processing')
      );
      
      appendStreamMessage(payload.content);
    }
  });
  
  // 监听工具调用
  listen('tool-call', (event) => {
    console.log('Received tool-call event:', event);
    const payload = event.payload as any;
    if (payload.agentId === currentAgentId) {
      showToolCalls(payload.toolCalls);
    }
  });
  
  // 监听任务完成
  listen('task-finish', (event) => {
    console.log('Received task-finish event:', event);
    const payload = event.payload as any;
    if (payload.agentId === currentAgentId) {
      // 清除超时
      if (messageTimeout) {
        clearTimeout(messageTimeout);
        messageTimeout = null;
      }
      
      // 移除处理中消息
      messages = messages.filter(m => 
        !m.id.includes('-sending') && !m.id.includes('-processing')
      );
      
      isReceiving = false;
      messageInputEl.disabled = false;
      sendBtnEl.disabled = false;
    }
  });
  
  // 监听错误
  listen('agent-error', (event) => {
    console.error('Received agent-error event:', event);
    const payload = event.payload as any;
    showError(`错误: ${payload.error}`);
    isReceiving = false;
    messageInputEl.disabled = false;
    sendBtnEl.disabled = false;
  });
}

// 追加流式消息
function appendStreamMessage(content: string) {
  console.log('Appending stream message:', content);
  
  // 查找最后一条助手消息，如果不存在则创建
  let lastMessage = messages[messages.length - 1];
  if (!lastMessage || lastMessage.role !== 'assistant') {
    lastMessage = {
      id: `msg-${Date.now()}`,
      role: 'assistant',
      content: '',
      timestamp: new Date(),
      agentId: currentAgentId || undefined,
    };
    messages.push(lastMessage);
  }
  
  // 追加内容
  lastMessage.content += content;
  renderMessages();
  scrollToBottom();
}

// 设置事件监听
function setupEventListeners() {
  console.log('Setting up event listeners...');
  
  addAgentBtnEl.addEventListener('click', () => {
    console.log('Add agent button clicked');
    addAgentModalEl.classList.remove('hidden');
  });

  closeModalBtnEl.addEventListener('click', hideModal);
  cancelAddAgentBtnEl.addEventListener('click', hideModal);
  
  confirmAddAgentBtnEl.addEventListener('click', async () => {
    console.log('Confirm add agent clicked');
    const nameInput = document.getElementById('agent-name') as HTMLInputElement;
    const pathInput = document.getElementById('iflow-path') as HTMLInputElement;
    const workspaceInput = document.getElementById('workspace-path') as HTMLInputElement;

    const name = nameInput.value.trim() || 'iFlow';
    const iflowPath = pathInput.value.trim() || 'iflow';
    const workspacePath = workspaceInput.value.trim() || '/Users/chenweilong/playground';

    hideModal();
    await addAgent(name, iflowPath, workspacePath);
    
    // 清空输入
    nameInput.value = 'iFlow';
    pathInput.value = '';
  });

  // 消息输入
  messageInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  messageInputEl.addEventListener('input', () => {
    messageInputEl.style.height = 'auto';
    messageInputEl.style.height = messageInputEl.scrollHeight + 'px';
  });

  sendBtnEl.addEventListener('click', sendMessage);

  newSessionBtnEl.addEventListener('click', startNewSession);
  clearChatBtnEl.addEventListener('click', clearChat);
  closeToolPanelBtnEl.addEventListener('click', () => {
    toolCallsPanelEl.classList.add('hidden');
  });
  
  // 清除所有 Agent 按钮
  const clearAllBtn = document.getElementById('clear-all-agents');
  if (clearAllBtn) {
    clearAllBtn.addEventListener('click', async () => {
      console.log('Clear all agents clicked');
      if (confirm('确定要删除所有 Agent 吗？')) {
        for (const agent of agents) {
          if (agent.status === 'connected') {
            try {
              await invoke('disconnect_agent', { agentId: agent.id });
            } catch (e) {
              console.error('断开连接失败:', e);
            }
          }
        }
        agents = [];
        currentAgentId = null;
        await saveAgents();
        renderAgentList();
        renderMessages();
        currentAgentNameEl.textContent = '选择一个 Agent';
        updateAgentStatusUI('disconnected');
        messageInputEl.disabled = true;
        sendBtnEl.disabled = true;
        console.log('All agents cleared');
      }
    });
  }
}

function hideModal() {
  addAgentModalEl.classList.add('hidden');
}

// 添加 Agent
async function addAgent(name: string, iflowPath: string, workspacePath: string) {
  console.log('Adding agent:', name, iflowPath, workspacePath);
  try {
    isConnecting = true;
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

    console.log('Connection result:', result);

    if (result.success) {
      const agent: Agent = {
        id: agentId,
        name,
        type: 'iflow',
        status: 'connected',
        workspacePath,
        port: result.port,
      };

      agents.push(agent);
      await saveAgents();
      renderAgentList();
      selectAgent(agentId);
      
      showSuccess('iFlow 连接成功！');
    } else {
      showError(result.error || '连接失败');
    }
  } catch (error) {
    console.error('Connection error:', error);
    showError(`连接错误: ${error}`);
  } finally {
    isConnecting = false;
    hideLoading();
  }
}

// 选择 Agent
function selectAgent(agentId: string) {
  console.log('Selecting agent:', agentId);
  currentAgentId = agentId;
  const agent = agents.find(a => a.id === agentId);
  
  if (agent) {
    currentAgentNameEl.textContent = agent.name;
    updateAgentStatusUI(agent.status);
    
    const isConnected = agent.status === 'connected';
    messageInputEl.disabled = !isConnected;
    sendBtnEl.disabled = !isConnected;
    newSessionBtnEl.disabled = !isConnected;
    clearChatBtnEl.disabled = !isConnected;
    
    messages = [];
    renderMessages();
    updateConnectionStatus(isConnected);
  }
  
  renderAgentList();
}

// 删除 Agent - 全局函数供 HTML 调用
(window as any).deleteAgent = async function(agentId: string) {
  console.log('deleteAgent called with:', agentId);
  
  if (!confirm('确定要删除这个 Agent 吗？')) {
    console.log('User cancelled delete');
    return;
  }
  
  console.log('Deleting agent:', agentId);
  
  const agent = agents.find(a => a.id === agentId);
  if (agent && agent.status === 'connected') {
    console.log('Agent is connected, disconnecting first...');
    try {
      await invoke('disconnect_agent', { agentId });
      console.log('Disconnected successfully');
    } catch (e) {
      console.error('断开连接失败:', e);
    }
  }
  
  console.log('Removing agent from list...');
  agents = agents.filter(a => a.id !== agentId);
  await saveAgents();
  console.log('Agent removed, total agents:', agents.length);
  
  if (currentAgentId === agentId) {
    console.log('Deleted current agent, clearing selection...');
    currentAgentId = null;
    messages = [];
    renderMessages();
    currentAgentNameEl.textContent = '选择一个 Agent';
    updateAgentStatusUI('disconnected');
    messageInputEl.disabled = true;
    sendBtnEl.disabled = true;
  }
  
  renderAgentList();
  console.log('Delete completed');
};

// 渲染 Agent 列表 - 使用 onclick 直接绑定
function renderAgentList() {
  console.log('Rendering agent list, count:', agents.length);
  
  agentListEl.innerHTML = agents.map(agent => `
    <div class="agent-item ${agent.id === currentAgentId ? 'active' : ''}" 
         data-agent-id="${agent.id}"
         onclick="window.selectAgent('${agent.id}')">
      <div class="agent-icon">iF</div>
      <div class="agent-info">
        <div class="agent-name">${escapeHtml(agent.name)}</div>
        <div class="agent-status">${escapeHtml(agent.workspacePath)}</div>
      </div>
      <div class="agent-actions" onclick="event.stopPropagation()">
        <div class="status-indicator ${agent.status}"></div>
        ${agent.status === 'disconnected' ? 
          `<button class="btn-reconnect" onclick="window.reconnectAgent('${agent.id}'); event.stopPropagation();" title="重新连接">↻</button>` : 
          ''}
        <button class="btn-delete" onclick="window.deleteAgent('${agent.id}'); event.stopPropagation();" title="删除">×</button>
      </div>
    </div>
  `).join('');
}

// 重新连接 Agent - 全局函数
(window as any).reconnectAgent = async function(agentId: string) {
  console.log('Reconnecting agent:', agentId);
  const agent = agents.find(a => a.id === agentId);
  if (!agent) {
    console.error('Agent not found:', agentId);
    return;
  }
  
  // 更新状态为 connecting
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
    
    if (result.success) {
      agent.status = 'connected';
      agent.port = result.port;
      await saveAgents();
      selectAgent(agent.id);
      showSuccess('重新连接成功！');
    } else {
      agent.status = 'error';
      showError(result.error || '连接失败');
    }
  } catch (error) {
    console.error('Reconnection error:', error);
    agent.status = 'error';
    showError(`连接错误: ${error}`);
  }
  
  renderAgentList();
};

// 选择 Agent - 全局函数
(window as any).selectAgent = function(agentId: string) {
  console.log('selectAgent called:', agentId);
  selectAgent(agentId);
};

// 更新 Agent 状态 UI
function updateAgentStatusUI(status: Agent['status']) {
  const statusText = {
    disconnected: '离线',
    connecting: '连接中...',
    connected: '在线',
    error: '错误',
  }[status];
  
  currentAgentStatusEl.textContent = statusText;
  currentAgentStatusEl.className = 'badge' + (status === 'connected' ? ' connected' : '');
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
const MESSAGE_TIMEOUT_MS = 60000; // 60秒超时

async function sendMessage() {
  const content = messageInputEl.value.trim();
  console.log('[sendMessage] content:', content, 'currentAgentId:', currentAgentId, 'isReceiving:', isReceiving);
  
  if (!content || !currentAgentId || isReceiving) {
    console.log('[sendMessage] Early return - content empty or no agent or already receiving');
    return;
  }

  console.log('[sendMessage] Sending to agent:', currentAgentId);
  
  // 添加"正在发送..."的系统消息
  const sendingMessage: Message = {
    id: `msg-${Date.now()}-sending`,
    role: 'system',
    content: '📤 正在发送消息...',
    timestamp: new Date(),
  };
  messages.push(sendingMessage);
  renderMessages();
  scrollToBottom();

  // 添加用户消息到界面
  const userMessage: Message = {
    id: `msg-${Date.now()}`,
    role: 'user',
    content,
    timestamp: new Date(),
  };
  messages.push(userMessage);
  renderMessages();
  scrollToBottom();

  // 清空输入
  messageInputEl.value = '';
  messageInputEl.style.height = 'auto';
  messageInputEl.disabled = true;
  sendBtnEl.disabled = true;
  isReceiving = true;

  try {
    // 调用 Rust 后端发送消息
    await invoke('send_message', {
      agentId: currentAgentId,
      content,
    });

    console.log('Message sent successfully');
    
    // 更新为"处理中"状态
    messages = messages.filter(m => m.id !== sendingMessage.id);
    const processingMessage: Message = {
      id: `msg-${Date.now()}-processing`,
      role: 'system',
      content: '🤔 iFlow 正在思考中...',
      timestamp: new Date(),
    };
    messages.push(processingMessage);
    renderMessages();
    
    // 设置超时
    messageTimeout = window.setTimeout(() => {
      console.log('[sendMessage] Timeout! No response received.');
      
      // 移除处理中消息
      messages = messages.filter(m => m.id !== processingMessage.id);
      
      // 添加超时提示
      const timeoutMessage: Message = {
        id: `msg-${Date.now()}-timeout`,
        role: 'system',
        content: '⏱️ 响应超时（60秒）。可能原因：\n1. iFlow 正在处理复杂任务\n2. 连接已断开\n3. iFlow 服务异常\n\n您可以：\n- 等待更长时间\n- 检查 iFlow 状态\n- 重新连接 Agent',
        timestamp: new Date(),
      };
      messages.push(timeoutMessage);
      renderMessages();
      
      // 恢复输入
      isReceiving = false;
      messageInputEl.disabled = false;
      sendBtnEl.disabled = false;
      
      showError('响应超时，请检查连接状态');
    }, MESSAGE_TIMEOUT_MS);
    
  } catch (error) {
    console.error('Send message error:', error);
    
    // 移除发送中消息
    messages = messages.filter(m => m.id !== sendingMessage.id);
    
    showError(`发送失败: ${error}`);
    messageInputEl.disabled = false;
    sendBtnEl.disabled = false;
    isReceiving = false;
  }
}

// 显示工具调用
function showToolCalls(toolCalls: ToolCall[]) {
  console.log('Showing tool calls:', toolCalls);
  toolCallsListEl.innerHTML = toolCalls.map(tc => `
    <div class="tool-call-item">
      <div class="tool-name">${escapeHtml(tc.name)}</div>
      <div class="tool-status">状态: ${tc.status}</div>
      ${tc.arguments ? `
        <div class="tool-args">${escapeHtml(JSON.stringify(tc.arguments, null, 2))}</div>
      ` : ''}
    </div>
  `).join('');

  toolCallsPanelEl.classList.remove('hidden');
}

// 渲染消息
function renderMessages() {
  if (messages.length === 0) {
    chatMessagesEl.innerHTML = `
      <div class="welcome-message">
        <h3>👋 欢迎使用 iFlow Workspace</h3>
        <p>开始与 iFlow 对话，它会帮你完成各种任务。</p>
      </div>
    `;
    return;
  }

  chatMessagesEl.innerHTML = messages.map(msg => `
    <div class="message ${msg.role}">
      <div class="message-avatar">${msg.role === 'user' ? '👤' : '🤖'}</div>
      <div class="message-content">
        ${escapeHtml(msg.content)}
        <div class="message-time">${formatTime(msg.timestamp)}</div>
      </div>
    </div>
  `).join('');
}

// 开始新会话
function startNewSession() {
  console.log('Starting new session');
  messages = [];
  renderMessages();
}

// 清空对话
function clearChat() {
  console.log('Clearing chat');
  if (confirm('确定要清空当前对话吗？')) {
    messages = [];
    renderMessages();
  }
}

// 滚动到底部
function scrollToBottom() {
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
}

// 加载 Agent 列表
async function loadAgents() {
  console.log('Loading agents...');
  try {
    const saved = localStorage.getItem('iflow-agents');
    if (saved) {
      agents = JSON.parse(saved);
      console.log('Loaded agents:', agents.length);
      
      // 应用重启后，所有连接都已丢失，将状态重置为 disconnected
      agents = agents.map(agent => ({
        ...agent,
        status: 'disconnected' as const,
        port: undefined
      }));
      
      console.log('All agents marked as disconnected (app restarted)');
      await saveAgents();
      renderAgentList();
    }
  } catch (e) {
    console.error('Failed to load agents:', e);
  }
}

// 保存 Agent 列表
async function saveAgents() {
  try {
    localStorage.setItem('iflow-agents', JSON.stringify(agents));
    console.log('Agents saved');
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

function formatTime(date: Date): string {
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
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
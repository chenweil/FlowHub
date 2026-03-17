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
  discoverSkills,
  sendMessage as tauriSendMessage,
  stopMessage,
  pickFolder,
} from '../services/tauri';
import { TIMEOUTS } from '../config';
import { generateAcpSessionId, streamTypeToRole } from '../lib/utils';
import { escapeHtml } from '../lib/html';
import type { Message, SlashMenuItem, ComposerState, StreamMessageType, ThemeMode, SendKeyMode } from '../types';
import {
  state,
  canUseConversationQuickAction,
  isMcpSuggestionEnabledForAgent,
  setMcpSuggestionEnabledForAgent,
  isSkillSuggestionEnabledForAgentType,
  setSkillSuggestionEnabledForAgentType,
  setHistoryContinuationEnabled,
} from '../store';
import { buildMcpCapabilityViewModel } from './capabilities/mcpViewModel';
import { buildSkillCapabilityViewModel } from './capabilities/skillViewModel';
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
  openCapabilityCenterBtnEl,
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
  openSettingsBtnEl,
  settingsModalEl,
  closeSettingsModalBtnEl,
  closeSettingsFooterBtnEl,
  openCapabilityCenterFromSettingsBtnEl,
  capabilityCenterModalEl,
  closeCapabilityCenterModalBtnEl,
  closeCapabilityCenterFooterBtnEl,
  capabilityTabMcpBtnEl,
  capabilityTabSkillBtnEl,
  capabilitySearchInputEl,
  capabilityPanelMcpEl,
  capabilityPanelSkillEl,
  capabilityMcpAgentLabelEl,
  capabilityMcpNoteEl,
  capabilityMcpListEl,
  capabilitySkillAgentLabelEl,
  capabilitySkillNoteEl,
  capabilitySkillListEl,
  themeToggleBtnEl,
  autoReconnectModeSelectEl,
  notificationSoundSelectEl,
  notificationDelayMinuteInputEl,
  notificationDelaySecondInputEl,
  notificationSoundUploadBtnEl,
  notificationSoundUploadInputEl,
  sendKeyModeSelectEl,
  historyContinuationEnabledEl,
  appVersionEl,
  toolbarMoreBtnEl,
  toolbarMoreMenuEl,
  showConfirmDialog,
} from '../dom';
import {
  saveSessions,
  saveSessionMessages,
  saveDraft,
  getDraft,
  clearDraft,
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
  handleLocalAgentCommand,
  type AutoReconnectMode,
  getAutoReconnectMode,
  normalizeAutoReconnectMode,
  setAutoReconnectMode,
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
import { canCompressContext } from '../lib/contextCompression';
import { clearMessageWatchdog, resetMessageWatchdog } from './messageWatchdog';
import { buildHistoryContinuationPrompt } from './historyContinuation';

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
  { command: '/directory show', description: '查看当前会话可见目录' },
  { command: '/directory add <path>', description: '添加额外目录到会话上下文' },
  { command: '/memory show', description: '查看当前记忆' },
  { command: '/agents autoreconnect', description: '查看自动重连模式（last/all/off）' },
  { command: '/agents autoreconnect <last|all|off>', description: '设置自动重连模式' },
];
// 初始化
// 主题管理
const THEME_STORAGE_KEY = 'iflow-theme';
const THEME_CYCLE: Record<ThemeMode, ThemeMode> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_ICON: Record<ThemeMode, string> = { system: '◑', light: '☀', dark: '☾' };
const THEME_TITLE: Record<ThemeMode, string> = { system: '跟随系统', light: '亮色模式', dark: '暗色模式' };
const NOTIFICATION_SOUND_STORAGE_KEY = 'iflow-notification-sound';
const NOTIFICATION_CUSTOM_SOUND_STORAGE_KEY = 'iflow-notification-custom-sound';
const NOTIFICATION_CUSTOM_SOUND_NAME_STORAGE_KEY = 'iflow-notification-custom-sound-name';
const NOTIFICATION_DELAY_STORAGE_KEY = 'iflow-notification-delay-ms';
const NOTIFICATION_SOUND_NONE = 'none';
const NOTIFICATION_SOUND_CUSTOM = 'custom-upload';
const NOTIFICATION_SOUND_DEFAULT = 'short-01.mp3';
const NOTIFICATION_DEFAULT_DELAY_MS = 5000;
const NOTIFICATION_MAX_DELAY_MS = 59 * 60 * 1000 + 59 * 1000;
const NOTIFICATION_MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

interface NotificationSoundOption {
  id: string;
  label: string;
  src: string | null;
}

const NOTIFICATION_BUILTIN_SOUND_OPTIONS: ReadonlyArray<NotificationSoundOption> = [
  { id: NOTIFICATION_SOUND_NONE, label: '关闭', src: null },
  {
    id: 'short-01.mp3',
    label: '铃声01',
    src: '/audio/bell/short-01.mp3',
  },
  {
    id: 'short-02.wav',
    label: '铃声02',
    src: '/audio/bell/short-02.wav',
  },
  {
    id: 'short-03.mp3',
    label: '铃声03',
    src: '/audio/bell/short-03.mp3',
  },
  {
    id: 'short-04.mp3',
    label: '铃声04',
    src: '/audio/bell/short-04.mp3',
  },
  {
    id: 'short-05.mp3',
    label: '铃声05',
    src: '/audio/bell/short-05.mp3',
  },
  {
    id: 'short-06.wav',
    label: '铃声06',
    src: '/audio/bell/short-06.wav',
  },
  {
    id: 'short-07.mp3',
    label: '铃声07',
    src: '/audio/bell/short-07.mp3',
  },
  {
    id: 'short-08.mp3',
    label: '铃声08',
    src: '/audio/bell/short-08.mp3',
  },
];
const notificationAudioEl = new Audio();
notificationAudioEl.preload = 'auto';
let notificationSoundTimerId: number | null = null;
let messageHardTimeoutId: number | null = null;
let messageInactivityNotice: { agentId: string; sessionId: string; messageId: string } | null = null;

// IME composition state tracking (more reliable than e.isComposing)
let isComposing = false;

const AUTO_RECONNECT_MODE_LABELS: Record<AutoReconnectMode, string> = {
  last: '最后一个',
  all: '全部',
  off: '关闭',
};
const CAPABILITY_AGENT_STATUS_LABELS: Record<'connected' | 'disconnected' | 'connecting' | 'error', string> = {
  connected: '在线',
  disconnected: '离线',
  connecting: '连接中',
  error: '异常',
};

function setupAutoReconnectModeSelector() {
  const mode = getAutoReconnectMode();
  autoReconnectModeSelectEl.value = mode;
  autoReconnectModeSelectEl.title = `刷新后重连：${AUTO_RECONNECT_MODE_LABELS[mode]}`;
}

function onAutoReconnectModeChange() {
  const mode = normalizeAutoReconnectMode(autoReconnectModeSelectEl.value);
  setAutoReconnectMode(mode);
  autoReconnectModeSelectEl.value = mode;
  autoReconnectModeSelectEl.title = `刷新后重连：${AUTO_RECONNECT_MODE_LABELS[mode]}`;
}


export function applyTheme(mode: ThemeMode) {
  const root = document.documentElement;
  root.classList.remove('theme-light', 'theme-dark');
  if (mode !== 'system') root.classList.add(`theme-${mode}`);
  themeToggleBtnEl.textContent = `主题：${THEME_ICON[mode]}`;
  themeToggleBtnEl.title = THEME_TITLE[mode];
}

function showSettingsModal() {
  settingsModalEl.classList.remove('hidden');
}

function hideSettingsModal() {
  settingsModalEl.classList.add('hidden');
}

function getCurrentAgent() {
  if (!state.currentAgentId) {
    return null;
  }
  return state.agents.find((item) => item.id === state.currentAgentId) || null;
}

function normalizeAgentType(rawType: string | null | undefined): string {
  return (rawType || '').trim().toLowerCase();
}

async function refreshSkillsForCurrentAgentType(force = false) {
  const currentAgent = getCurrentAgent();
  const agentType = normalizeAgentType(currentAgent?.type);
  if (!agentType) {
    return;
  }
  if (agentType !== 'iflow') {
    return;
  }
  const hasCachedSkills = (state.skillRuntimeByAgentType[agentType] || []).length > 0;
  if (!force && hasCachedSkills) {
    return;
  }

  state.capabilityLoading = true;
  delete state.capabilityErrors.skill;
  renderCapabilityCenterIfVisible();

  try {
    const skills = await discoverSkills(agentType);
    state.skillRuntimeByAgentType[agentType] = skills;
  } catch (error) {
    console.error('Discover skills failed:', error);
    state.skillRuntimeByAgentType[agentType] = [];
    state.capabilityErrors.skill = String(error);
  } finally {
    state.capabilityLoading = false;
    updateSlashCommandMenu();
    renderCapabilityCenterIfVisible();
  }
}

function renderCapabilityCenterTabs() {
  const isMcpTab = state.capabilityCenterTab === 'mcp';
  capabilityTabMcpBtnEl.classList.toggle('active', isMcpTab);
  capabilityTabMcpBtnEl.setAttribute('aria-selected', isMcpTab ? 'true' : 'false');
  capabilityTabSkillBtnEl.classList.toggle('active', !isMcpTab);
  capabilityTabSkillBtnEl.setAttribute('aria-selected', isMcpTab ? 'false' : 'true');
  capabilityPanelMcpEl.classList.toggle('hidden', !isMcpTab);
  capabilityPanelSkillEl.classList.toggle('hidden', isMcpTab);
}

function renderCapabilityCenterMcpPanel() {
  const viewModel = buildMcpCapabilityViewModel({
    currentAgentId: state.currentAgentId,
    agents: state.agents,
    registryByAgent: state.registryByAgent,
    mcpEnabledByAgent: state.mcpEnabledByAgent,
  });
  const statusLabel = viewModel.agentStatus ? CAPABILITY_AGENT_STATUS_LABELS[viewModel.agentStatus] : '-';
  capabilityMcpAgentLabelEl.textContent = `Agent：${viewModel.agentName}（${statusLabel}）`;

  if (viewModel.state === 'no-agent') {
    capabilityMcpNoteEl.textContent = '请选择 Agent 后查看当前运行时 MCP 列表。';
    capabilityMcpListEl.innerHTML = '<div class="capability-empty">尚未选择 Agent。</div>';
    return;
  }

  if (viewModel.state === 'offline') {
    capabilityMcpNoteEl.textContent =
      '当前 Agent 离线，列表为上次已知运行时数据（只读展示，不代表当前实时可用）。';
  } else if (viewModel.state === 'empty') {
    capabilityMcpNoteEl.textContent = '当前 Agent 已连接，但尚未收到 MCP 运行时注册信息。';
  } else {
    capabilityMcpNoteEl.textContent = '以下列表来自运行时注册信息（只读展示，不修改 CLI 实际加载配置）。';
  }

  if (viewModel.servers.length === 0) {
    capabilityMcpListEl.innerHTML = '<div class="capability-empty">暂无 MCP 条目。</div>';
    return;
  }

  const searchQuery = state.capabilitySearchQuery.trim().toLowerCase();
  const filteredServers = searchQuery
    ? viewModel.servers.filter(
        (entry) =>
          entry.name.toLowerCase().includes(searchQuery) ||
          (entry.description || '').toLowerCase().includes(searchQuery)
      )
    : viewModel.servers;

  if (filteredServers.length === 0) {
    capabilityMcpListEl.innerHTML = '<div class="capability-empty">未找到匹配的 MCP。</div>';
    return;
  }

  capabilityMcpListEl.innerHTML = filteredServers
    .map((entry) => {
      const desc = entry.description?.trim() ? entry.description : '无描述';
      const sourceLabel = viewModel.isReadOnlySnapshot ? '离线快照' : 'runtime';
      const checked = entry.suggestionEnabled ? 'checked' : '';
      return `
        <div class="capability-item">
          <div class="capability-item-main">
            <div class="capability-item-title">${escapeHtml(entry.name)}</div>
            <div class="capability-item-desc">${escapeHtml(desc)}</div>
          </div>
          <div class="capability-item-actions">
            <label class="capability-switch">
              <input
                type="checkbox"
                data-capability-mcp-toggle="true"
                data-server-name="${escapeHtml(entry.name)}"
                ${checked}
              />
              <span>建议显示</span>
            </label>
            <span class="capability-item-source">${escapeHtml(sourceLabel)}</span>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderCapabilityCenterSkillPanel() {
  const currentAgent = getCurrentAgent();
  if (!currentAgent) {
    capabilitySkillAgentLabelEl.textContent = 'Agent：未选择';
    capabilitySkillNoteEl.textContent = '请选择 Agent 后查看 Skill 列表。';
    capabilitySkillListEl.innerHTML = '<div class="capability-empty">尚未选择 Agent。</div>';
    return;
  }

  const agentType = normalizeAgentType(currentAgent.type);
  capabilitySkillAgentLabelEl.textContent = `Agent：${currentAgent.name}（类型：${agentType || '-' }）`;

  const viewModel = buildSkillCapabilityViewModel({
    agentType,
    skillRuntimeByAgentType: state.skillRuntimeByAgentType,
    skillEnabledByAgentType: state.skillEnabledByAgentType,
    loading: state.capabilityLoading,
    errorMessage: state.capabilityErrors.skill || '',
  });

  if (viewModel.state === 'unsupported') {
    capabilitySkillNoteEl.textContent = '当前仅支持 iflow 类型 Agent 的技能扫描。';
    capabilitySkillListEl.innerHTML = '<div class="capability-empty">当前 Agent 类型暂不支持 Skill 管理。</div>';
    return;
  }
  if (viewModel.state === 'loading') {
    capabilitySkillNoteEl.textContent = '正在扫描 ~/.iflow/skills ...';
    capabilitySkillListEl.innerHTML = '<div class="capability-empty">加载中...</div>';
    return;
  }
  if (viewModel.state === 'error') {
    capabilitySkillNoteEl.textContent = `扫描失败：${viewModel.errorMessage}`;
    capabilitySkillListEl.innerHTML = '<div class="capability-empty">无法读取 Skill 列表，请检查目录与权限。</div>';
    return;
  }
  if (viewModel.state === 'empty') {
    capabilitySkillNoteEl.textContent = '未发现 Skill，目录：~/.iflow/skills';
    capabilitySkillListEl.innerHTML = '<div class="capability-empty">暂无 Skill 条目。</div>';
    return;
  }

  capabilitySkillNoteEl.textContent = '以下开关仅影响建议列表显示，对所有 iflow Agent 生效。';

  const searchQuery = state.capabilitySearchQuery.trim().toLowerCase();
  const filteredSkills = searchQuery
    ? viewModel.skills.filter(
        (entry) =>
          (entry.title || entry.skillName).toLowerCase().includes(searchQuery) ||
          (entry.description || '').toLowerCase().includes(searchQuery)
      )
    : viewModel.skills;

  if (filteredSkills.length === 0) {
    capabilitySkillListEl.innerHTML = '<div class="capability-empty">未找到匹配的 Skill。</div>';
    return;
  }

  capabilitySkillListEl.innerHTML = filteredSkills
    .map((entry) => {
      const desc = entry.description?.trim() ? entry.description : '无描述';
      const checked = entry.suggestionEnabled ? 'checked' : '';
      return `
        <div class="capability-item">
          <div class="capability-item-main">
            <div class="capability-item-title">${escapeHtml(entry.title || entry.skillName)}</div>
            <div class="capability-item-desc">${escapeHtml(desc)}\n路径：${escapeHtml(entry.path)}</div>
          </div>
          <div class="capability-item-actions">
            <label class="capability-switch">
              <input
                type="checkbox"
                data-capability-skill-toggle="true"
                data-skill-name="${escapeHtml(entry.skillName)}"
                data-agent-type="${escapeHtml(agentType)}"
                ${checked}
              />
              <span>建议显示</span>
            </label>
            <span class="capability-item-source">iflow</span>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderCapabilityCenter() {
  renderCapabilityCenterTabs();
  renderCapabilityCenterMcpPanel();
  renderCapabilityCenterSkillPanel();
}

function renderCapabilityCenterIfVisible() {
  if (capabilityCenterModalEl.classList.contains('hidden')) {
    return;
  }
  renderCapabilityCenter();
}

function showCapabilityCenterModal() {
  renderCapabilityCenter();
  capabilityCenterModalEl.classList.remove('hidden');
  void refreshSkillsForCurrentAgentType(false);
}

function hideCapabilityCenterModal() {
  capabilityCenterModalEl.classList.add('hidden');
  // 清空搜索状态
  state.capabilitySearchQuery = '';
  capabilitySearchInputEl.value = '';
}

function switchCapabilityCenterTab(tab: 'mcp' | 'skill') {
  if (state.capabilityCenterTab === tab) {
    return;
  }
  state.capabilityCenterTab = tab;
  renderCapabilityCenter();
  if (tab === 'skill') {
    void refreshSkillsForCurrentAgentType(false);
  }
}

function onCapabilityMcpToggleChange(event: Event) {
  const target = event.target as HTMLInputElement;
  if (!target || target.type !== 'checkbox') {
    return;
  }
  if (target.dataset.capabilityMcpToggle !== 'true') {
    return;
  }
  if (!state.currentAgentId) {
    return;
  }
  const serverName = target.dataset.serverName?.trim();
  if (!serverName) {
    return;
  }

  setMcpSuggestionEnabledForAgent(state.currentAgentId, serverName, target.checked);
  updateSlashCommandMenu();
  renderCapabilityCenterMcpPanel();
}

function onCapabilitySkillToggleChange(event: Event) {
  const target = event.target as HTMLInputElement;
  if (!target || target.type !== 'checkbox') {
    return;
  }
  if (target.dataset.capabilitySkillToggle !== 'true') {
    return;
  }
  const skillName = target.dataset.skillName?.trim();
  const agentType = normalizeAgentType(target.dataset.agentType);
  if (!agentType || !skillName) {
    return;
  }

  setSkillSuggestionEnabledForAgentType(agentType, skillName, target.checked);
  updateSlashCommandMenu();
  renderCapabilityCenterSkillPanel();
}

function normalizeNotificationDelayMs(delayMs: number | null | undefined): number {
  if (!Number.isFinite(delayMs)) {
    return NOTIFICATION_DEFAULT_DELAY_MS;
  }
  return Math.max(0, Math.min(NOTIFICATION_MAX_DELAY_MS, Math.floor(delayMs as number)));
}

function splitDelayMs(delayMs: number): { minutes: number; seconds: number } {
  const normalized = normalizeNotificationDelayMs(delayMs);
  return {
    minutes: Math.floor(normalized / 60000),
    seconds: Math.floor((normalized % 60000) / 1000),
  };
}

function buildCustomNotificationSoundOption(): NotificationSoundOption | null {
  if (!state.notificationCustomSoundDataUrl) {
    return null;
  }
  const displayName = state.notificationCustomSoundName?.trim() || '未命名音频';
  return {
    id: NOTIFICATION_SOUND_CUSTOM,
    label: `铃声：自定义（${displayName}）`,
    src: state.notificationCustomSoundDataUrl,
  };
}

function buildNotificationSoundOptions(): NotificationSoundOption[] {
  const options = [...NOTIFICATION_BUILTIN_SOUND_OPTIONS];
  const customOption = buildCustomNotificationSoundOption();
  if (customOption) {
    options.push(customOption);
  }
  return options;
}

function normalizeNotificationSoundId(soundId: string | null | undefined): string {
  if (!soundId) {
    return NOTIFICATION_SOUND_DEFAULT;
  }
  const matched = buildNotificationSoundOptions().find((item) => item.id === soundId);
  return matched ? matched.id : NOTIFICATION_SOUND_DEFAULT;
}

function notificationSoundSrcById(soundId: string): string | null {
  const matched = buildNotificationSoundOptions().find((item) => item.id === soundId);
  return matched?.src || null;
}

function applyNotificationSoundSelection(soundId: string) {
  const normalized = normalizeNotificationSoundId(soundId);
  state.notificationSoundId = normalized;
  localStorage.setItem(NOTIFICATION_SOUND_STORAGE_KEY, normalized);
  notificationSoundSelectEl.value = normalized;
}

function applyNotificationDelaySelection(delayMs: number) {
  const normalized = normalizeNotificationDelayMs(delayMs);
  state.notificationDelayMs = normalized;
  localStorage.setItem(NOTIFICATION_DELAY_STORAGE_KEY, String(normalized));
  const { minutes, seconds } = splitDelayMs(normalized);
  notificationDelayMinuteInputEl.value = String(minutes);
  notificationDelaySecondInputEl.value = String(seconds);
}

function normalizeNotificationDelayInput(rawValue: string): number {
  const parsed = Number.parseInt(rawValue.trim(), 10);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.min(59, parsed));
}

function applyNotificationDelayFromInputs() {
  const minutes = normalizeNotificationDelayInput(notificationDelayMinuteInputEl.value);
  const seconds = normalizeNotificationDelayInput(notificationDelaySecondInputEl.value);
  const totalMs = minutes * 60000 + seconds * 1000;
  applyNotificationDelaySelection(totalMs);
}

function applySendKeyModeSelection(mode: SendKeyMode) {
  state.sendKeyMode = mode;
  localStorage.setItem('iflow-send-key-mode', mode);
  sendKeyModeSelectEl.value = mode;
}

function initializeSendKeyMode() {
  const savedMode = localStorage.getItem('iflow-send-key-mode');
  const mode: SendKeyMode = savedMode === 'mod+enter' ? 'mod+enter' : 'enter';
  state.sendKeyMode = mode;
  sendKeyModeSelectEl.value = mode;
}

function applyHistoryContinuationSelection(enabled: boolean) {
  setHistoryContinuationEnabled(enabled);
  historyContinuationEnabledEl.checked = state.historyContinuationEnabled;
}

function setupHistoryContinuationToggle() {
  historyContinuationEnabledEl.checked = state.historyContinuationEnabled;
}

function isModKeyPressed(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey;
}

function isImeComposing(event: KeyboardEvent): boolean {
  return event.isComposing || isComposing;
}

function shouldSendOnEnter(event: KeyboardEvent): boolean {
  if (state.sendKeyMode !== 'enter') {
    return false;
  }
  return event.key === 'Enter' && !event.shiftKey && !isImeComposing(event) && !isModKeyPressed(event);
}

function shouldSendOnModEnter(event: KeyboardEvent): boolean {
  if (state.sendKeyMode !== 'mod+enter') {
    return false;
  }
  return event.key === 'Enter' && isModKeyPressed(event) && !isImeComposing(event);
}

function isSupportedAudioFile(file: File): boolean {
  if (file.type.startsWith('audio/')) {
    return true;
  }
  return /\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i.test(file.name);
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

async function onUploadNotificationSound() {
  const file = notificationSoundUploadInputEl.files?.[0];
  if (!file) {
    return;
  }

  try {
    if (!isSupportedAudioFile(file)) {
      showError('请选择可播放的音频文件（如 mp3/wav/ogg/m4a）');
      return;
    }
    if (file.size > NOTIFICATION_MAX_UPLOAD_BYTES) {
      showError('上传失败：音频文件需小于 4MB');
      return;
    }

    const dataUrl = await readFileAsDataUrl(file);
    localStorage.setItem(NOTIFICATION_CUSTOM_SOUND_STORAGE_KEY, dataUrl);
    localStorage.setItem(NOTIFICATION_CUSTOM_SOUND_NAME_STORAGE_KEY, file.name);
    state.notificationCustomSoundDataUrl = dataUrl;
    state.notificationCustomSoundName = file.name;

    setupNotificationSoundSelector();
    applyNotificationSoundSelection(NOTIFICATION_SOUND_CUSTOM);
    await playTaskFinishSound();
  } catch (error) {
    console.error('Upload notification sound failed:', error);
    showError(`上传铃声失败: ${String(error)}`);
  } finally {
    notificationSoundUploadInputEl.value = '';
  }
}

export function setupNotificationSoundSelector() {
  const soundOptions = buildNotificationSoundOptions();
  notificationSoundSelectEl.innerHTML = soundOptions.map((item) => {
    return `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label)}</option>`;
  }).join('');

  const saved = normalizeNotificationSoundId(state.notificationSoundId);
  applyNotificationSoundSelection(saved);
}

export function setupNotificationDelayInputs() {
  applyNotificationDelaySelection(state.notificationDelayMs);
}

export function setupSendKeyMode() {
  initializeSendKeyMode();
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

export function scheduleTaskFinishSound() {
  if (notificationSoundTimerId !== null) {
    window.clearTimeout(notificationSoundTimerId);
    notificationSoundTimerId = null;
  }

  const delayMs = normalizeNotificationDelayMs(state.notificationDelayMs);
  if (delayMs === 0) {
    void playTaskFinishSound();
    return;
  }

  notificationSoundTimerId = window.setTimeout(() => {
    notificationSoundTimerId = null;
    void playTaskFinishSound();
  }, delayMs);
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
    messageInputEl.placeholder = '输入消息，或输入 / 查看命令...';
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
  renderCapabilityCenterIfVisible();
  const currentAgent = state.currentAgentId ? state.agents.find((agent) => agent.id === state.currentAgentId) : null;
  const isConnected = currentAgent?.status === 'connected';
  const hasSession = Boolean(state.currentSessionId);
  const isBusy = isCurrentAgentBusy();

  if (!hasSession) {
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

  if (!isConnected) {
    setComposerState('disabled', '当前 Agent 离线，请连接后输入');
    newSessionBtnEl.disabled = true;
    clearChatBtnEl.disabled = false;
    return;
  }

  setComposerState('ready', '当前会话已完成，可继续输入（输入 / 可查看命令）');
  newSessionBtnEl.disabled = false;
  clearChatBtnEl.disabled = false;

  // Update context usage bar
  void import('./contextUsage').then(({ updateContextUsageDisplay }) => {
    updateContextUsageDisplay();
  });
}

// 设置 Tauri 事件监听
export function setupTauriEventListeners() {
  console.log('Setting up Tauri event listeners...');

  onStreamMessage((payload) => {
    if (!payload.agentId || !payload.content) {
      return;
    }

    if (payload.agentId === state.currentAgentId) {
      const inflightSessionId = state.inflightSessionByAgent[payload.agentId];
      if (inflightSessionId) {
        dismissMessageInactivityNotice(payload.agentId, inflightSessionId);
        scheduleMessageTimeoutWatchdog(payload.agentId, inflightSessionId);
      }
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
      if (payload.agentId === state.currentAgentId) {
        const inflightSessionId = state.inflightSessionByAgent[payload.agentId];
        if (inflightSessionId) {
          dismissMessageInactivityNotice(payload.agentId, inflightSessionId);
          scheduleMessageTimeoutWatchdog(payload.agentId, inflightSessionId);
        }
      }
      mergeToolCalls(payload.agentId, payload.toolCalls);
    }
  });

  onCommandRegistry((payload) => {
    if (!payload.agentId) {
      return;
    }

    applyAgentRegistry(payload.agentId, payload.commands, payload.mcpServers);
    if (payload.agentId === state.currentAgentId) {
      renderCapabilityCenterIfVisible();
    }
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
      clearMessageWatchdog(state);
      clearMessageHardTimeout();
      dismissMessageInactivityNotice(payload.agentId, targetSessionId || state.currentSessionId || undefined);

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

    scheduleTaskFinishSound();
  });

  onAgentError((payload) => {
    const targetSessionId = payload.agentId ? state.inflightSessionByAgent[payload.agentId] : undefined;
    if (payload.agentId) {
      delete state.inflightSessionByAgent[payload.agentId];
    }
    if (payload.agentId && payload.agentId !== state.currentAgentId) {
      return;
    }
    clearMessageWatchdog(state);
    clearMessageHardTimeout();
    dismissMessageInactivityNotice(payload.agentId, targetSessionId);
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
  // Invalidate token cache — content changed via streaming
  delete lastMessage.estimatedTokens;
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
  const currentAgentId = state.currentAgentId;
  const currentRegistry = currentAgentId ? state.registryByAgent[currentAgentId] : undefined;
  const currentAgent = currentAgentId ? state.agents.find((item) => item.id === currentAgentId) : null;
  const currentAgentType = normalizeAgentType(currentAgent?.type);
  const currentSkillItems = currentAgentType ? state.skillRuntimeByAgentType[currentAgentType] || [] : [];

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
    if (!currentAgentId) {
      return;
    }
    if (!isMcpSuggestionEnabledForAgent(currentAgentId, entry.name)) {
      return;
    }
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

  currentSkillItems.forEach((entry, index) => {
    if (!isSkillSuggestionEnabledForAgentType(currentAgentType, entry.skillName)) {
      return;
    }
    const commandText = `/skill ${entry.skillName}`;
    const description = entry.description || `使用 Skill：${entry.title || entry.skillName}`;
    pushUnique({
      id: `skill-${index}-${entry.skillName}`,
      label: commandText,
      insertText: commandText,
      description,
      hint: 'skill',
      category: 'skill',
      searchable: `${commandText} ${entry.skillName} ${entry.title} ${description}`.toLowerCase(),
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
  let filteredItems =
    query.length === 0
      ? candidateItems
      : candidateItems.filter((item) => item.searchable.includes(query));

  // 按最近使用排序
  filteredItems = filteredItems.sort((a, b) => {
    const aIndex = state.recentSlashCommands.indexOf(a.id);
    const bIndex = state.recentSlashCommands.indexOf(b.id);
    
    // 如果都在最近使用列表中，按使用顺序排序（越新的越靠前）
    if (aIndex !== -1 && bIndex !== -1) {
      return aIndex - bIndex;
    }
    
    // 如果只有 a 在最近使用列表中，a 排前面
    if (aIndex !== -1) {
      return -1;
    }
    
    // 如果只有 b 在最近使用列表中，b 排前面
    if (bIndex !== -1) {
      return 1;
    }
    
    // 都不在最近使用列表中，保持原顺序
    return 0;
  });

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
      
      // 类别标签
      let categoryBadge = '';
      if (item.category === 'mcp') {
        categoryBadge = '<span class="slash-command-badge mcp">MCP</span>';
      } else if (item.category === 'skill') {
        categoryBadge = '<span class="slash-command-badge skill">SKILL</span>';
      } else if (item.category === 'builtin') {
        categoryBadge = '<span class="slash-command-badge builtin">内置</span>';
      }
      
      // 最近使用标记
      const isRecent = state.recentSlashCommands.includes(item.id);
      const recentBadge = isRecent ? '<span class="slash-command-badge recent">最近</span>' : '';
      
      return `
      <button type="button" class="slash-command-item ${activeClass}" data-index="${index}">
        <div class="slash-command-main">
          <div class="slash-command-name">
            ${escapeHtml(item.label)}
            ${categoryBadge}
            ${recentBadge}
          </div>
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

  // 记录最近使用的命令
  recordRecentSlashCommand(item.id);

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
  setupAutoReconnectModeSelector();
  setupNotificationSoundSelector();
  setupNotificationDelayInputs();
  setupSendKeyMode();
  setupHistoryContinuationToggle();

  sendKeyModeSelectEl.addEventListener('change', () => {
    applySendKeyModeSelection(sendKeyModeSelectEl.value as SendKeyMode);
  });
  historyContinuationEnabledEl.addEventListener('change', () => {
    applyHistoryContinuationSelection(historyContinuationEnabledEl.checked);
  });

  themeToggleBtnEl.addEventListener('click', () => {
    state.currentTheme = THEME_CYCLE[state.currentTheme];
    applyTheme(state.currentTheme);
    localStorage.setItem(THEME_STORAGE_KEY, state.currentTheme);
  });
  notificationSoundSelectEl.addEventListener('change', () => {
    applyNotificationSoundSelection(notificationSoundSelectEl.value);
    void playTaskFinishSound();
  });
  notificationDelayMinuteInputEl.addEventListener('change', applyNotificationDelayFromInputs);
  notificationDelaySecondInputEl.addEventListener('change', applyNotificationDelayFromInputs);
  notificationDelayMinuteInputEl.addEventListener('blur', applyNotificationDelayFromInputs);
  notificationDelaySecondInputEl.addEventListener('blur', applyNotificationDelayFromInputs);
  notificationSoundUploadBtnEl.addEventListener('click', () => {
    notificationSoundUploadInputEl.click();
  });
  notificationSoundUploadInputEl.addEventListener('change', () => {
    void onUploadNotificationSound();
  });
  autoReconnectModeSelectEl.addEventListener('change', onAutoReconnectModeChange);
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
    showGitChangesForAgent(state.currentAgentId, true);
    void refreshCurrentAgentGitChanges();
    toolbarMoreMenuEl.classList.add('hidden');
  });
  openCapabilityCenterBtnEl.addEventListener('click', () => {
    toolbarMoreMenuEl.classList.add('hidden');
    showCapabilityCenterModal();
  });
  
  // Toolbar more menu
  toolbarMoreBtnEl.addEventListener('click', (e) => {
    e.stopPropagation();
    toolbarMoreMenuEl.classList.toggle('hidden');
  });
  
  document.addEventListener('click', (e) => {
    if (!toolbarMoreMenuEl.classList.contains('hidden')) {
      const target = e.target as HTMLElement;
      if (!toolbarMoreMenuEl.contains(target) && target !== toolbarMoreBtnEl) {
        toolbarMoreMenuEl.classList.add('hidden');
      }
    }
  });
  
  toggleThinkBtnEl.addEventListener('click', () => {
    void toggleCurrentAgentThink();
  });

  addAgentBtnEl.addEventListener('click', () => {
    addAgentModalEl.classList.remove('hidden');
  });
  openSettingsBtnEl.addEventListener('click', showSettingsModal);
  closeSettingsModalBtnEl.addEventListener('click', hideSettingsModal);
  closeSettingsFooterBtnEl.addEventListener('click', hideSettingsModal);
  openCapabilityCenterFromSettingsBtnEl.addEventListener('click', () => {
    hideSettingsModal();
    showCapabilityCenterModal();
  });
  closeCapabilityCenterModalBtnEl.addEventListener('click', hideCapabilityCenterModal);
  closeCapabilityCenterFooterBtnEl.addEventListener('click', hideCapabilityCenterModal);
  capabilityTabMcpBtnEl.addEventListener('click', () => {
    switchCapabilityCenterTab('mcp');
  });
  capabilityTabSkillBtnEl.addEventListener('click', () => {
    switchCapabilityCenterTab('skill');
  });
  capabilitySearchInputEl.addEventListener('input', () => {
    state.capabilitySearchQuery = capabilitySearchInputEl.value;
    renderCapabilityCenter();
  });
  capabilityMcpListEl.addEventListener('change', onCapabilityMcpToggleChange);
  capabilitySkillListEl.addEventListener('change', onCapabilitySkillToggleChange);

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
  settingsModalEl.addEventListener('click', (event) => {
    if (event.target === settingsModalEl) {
      hideSettingsModal();
    }
  });
  capabilityCenterModalEl.addEventListener('click', (event) => {
    if (event.target === capabilityCenterModalEl) {
      hideCapabilityCenterModal();
    }
  });
  document.addEventListener('keydown', (event) => {
    // Cmd/Ctrl + L: Focus input
    if ((event.metaKey || event.ctrlKey) && event.key === 'l') {
      event.preventDefault();
      messageInputEl.focus();
      return;
    }

    // Cmd/Ctrl + N: New session
    if ((event.metaKey || event.ctrlKey) && event.key === 'n') {
      event.preventDefault();
      void import('./sessions').then(({ startNewSession }) => {
        startNewSession();
      });
      return;
    }

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
    if (!capabilityCenterModalEl.classList.contains('hidden')) {
      hideCapabilityCenterModal();
      return;
    }
    if (!settingsModalEl.classList.contains('hidden')) {
      hideSettingsModal();
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

  // IME composition tracking - more reliable than e.isComposing
  // Use a flag with delayed reset because compositionend fires before keydown
  messageInputEl.addEventListener('compositionstart', () => {
    isComposing = true;
  });
  messageInputEl.addEventListener('compositionend', () => {
    // Delay reset to ensure keydown can detect composition just ended
    setTimeout(() => {
      isComposing = false;
    }, 0);
  });

  messageInputEl.addEventListener('keydown', (e) => {
    if (handleSlashMenuKeydown(e)) {
      return;
    }

    // Input history navigation
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const cursorAtStart = messageInputEl.selectionStart === 0 && messageInputEl.selectionEnd === 0;
      const cursorAtEnd = messageInputEl.selectionStart === messageInputEl.value.length && 
                          messageInputEl.selectionEnd === messageInputEl.value.length;

      if ((e.key === 'ArrowUp' && cursorAtStart) || (e.key === 'ArrowDown' && cursorAtEnd)) {
        e.preventDefault();
        navigateInputHistory(e.key === 'ArrowUp' ? 'up' : 'down');
        return;
      }
    }

    if (shouldSendOnEnter(e) || shouldSendOnModEnter(e)) {
      e.preventDefault();
      void sendMessage();
    }
  });

  messageInputEl.addEventListener('input', () => {
    messageInputEl.style.height = 'auto';
    messageInputEl.style.height = `${messageInputEl.scrollHeight}px`;
    updateSlashCommandMenu();
    // Auto-save draft
    if (state.currentSessionId) {
      saveDraft(state.currentSessionId, messageInputEl.value);
    }
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

  // Context usage bar click → trigger compression
  const contextUsageWrapperEl = document.getElementById('context-usage-wrapper');
  if (contextUsageWrapperEl) {
    contextUsageWrapperEl.addEventListener('click', async () => {
      const isBusy = isCurrentAgentBusy();
      if (isBusy) {
        return;
      }

      const agent = state.currentAgentId
        ? (state.agents.find((a) => a.id === state.currentAgentId) || null)
        : null;
      const currentSession = state.currentAgentId && state.currentSessionId
        ? (state.sessionsByAgent[state.currentAgentId] || []).find(
          (item) => item.id === state.currentSessionId
        )
        : null;
      const canCompress = canCompressContext({
        agent,
        hasSession: Boolean(state.currentSessionId),
        isBusy,
        messages: state.messages,
        sessionSource: currentSession?.source,
      });
      if (!canCompress) {
        return;
      }

      const confirmed = await showConfirmDialog(
        '压缩上下文',
        '压缩后将合并历史对话为摘要，释放上下文空间。\n此操作不可撤销。',
        { okText: '确认压缩' }
      );
      if (!confirmed) {
        return;
      }

      void sendCompressToCurrentSession();
    });
  }

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
  agentListEl.addEventListener('click', (event) => {
    onAgentListClick(event);
    void refreshSkillsForCurrentAgentType(false);
    renderCapabilityCenterIfVisible();
  });
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

  void refreshSkillsForCurrentAgentType(false);
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

// ── Input history navigation ──────────────────────────────────────────────────

function recordRecentSlashCommand(commandId: string) {
  // 移除旧记录（如果存在）
  const index = state.recentSlashCommands.indexOf(commandId);
  if (index !== -1) {
    state.recentSlashCommands.splice(index, 1);
  }
  
  // 添加到最前面
  state.recentSlashCommands.unshift(commandId);
  
  // 最多保留 10 个
  if (state.recentSlashCommands.length > 10) {
    state.recentSlashCommands.pop();
  }
}

function navigateInputHistory(direction: 'up' | 'down') {
  const history = state.inputHistory;
  const currentInput = messageInputEl.value;

  if (direction === 'up') {
    // Navigate backward in history
    if (state.inputHistoryIndex < history.length - 1) {
      // Save current input if at the start
      if (state.inputHistoryIndex === -1) {
        state.inputHistoryTemp = currentInput;
      }
      state.inputHistoryIndex++;
      messageInputEl.value = history[history.length - 1 - state.inputHistoryIndex];
    }
  } else {
    // Navigate forward in history
    if (state.inputHistoryIndex > 0) {
      state.inputHistoryIndex--;
      messageInputEl.value = history[history.length - 1 - state.inputHistoryIndex];
    } else if (state.inputHistoryIndex === 0) {
      // Restore the temporary saved input
      state.inputHistoryIndex = -1;
      messageInputEl.value = state.inputHistoryTemp;
      state.inputHistoryTemp = '';
    }
  }

  // Update textarea height and cursor position
  messageInputEl.style.height = 'auto';
  messageInputEl.style.height = `${messageInputEl.scrollHeight}px`;
  messageInputEl.setSelectionRange(messageInputEl.value.length, messageInputEl.value.length);

  // Update draft
  if (state.currentSessionId) {
    saveDraft(state.currentSessionId, messageInputEl.value);
  }
}

function addToInputHistory(content: string) {
  // Don't add empty or whitespace-only content
  if (!content.trim()) {
    return;
  }

  // Don't add duplicates
  const history = state.inputHistory;
  if (history.length > 0 && history[history.length - 1] === content) {
    return;
  }

  // Keep only last 100 items
  if (history.length >= 100) {
    history.shift();
  }

  history.push(content);
  state.inputHistoryIndex = -1;
  state.inputHistoryTemp = '';
}

// 发送消息
const MESSAGE_INACTIVITY_TIMEOUT_MS = TIMEOUTS.messageSend;
const MESSAGE_HARD_TIMEOUT_MS = TIMEOUTS.messageHardSend;

function clearMessageHardTimeout(): void {
  if (messageHardTimeoutId === null) {
    return;
  }
  window.clearTimeout(messageHardTimeoutId);
  messageHardTimeoutId = null;
}

function dismissMessageInactivityNotice(agentId?: string, sessionId?: string): void {
  if (!messageInactivityNotice) {
    return;
  }
  if (agentId && messageInactivityNotice.agentId !== agentId) {
    return;
  }
  if (sessionId && messageInactivityNotice.sessionId !== sessionId) {
    return;
  }

  const noticeId = messageInactivityNotice.messageId;
  const targetSessionId = messageInactivityNotice.sessionId;
  messageInactivityNotice = null;

  const existing = state.messagesBySession[targetSessionId] || [];
  const filtered = existing.filter((item) => item.id !== noticeId);
  if (filtered.length !== existing.length) {
    state.messagesBySession[targetSessionId] = filtered;
  }

  if (state.currentSessionId === targetSessionId) {
    const currentFiltered = state.messages.filter((item) => item.id !== noticeId);
    if (currentFiltered.length !== state.messages.length) {
      state.messages = currentFiltered;
      renderMessages();
    }
  }
}

function scheduleMessageHardTimeout(requestAgentId: string, requestSessionId: string): void {
  clearMessageHardTimeout();
  messageHardTimeoutId = window.setTimeout(() => {
    messageHardTimeoutId = null;
    if (state.inflightSessionByAgent[requestAgentId] !== requestSessionId) {
      return;
    }

    clearMessageWatchdog(state);
    dismissMessageInactivityNotice(requestAgentId, requestSessionId);

    const timeoutMessage: Message = {
      id: `msg-${Date.now()}-timeout-hard`,
      role: 'system',
      content:
        '⏱️ 长时间未完成（15分钟），已自动结束本次任务。\n\n你可以：\n- 再试一次\n- 把任务拆成更小步骤\n- 检查网络与工具状态',
      timestamp: new Date(),
    };
    state.messages.push(timeoutMessage);
    renderMessages();

    delete state.inflightSessionByAgent[requestAgentId];
    refreshComposerState();
    showError('任务执行超过 15 分钟，已自动停止');
  }, MESSAGE_HARD_TIMEOUT_MS);
}

function scheduleMessageTimeoutWatchdog(requestAgentId: string, requestSessionId: string): void {
  resetMessageWatchdog(state, requestAgentId, requestSessionId, MESSAGE_INACTIVITY_TIMEOUT_MS, () => {
    if (messageInactivityNotice) {
      return;
    }

    const timeoutMessage: Message = {
      id: `msg-${Date.now()}-timeout-soft`,
      role: 'system',
      content:
        '⏳ 60秒暂无新输出，任务可能仍在运行（如下载/安装）。\n\n你可以：\n- 继续等待\n- 点击停止按钮中断',
      timestamp: new Date(),
    };
    state.messages.push(timeoutMessage);
    renderMessages();
    messageInactivityNotice = {
      agentId: requestAgentId,
      sessionId: requestSessionId,
      messageId: timeoutMessage.id,
    };
  });
}

export async function sendMessage() {
  const content = messageInputEl.value.trim();
  const requestAgentId = state.currentAgentId;
  const requestSessionId = state.currentSessionId;
  if (!content || !requestSessionId) {
    return;
  }

  // Add to input history
  addToInputHistory(content);

  if (requestAgentId && state.inflightSessionByAgent[requestAgentId]) {
    return;
  }

  const handledByLocalAgentCommand = await handleLocalAgentCommand(content, requestSessionId);
  if (handledByLocalAgentCommand) {
    messageInputEl.value = '';
    messageInputEl.style.height = 'auto';
    hideSlashCommandMenu();
    if (requestSessionId) {
      clearDraft(requestSessionId);
    }
    return;
  }

  if (requestAgentId) {
    const handledByLocalModelCommand = await handleLocalModelCommand(
      content,
      requestAgentId,
      requestSessionId
    );
    if (handledByLocalModelCommand) {
      messageInputEl.value = '';
      messageInputEl.style.height = 'auto';
      hideSlashCommandMenu();
      if (requestSessionId) {
        clearDraft(requestSessionId);
      }
      return;
    }
  }

  if (!requestAgentId) {
    return;
  }

  const requestAgent = state.agents.find((agent) => agent.id === requestAgentId);
  if (requestAgent?.status !== 'connected') {
    showError('当前 Agent 离线，仅支持本地命令。可输入 /agents autoreconnect 重连。');
    return;
  }
  const targetSession = findSessionById(requestSessionId);
  const historyMessagesBeforeSend =
    targetSession?.source === 'iflow-log' ? getMessagesForSession(requestSessionId) : [];

  resetToolCallsForAgent(requestAgentId);

  messageInputEl.value = '';
  messageInputEl.style.height = 'auto';
  hideSlashCommandMenu();
  if (requestSessionId) {
    clearDraft(requestSessionId);
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
  clearMessageHardTimeout();
  dismissMessageInactivityNotice(requestAgentId, requestSessionId);
  refreshComposerState();

  try {
    if (targetSession && targetSession.source !== 'iflow-log' && !targetSession.acpSessionId) {
      targetSession.acpSessionId = generateAcpSessionId();
      void saveSessions();
    }
    const outboundContent =
      targetSession?.source === 'iflow-log' && state.historyContinuationEnabled
        ? buildHistoryContinuationPrompt(historyMessagesBeforeSend, content)
        : content;
    // 历史会话 (iflow-log) 的 acpSessionId 来自日志文件，不是当前运行时 session
    // 应该发送 null 让后端创建新 session，而不是尝试加载不存在的 session
    const outboundSessionId =
      targetSession?.source === 'iflow-log' ? null : targetSession?.acpSessionId || null;
    await tauriSendMessage(requestAgentId, outboundContent, outboundSessionId);

    state.messages = state.messages.filter((m) => m.id !== sendingMessage.id);
    renderMessages();

    if (state.inflightSessionByAgent[requestAgentId] !== requestSessionId) {
      return;
    }

    scheduleMessageTimeoutWatchdog(requestAgentId, requestSessionId);
    scheduleMessageHardTimeout(requestAgentId, requestSessionId);
  } catch (error) {
    state.messages = state.messages.filter((m) => m.id !== sendingMessage.id);
    renderMessages();

    if (state.inflightSessionByAgent[requestAgentId] !== requestSessionId) {
      return;
    }

    showError(`发送失败: ${String(error)}`);
    clearMessageWatchdog(state);
    clearMessageHardTimeout();
    dismissMessageInactivityNotice(requestAgentId, requestSessionId);
    delete state.inflightSessionByAgent[requestAgentId];
    refreshComposerState();
  }
}

export async function stopCurrentMessage() {
  const requestAgentId = state.currentAgentId;
  if (!requestAgentId || !state.inflightSessionByAgent[requestAgentId]) {
    return;
  }

  clearMessageWatchdog(state);
  clearMessageHardTimeout();
  dismissMessageInactivityNotice(requestAgentId, state.inflightSessionByAgent[requestAgentId]);

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

// ── Context Compression ────────────────────────────────────────────────────────

async function sendCompressToCurrentSession() {
  const agentId = state.currentAgentId;
  const sessionId = state.currentSessionId;
  if (!agentId || !sessionId) return;

  const agent = state.agents.find((a) => a.id === agentId);
  if (agent?.status !== 'connected') {
    showError('当前 Agent 离线，无法执行压缩');
    return;
  }

  // 添加用户消息到当前会话
  const userMessage: Message = {
    id: `msg-${Date.now()}`,
    role: 'user',
    content: '/compress',
    timestamp: new Date(),
  };
  state.messages.push(userMessage);
  touchCurrentSession();
  renderMessages();
  scrollToBottom();

  state.inflightSessionByAgent[agentId] = sessionId;
  clearMessageHardTimeout();
  dismissMessageInactivityNotice(agentId, sessionId);
  refreshComposerState();

  try {
    // 发送 null session ID，让 adapter 使用当前 session，避免 session switch
    await tauriSendMessage(agentId, '/compress', null);
    scheduleMessageTimeoutWatchdog(agentId, sessionId);
    scheduleMessageHardTimeout(agentId, sessionId);
  } catch (error) {
    showError(`压缩失败: ${String(error)}`);
    clearMessageWatchdog(state);
    clearMessageHardTimeout();
    dismissMessageInactivityNotice(agentId, sessionId);
    delete state.inflightSessionByAgent[agentId];
    refreshComposerState();
  }
}

// ── Draft restoration ────────────────────────────────────────────────────────

export function restoreDraftForSession(sessionId: string | null) {
  if (!sessionId) {
    messageInputEl.value = '';
    messageInputEl.style.height = 'auto';
    return;
  }

  const draft = getDraft(sessionId);
  if (draft) {
    messageInputEl.value = draft;
    messageInputEl.style.height = 'auto';
    messageInputEl.style.height = `${messageInputEl.scrollHeight}px`;
  } else {
    messageInputEl.value = '';
    messageInputEl.style.height = 'auto';
  }
}

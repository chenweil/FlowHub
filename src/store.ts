// src/store.ts — centralized application state
import type {
  Agent,
  Session,
  Message,
  ToolCall,
  AgentRegistry,
  ModelOption,
  ThinkSupportStatus,
  SlashMenuItem,
  ThemeMode,
  GitFileChange,
  SendKeyMode,
  SkillRuntimeItem,
} from './types';
import {
  isMcpSuggestionEnabled as isMcpSuggestionEnabledInMap,
  loadCapabilityEnableSettings,
  persistCapabilityEnableSettings,
  setMcpSuggestionEnabled as setMcpSuggestionEnabledInMap,
  isSkillSuggestionEnabled as isSkillSuggestionEnabledInMap,
  setSkillSuggestionEnabled as setSkillSuggestionEnabledInMap,
} from './features/capabilities/enables';

const NOTIFICATION_DELAY_STORAGE_KEY = 'iflow-notification-delay-ms';
const NOTIFICATION_DEFAULT_DELAY_MS = 5000;
const NOTIFICATION_MAX_DELAY_MS = 59 * 60 * 1000 + 59 * 1000;
const SEND_KEY_MODE_STORAGE_KEY = 'iflow-send-key-mode';
const HISTORY_CONTINUATION_STORAGE_KEY = 'iflow-history-continuation-enabled';
const capabilityEnableSettings = loadCapabilityEnableSettings();

function normalizeSendKeyMode(rawValue: string | null): SendKeyMode {
  if (rawValue === 'mod+enter') {
    return 'mod+enter';
  }
  return 'enter';
}

function normalizeNotificationDelayMs(rawValue: string | null): number {
  const parsed = Number.parseInt(rawValue || '', 10);
  if (!Number.isFinite(parsed)) {
    return NOTIFICATION_DEFAULT_DELAY_MS;
  }
  const normalized = Math.max(0, Math.min(NOTIFICATION_MAX_DELAY_MS, parsed));
  return normalized;
}

function normalizeHistoryContinuationEnabled(rawValue: string | null): boolean {
  if (rawValue === '0' || rawValue === 'false') {
    return false;
  }
  return true;
}

export const state = {
  // ── 核心实体 ──────────────────────────────────────────────────────────────
  agents: [] as Agent[],
  currentAgentId: null as string | null,
  currentSessionId: null as string | null,
  messages: [] as Message[],

  // ── 关联数据 ──────────────────────────────────────────────────────────────
  sessionsByAgent: {} as Record<string, Session[]>,
  messagesBySession: {} as Record<string, Message[]>,
  draftsBySession: {} as Record<string, string>,
  scrollPositionsBySession: {} as Record<string, number>,
  inflightSessionByAgent: {} as Record<string, string>,
  
  // ── 输入历史 ──────────────────────────────────────────────────────────────
  inputHistory: [] as string[],
  inputHistoryIndex: -1,
  inputHistoryTemp: '',
  
  // ── Slash 命令最近使用 ───────────────────────────────────────────────────
  recentSlashCommands: [] as string[], // 存储命令 ID，最多保留 10 个
  registryByAgent: {} as Record<string, AgentRegistry>,
  mcpEnabledByAgent: capabilityEnableSettings.mcpEnabledByAgent,
  skillEnabledByAgentType: capabilityEnableSettings.skillEnabledByAgentType,
  skillRuntimeByAgentType: {} as Record<string, SkillRuntimeItem[]>,
  toolCallsByAgent: {} as Record<string, ToolCall[]>,
  modelOptionsCacheByAgent: {} as Record<string, ModelOption[]>,
  thinkSupportByModel: {} as Record<string, ThinkSupportStatus>,
  gitChangesByAgent: {} as Record<string, GitFileChange[]>,
  gitChangesLoadingByAgent: {} as Record<string, boolean>,
  gitChangesErrorByAgent: {} as Record<string, string>,
  gitChangesLastRefreshedAtByAgent: {} as Record<string, number>,

  // ── UI 交互状态 ────────────────────────────────────────────────────────────
  modelSelectorOpen: false,
  modelSwitchingAgentId: null as string | null,
  thinkSwitchingAgentId: null as string | null,
  renamingAgentId: null as string | null,

  // slash menu
  slashMenuItems: [] as SlashMenuItem[],
  slashMenuVisible: false,
  slashMenuActiveIndex: 0,

  // artifact preview
  artifactPreviewRequestToken: 0,
  artifactPreviewCacheByKey: new Map<string, string>(),
  artifactPreviewCacheOrder: [] as string[],
  artifactPreviewLastKey: null as string | null,

  // message send timeout
  messageTimeout: null as number | null,

  // theme
  currentTheme: ((localStorage.getItem('iflow-theme') as ThemeMode) || 'system') as ThemeMode,
  notificationSoundId: localStorage.getItem('iflow-notification-sound') || 'bell-happy.wav',
  notificationDelayMs: normalizeNotificationDelayMs(localStorage.getItem(NOTIFICATION_DELAY_STORAGE_KEY)),
  notificationCustomSoundDataUrl: localStorage.getItem('iflow-notification-custom-sound'),
  notificationCustomSoundName: localStorage.getItem('iflow-notification-custom-sound-name'),
  // send key mode
  sendKeyMode: normalizeSendKeyMode(localStorage.getItem(SEND_KEY_MODE_STORAGE_KEY)),
  historyContinuationEnabled: normalizeHistoryContinuationEnabled(
    localStorage.getItem(HISTORY_CONTINUATION_STORAGE_KEY)
  ),
  capabilityCenterTab: 'mcp' as 'mcp' | 'skill',
  capabilitySearchQuery: '',
  capabilityLoading: false,
  capabilityErrors: {} as Record<string, string>,
};

export function setSendKeyMode(mode: SendKeyMode): void {
  localStorage.setItem(SEND_KEY_MODE_STORAGE_KEY, mode);
  state.sendKeyMode = mode;
}

export function setHistoryContinuationEnabled(enabled: boolean): void {
  localStorage.setItem(HISTORY_CONTINUATION_STORAGE_KEY, enabled ? '1' : '0');
  state.historyContinuationEnabled = enabled;
}

export function canUseConversationQuickAction(): boolean {
  if (!state.currentAgentId || !state.currentSessionId) {
    return false;
  }
  const agent = state.agents.find((item) => item.id === state.currentAgentId);
  return Boolean(agent && agent.status === 'connected' && !state.inflightSessionByAgent[agent.id]);
}

function saveCapabilityEnableSettings(): void {
  persistCapabilityEnableSettings({
    version: 1,
    mcpEnabledByAgent: state.mcpEnabledByAgent,
    skillEnabledByAgentType: state.skillEnabledByAgentType,
    updatedAt: Date.now(),
  });
}

export function isMcpSuggestionEnabledForAgent(agentId: string, serverName: string): boolean {
  return isMcpSuggestionEnabledInMap(state.mcpEnabledByAgent, agentId, serverName);
}

export function setMcpSuggestionEnabledForAgent(agentId: string, serverName: string, enabled: boolean): void {
  state.mcpEnabledByAgent = setMcpSuggestionEnabledInMap(state.mcpEnabledByAgent, agentId, serverName, enabled);
  saveCapabilityEnableSettings();
}

export function isSkillSuggestionEnabledForAgentType(agentType: string, skillName: string): boolean {
  return isSkillSuggestionEnabledInMap(state.skillEnabledByAgentType, agentType, skillName);
}

export function setSkillSuggestionEnabledForAgentType(
  agentType: string,
  skillName: string,
  enabled: boolean
): void {
  state.skillEnabledByAgentType = setSkillSuggestionEnabledInMap(
    state.skillEnabledByAgentType,
    agentType,
    skillName,
    enabled
  );
  saveCapabilityEnableSettings();
}

// src/store.ts — centralized application state
import type { Agent, Session, Message, ToolCall, AgentRegistry, ModelOption, SlashMenuItem, ThemeMode } from './types';

export const state = {
  // ── 核心实体 ──────────────────────────────────────────────────────────────
  agents: [] as Agent[],
  currentAgentId: null as string | null,
  currentSessionId: null as string | null,
  messages: [] as Message[],

  // ── 关联数据 ──────────────────────────────────────────────────────────────
  sessionsByAgent: {} as Record<string, Session[]>,
  messagesBySession: {} as Record<string, Message[]>,
  inflightSessionByAgent: {} as Record<string, string>,
  registryByAgent: {} as Record<string, AgentRegistry>,
  toolCallsByAgent: {} as Record<string, ToolCall[]>,
  modelOptionsCacheByAgent: {} as Record<string, ModelOption[]>,

  // ── UI 交互状态 ────────────────────────────────────────────────────────────
  modelSelectorOpen: false,
  modelSwitchingAgentId: null as string | null,
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
};

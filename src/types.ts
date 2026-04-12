// src/types.ts - Shared type definitions

export interface Agent {
  id: string;
  name: string;
  type: string;
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  workspacePath: string;
  qwenPath?: string;
  selectedModel?: string;
  thinkEnabled?: boolean;
}

export interface Session {
  id: string;
  agentId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  acpSessionId?: string;
  source?: 'local' | 'qwen-log';
  messageCountHint?: number;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'thought';
  content: string;
  timestamp: Date;
  agentId?: string;
  toolCalls?: ToolCall[];
  estimatedTokens?: number;
}

export interface ReportedContextUsage {
  usedTokens: number;
  contextWindow: number;
  percentage: number;
  source: 'reported';
}

export interface AgentActivity {
  lastUpdatedAt: number;
  label: string;
  toolName?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  arguments?: Record<string, unknown>;
  output?: string;
}

export type GitStatus =
  | 'none'
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'unmerged'
  | 'untracked'
  | 'ignored'
  | 'unknown';

export interface GitFileChange {
  path: string;
  stagedStatus: GitStatus;
  unstagedStatus: GitStatus;
}

export interface FileItem {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified_at: number | null;
}

export interface RegistryCommand {
  name: string;
  description: string;
  scope: string;
}

export interface RegistryMcpServer {
  name: string;
  description: string;
}

export interface SkillRuntimeItem {
  agentType: string;
  skillName: string;
  title: string;
  description: string;
  path: string;
  source: 'qwen-cli-dir';
  discoveredAt: number;
}

export interface ModelOption {
  label: string;
  value: string;
}

export type ThinkSupportStatus = 'unknown' | 'supported' | 'unsupported';

export interface AgentRegistry {
  commands: RegistryCommand[];
  mcpServers: RegistryMcpServer[];
}

export interface SlashMenuItem {
  id: string;
  label: string;
  insertText: string;
  description: string;
  hint: string;
  category: 'command' | 'mcp' | 'skill' | 'builtin';
  searchable: string;
}

export interface StoredSession {
  id: string;
  agentId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  acpSessionId?: string;
  source?: 'local' | 'qwen-log';
  messageCountHint?: number;
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'thought';
  content: string;
  timestamp: string;
  agentId?: string;
}

export type StoredSessionMap = Record<string, StoredSession[]>;
export type StoredMessageMap = Record<string, StoredMessage[]>;
export type StoredDraftMap = Record<string, string>;
export type LegacyMessageHistoryMap = Record<string, StoredMessage[]>;

export interface StorageSnapshot {
  sessionsByAgent: StoredSessionMap;
  messagesBySession: StoredMessageMap;
  draftsBySession?: StoredDraftMap;
}

export interface QwenHistorySessionRecord {
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface QwenHistoryMessageRecord {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export type ComposerState = 'ready' | 'busy' | 'disabled';
export type StreamMessageType = 'content' | 'thought' | 'system' | 'plan';
export type ThemeMode = 'system' | 'light' | 'dark';
export type SendKeyMode = 'enter' | 'mod+enter';

export interface ParsedModelSlashCommand {
  kind: 'help' | 'switch' | 'current';
  targetModel?: string;
  filterKeyword?: string;
}

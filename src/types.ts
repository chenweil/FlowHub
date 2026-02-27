// src/types.ts - Shared type definitions

export interface Agent {
  id: string;
  name: string;
  type: string;
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  workspacePath: string;
  iflowPath?: string;
  selectedModel?: string;
  port?: number;
}

export interface Session {
  id: string;
  agentId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  acpSessionId?: string;
  source?: 'local' | 'iflow-log';
  messageCountHint?: number;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'thought';
  content: string;
  timestamp: Date;
  agentId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  arguments?: Record<string, unknown>;
  output?: string;
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

export interface ModelOption {
  label: string;
  value: string;
}

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
  category: 'command' | 'mcp' | 'builtin';
  searchable: string;
}

export interface StoredSession {
  id: string;
  agentId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  acpSessionId?: string;
  source?: 'local' | 'iflow-log';
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
export type LegacyMessageHistoryMap = Record<string, StoredMessage[]>;

export interface StorageSnapshot {
  sessionsByAgent: StoredSessionMap;
  messagesBySession: StoredMessageMap;
}

export interface IflowHistorySessionRecord {
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface IflowHistoryMessageRecord {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export type ComposerState = 'ready' | 'busy' | 'disabled';
export type StreamMessageType = 'content' | 'thought' | 'system' | 'plan';
export type ThemeMode = 'system' | 'light' | 'dark';

export interface ParsedModelSlashCommand {
  kind: 'help' | 'switch' | 'current';
  targetModel?: string;
  filterKeyword?: string;
}

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { StreamMessageType, ToolCall } from '../types';

// Payload interfaces

export interface StreamMessagePayload {
  agentId?: string;
  content?: string;
  type?: StreamMessageType;
}

export interface ToolCallPayload {
  agentId?: string;
  toolCalls?: ToolCall[];
}

export interface CommandRegistryPayload {
  agentId?: string;
  commands?: unknown[];
  mcpServers?: unknown[];
}

export interface ModelRegistryPayload {
  agentId?: string;
  models?: unknown[];
  currentModel?: unknown;
}

export interface AcpSessionPayload {
  agentId?: string;
  sessionId?: string;
}

export interface TaskFinishPayload {
  agentId?: string;
}

export interface AgentErrorPayload {
  agentId?: string;
  error?: string;
}

// Typed wrapper functions

export function onStreamMessage(
  callback: (payload: StreamMessagePayload) => void
): Promise<UnlistenFn> {
  return listen<StreamMessagePayload>('stream-message', (event) => callback(event.payload));
}

export function onToolCall(callback: (payload: ToolCallPayload) => void): Promise<UnlistenFn> {
  return listen<ToolCallPayload>('tool-call', (event) => callback(event.payload));
}

export function onCommandRegistry(
  callback: (payload: CommandRegistryPayload) => void
): Promise<UnlistenFn> {
  return listen<CommandRegistryPayload>('command-registry', (event) => callback(event.payload));
}

export function onModelRegistry(
  callback: (payload: ModelRegistryPayload) => void
): Promise<UnlistenFn> {
  return listen<ModelRegistryPayload>('model-registry', (event) => callback(event.payload));
}

export function onAcpSession(
  callback: (payload: AcpSessionPayload) => void
): Promise<UnlistenFn> {
  return listen<AcpSessionPayload>('acp-session', (event) => callback(event.payload));
}

export function onTaskFinish(
  callback: (payload: TaskFinishPayload) => void
): Promise<UnlistenFn> {
  return listen<TaskFinishPayload>('task-finish', (event) => callback(event.payload));
}

export function onAgentError(
  callback: (payload: AgentErrorPayload) => void
): Promise<UnlistenFn> {
  return listen<AgentErrorPayload>('agent-error', (event) => callback(event.payload));
}

// src/lib/utils.ts
import type { StreamMessageType, Message } from '../types';

export function generateAcpSessionId(): string {
  const randomUuid =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
  return `session-${randomUuid}`;
}

export function shortAgentId(agentId: string): string {
  return agentId.length > 8 ? agentId.slice(-8) : agentId;
}

export function getWorkspaceName(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : workspacePath;
}

export function streamTypeToRole(messageType?: StreamMessageType): Message['role'] {
  if (messageType === 'thought') {
    return 'thought';
  }
  if (messageType === 'system' || messageType === 'plan') {
    return 'system';
  }
  return 'assistant';
}

export function normalizeStoredRole(role: string): Message['role'] {
  if (role === 'user' || role === 'assistant' || role === 'system' || role === 'thought') {
    return role;
  }
  return 'assistant';
}

export function formatTime(date: Date): string {
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatSessionMeta(updatedAt: Date, messageCount: number): string {
  const timeText = updatedAt.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${messageCount} 条消息 · ${timeText}`;
}

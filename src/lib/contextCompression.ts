import type { Agent, Message, Session } from '../types';

export interface CompressionEligibilityInput {
  agent: Agent | null;
  hasSession: boolean;
  isBusy: boolean;
  messages: Message[];
  sessionSource?: Session['source'];
}

export function hasConversationMessages(messages: Message[]): boolean {
  return messages.some((m) => m.role === 'user' || m.role === 'assistant');
}

export function hasCompressibleConversation(messages: Message[]): boolean {
  let hasUser = false;
  let hasAssistant = false;
  for (const message of messages) {
    if (message.role === 'user') {
      hasUser = true;
    }
    if (message.role === 'assistant') {
      hasAssistant = true;
    }
    if (hasUser && hasAssistant) {
      return true;
    }
  }
  return false;
}

export function getCompressionDisabledReason(input: CompressionEligibilityInput): string | null {
  if (!input.hasSession) {
    return '未选择会话';
  }
  if (!input.agent || input.agent.status !== 'connected') {
    return 'Agent 离线';
  }
  if (input.sessionSource === 'iflow-log') {
    return '历史会话不可压缩';
  }
  if (input.isBusy) {
    return '正在生成回复中';
  }
  if (!hasCompressibleConversation(input.messages)) {
    return '对话不足以压缩';
  }
  return null;
}

export function canCompressContext(input: CompressionEligibilityInput): boolean {
  return getCompressionDisabledReason(input) === null;
}

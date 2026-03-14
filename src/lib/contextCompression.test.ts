import { describe, expect, it } from 'vitest';
import type { Agent, Message } from '../types';
import {
  canCompressContext,
  getCompressionDisabledReason,
  hasCompressibleConversation,
  hasConversationMessages,
} from './contextCompression';

const baseAgent: Agent = {
  id: 'agent-1',
  name: 'Agent',
  type: 'iflow',
  status: 'connected',
  workspacePath: '/tmp',
};

const userMessage: Message = {
  id: 'msg-1',
  role: 'user',
  content: 'hi',
  timestamp: new Date(),
};

const systemMessage: Message = {
  id: 'msg-2',
  role: 'system',
  content: 'sys',
  timestamp: new Date(),
};

const assistantMessage: Message = {
  id: 'msg-3',
  role: 'assistant',
  content: 'ok',
  timestamp: new Date(),
};

describe('contextCompression', () => {
  it('detects conversation messages', () => {
    expect(hasConversationMessages([systemMessage])).toBe(false);
    expect(hasConversationMessages([systemMessage, userMessage])).toBe(true);
  });

  it('requires both user and assistant messages to be compressible', () => {
    expect(hasCompressibleConversation([userMessage])).toBe(false);
    expect(hasCompressibleConversation([assistantMessage])).toBe(false);
    expect(hasCompressibleConversation([userMessage, assistantMessage])).toBe(true);
  });

  it('returns false when session missing or agent offline or busy', () => {
    expect(
      canCompressContext({
        agent: baseAgent,
        hasSession: false,
        isBusy: false,
        messages: [userMessage],
      })
    ).toBe(false);

    expect(
      canCompressContext({
        agent: { ...baseAgent, status: 'disconnected' },
        hasSession: true,
        isBusy: false,
        messages: [userMessage],
      })
    ).toBe(false);

    expect(
      canCompressContext({
        agent: baseAgent,
        hasSession: true,
        isBusy: true,
        messages: [userMessage],
      })
    ).toBe(false);
  });

  it('returns true when connected, not busy, has session, and has conversation', () => {
    expect(
      canCompressContext({
        agent: baseAgent,
        hasSession: true,
        isBusy: false,
        messages: [userMessage, assistantMessage],
      })
    ).toBe(true);
  });

  it('returns reason when compression is disabled', () => {
    expect(
      getCompressionDisabledReason({
        agent: baseAgent,
        hasSession: false,
        isBusy: false,
        messages: [userMessage, assistantMessage],
      })
    ).toBe('未选择会话');

    expect(
      getCompressionDisabledReason({
        agent: { ...baseAgent, status: 'disconnected' },
        hasSession: true,
        isBusy: false,
        messages: [userMessage, assistantMessage],
      })
    ).toBe('Agent 离线');

    expect(
      getCompressionDisabledReason({
        agent: baseAgent,
        hasSession: true,
        isBusy: false,
        messages: [userMessage, assistantMessage],
        sessionSource: 'iflow-log',
      })
    ).toBe('历史会话不可压缩');

    expect(
      getCompressionDisabledReason({
        agent: baseAgent,
        hasSession: true,
        isBusy: true,
        messages: [userMessage, assistantMessage],
      })
    ).toBe('正在生成回复中');

    expect(
      getCompressionDisabledReason({
        agent: baseAgent,
        hasSession: true,
        isBusy: false,
        messages: [userMessage],
      })
    ).toBe('对话不足以压缩');
  });
});

import { describe, expect, it } from 'vitest';
import type { Message } from '../types';
import { buildHistoryContinuationPrompt } from './historyContinuation';

function createMessage(role: Message['role'], content: string): Message {
  return {
    id: `msg-${Math.random().toString(16).slice(2, 8)}`,
    role,
    content,
    timestamp: new Date(),
  };
}

describe('buildHistoryContinuationPrompt', () => {
  it('returns raw input when no user/assistant history exists', () => {
    const result = buildHistoryContinuationPrompt([createMessage('system', 'note')], '下一步怎么处理');
    expect(result).toBe('下一步怎么处理');
  });

  it('injects transcript when history exists', () => {
    const history: Message[] = [
      createMessage('user', '我要加一个 MCP'),
      createMessage('assistant', '可以，先确认配置结构'),
    ];

    const result = buildHistoryContinuationPrompt(history, '下一步怎么处理');
    expect(result).toContain('[历史对话开始]');
    expect(result).toContain('用户: 我要加一个 MCP');
    expect(result).toContain('助手: 可以，先确认配置结构');
    expect(result).toContain('用户最新问题: 下一步怎么处理');
  });

  it('keeps only the latest turns for large history', () => {
    const history: Message[] = [];
    for (let i = 0; i < 30; i += 1) {
      history.push(createMessage(i % 2 === 0 ? 'user' : 'assistant', `第${i}条`));
    }

    const result = buildHistoryContinuationPrompt(history, '继续');
    expect(result).toContain('第29条');
    expect(result).not.toContain('第0条');
  });
});

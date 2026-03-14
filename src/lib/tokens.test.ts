import { describe, expect, it } from 'vitest';
import { estimateTokens, calculateContextUsage } from './tokens';
import type { Message } from '../types';

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates pure ASCII text (~4 chars per token)', () => {
    // "hello world" = 11 ASCII chars → ceil(11/4) = 3
    expect(estimateTokens('hello world')).toBe(3);
  });

  it('estimates pure CJK text (1 char per token)', () => {
    // "你好世界" = 4 non-ASCII chars → 4
    expect(estimateTokens('你好世界')).toBe(4);
  });

  it('estimates mixed ASCII + CJK text', () => {
    // "hello 世界" = 6 ASCII + 2 CJK → ceil(6/4) + 2 = 4
    expect(estimateTokens('hello 世界')).toBe(4);
  });

  it('handles whitespace-only text', () => {
    expect(estimateTokens('    ')).toBe(1);
  });
});

describe('calculateContextUsage', () => {
  function makeMessage(content: string): Message {
    return {
      id: `msg-${Date.now()}`,
      role: 'user',
      content,
      timestamp: new Date(),
    };
  }

  it('returns zero usage for empty messages', () => {
    const usage = calculateContextUsage([], 128_000);
    expect(usage.usedTokens).toBe(0);
    expect(usage.percentage).toBe(0);
  });

  it('calculates usage and caches estimatedTokens', () => {
    const msg = makeMessage('hello world');
    expect(msg.estimatedTokens).toBeUndefined();

    const usage = calculateContextUsage([msg], 128_000);
    expect(usage.usedTokens).toBe(3);
    expect(msg.estimatedTokens).toBe(3);
    expect(usage.percentage).toBeCloseTo(3 / 128_000 * 100, 5);
  });

  it('uses cached estimatedTokens when present', () => {
    const msg = makeMessage('hello world');
    msg.estimatedTokens = 42; // Override with fake cache

    const usage = calculateContextUsage([msg], 128_000);
    expect(usage.usedTokens).toBe(42);
  });

  it('sums multiple messages', () => {
    const msgs = [
      makeMessage('hello'),   // ceil(5/4) = 2
      makeMessage('你好世界'), // 4
    ];
    const usage = calculateContextUsage(msgs, 128_000);
    expect(usage.usedTokens).toBe(6);
  });

  it('caps percentage at correct value', () => {
    const msg = makeMessage('a'.repeat(1000));
    const usage = calculateContextUsage([msg], 100);
    // 250 tokens / 100 window = 250%
    expect(usage.percentage).toBe(250);
  });
});

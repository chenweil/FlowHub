// src/lib/tokens.ts — token estimation and context usage calculation

import type { Message } from '../types';

export interface ContextUsage {
  usedTokens: number;
  contextWindow: number;
  percentage: number;
}

/**
 * Estimate token count for text.
 * ASCII: ~4 chars per token; non-ASCII (CJK etc.): ~1 char per token.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  let asciiCount = 0;
  let nonAsciiCount = 0;

  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) <= 127) {
      asciiCount++;
    } else {
      nonAsciiCount++;
    }
  }

  return Math.ceil(asciiCount / 4) + nonAsciiCount;
}

/**
 * Calculate context usage from messages.
 * Uses cached `estimatedTokens` when available; computes and caches otherwise.
 */
export function calculateContextUsage(messages: Message[], contextWindow: number): ContextUsage {
  let usedTokens = 0;

  for (const msg of messages) {
    if (msg.estimatedTokens != null) {
      usedTokens += msg.estimatedTokens;
    } else {
      const tokens = estimateTokens(msg.content);
      msg.estimatedTokens = tokens;
      usedTokens += tokens;
    }
  }

  const percentage = contextWindow > 0 ? (usedTokens / contextWindow) * 100 : 0;

  return { usedTokens, contextWindow, percentage };
}

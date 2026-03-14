import { describe, expect, it } from 'vitest';
import { getContextWindow } from './modelContext';

describe('getContextWindow', () => {
  it('returns default 128K for undefined', () => {
    expect(getContextWindow(undefined)).toBe(128_000);
  });

  it('returns default 128K for empty string', () => {
    expect(getContextWindow('')).toBe(128_000);
  });

  it('exact matches CLI models (case-insensitive)', () => {
    expect(getContextWindow('GLM-4.7')).toBe(200_000);
    expect(getContextWindow('glm-5')).toBe(200_000);
    expect(getContextWindow('iflow-rome-30ba3b')).toBe(256_000);
    expect(getContextWindow('deepseek-v3.2')).toBe(128_000);
    expect(getContextWindow('Qwen3-Coder-Plus')).toBe(1_000_000);
    expect(getContextWindow('kimi-k2-thinking')).toBe(256_000);
    expect(getContextWindow('MiniMax-M2.5')).toBe(200_000);
    expect(getContextWindow('kimi-k2.5')).toBe(256_000);
    expect(getContextWindow('kimi-k2-0905')).toBe(256_000);
  });

  it('matches platform models', () => {
    expect(getContextWindow('deepseek-r1')).toBe(32_000);
    expect(getContextWindow('qwen3-max')).toBe(256_000);
    expect(getContextWindow('qwen3-vl-plus')).toBe(256_000);
  });

  it('substring matches for variant names', () => {
    expect(getContextWindow('iflow-rome-30ba3b-v2')).toBe(256_000);
    expect(getContextWindow('some-prefix-glm-5-suffix')).toBe(200_000);
  });

  it('returns default for unknown model', () => {
    expect(getContextWindow('totally-unknown-model')).toBe(128_000);
  });
});

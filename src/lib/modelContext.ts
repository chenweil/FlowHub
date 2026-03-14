// src/lib/modelContext.ts — model context window mapping

const MODEL_CONTEXT_MAP: Record<string, number> = {
  // ── CLI 支持的模型（精确匹配优先） ──
  'glm-4.7':                200_000,
  'glm-5':                  200_000,
  'iflow-rome-30ba3b':      256_000,
  'iflow-rome':             256_000,
  'deepseek-v3.2':          128_000,
  'deepseek-v3.2-exp':      128_000,
  'qwen3-coder-plus':     1_000_000,
  'kimi-k2-thinking':       256_000,
  'minimax-m2.5':           200_000,
  'kimi-k2.5':              256_000,
  'kimi-k2-0905':           256_000,
  'kimi-k2-instruct-0905':  256_000,

  // ── 平台其他模型 ──
  'qwen3-max':              256_000,
  'qwen3-max-preview':      256_000,
  'qwen3-vl-plus':          256_000,
  'kimi-k2':                128_000,
  'deepseek-r1':             32_000,
  'deepseek-v3-671b':       128_000,
  'deepseek-v3':            128_000,
  'qwen3-32b':              128_000,
  'qwen3-235b-a22b-thinking':  256_000,
  'qwen3-235b-a22b-instruct':  256_000,
  'qwen3-235b-a22b':        128_000,
};

const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Get context window size for a model.
 * Tries exact match first, then substring match, then falls back to default.
 */
export function getContextWindow(modelName: string | undefined): number {
  if (!modelName) return DEFAULT_CONTEXT_WINDOW;

  const key = modelName.toLowerCase().trim();

  // Exact match
  if (MODEL_CONTEXT_MAP[key] != null) {
    return MODEL_CONTEXT_MAP[key];
  }

  // Substring match
  for (const [mapKey, value] of Object.entries(MODEL_CONTEXT_MAP)) {
    if (key.includes(mapKey) || mapKey.includes(key)) {
      return value;
    }
  }

  return DEFAULT_CONTEXT_WINDOW;
}

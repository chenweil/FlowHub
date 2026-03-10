// src/features/agents/utils.ts — helper utilities for agent feature
import { showConfirmDialog } from '../../dom';

const THINK_UNSUPPORTED_HINTS = [
  'not support',
  'not supported',
  'unsupported',
  'does not support',
  'method not found',
  'unknown method',
  'not implemented',
  'unavailable',
  '不支持',
  '不可用',
  '未实现',
];

// ── Text utilities ────────────────────────────────────────────────────────────

export function readTextFromUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => readTextFromUnknown(item))
      .filter((item) => Boolean(item))
      .join(' ')
      .trim();
  }

  if (value && typeof value === 'object') {
    return readTextFromUnknown((value as Record<string, unknown>).text);
  }

  return '';
}

// ── Error utilities ───────────────────────────────────────────────────────────

export function readErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

export function normalizeConnectionErrorMessage(error: unknown): string {
  const message = readErrorMessage(error);
  const lower = message.toLowerCase();
  if (
    lower.includes('__tauri_ipc__') ||
    lower.includes('__tauri_internals__') ||
    lower.includes('tauri is not available')
  ) {
    return '当前是浏览器预览模式，无法连接 Agent。请使用已安装 App，或执行 npm run tauri:dev。';
  }
  return message;
}

// ── Think support utilities ──────────────────────────────────────────────────

import type { ThinkSupportStatus } from '../../types';
import { state } from '../../store';

function normalizeThinkModelKey(modelName: string | undefined): string | null {
  if (typeof modelName !== 'string') {
    return null;
  }
  const normalized = modelName.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

export function getThinkSupportByModel(modelName: string | undefined): ThinkSupportStatus {
  const key = normalizeThinkModelKey(modelName);
  if (!key) {
    return 'unknown';
  }
  return state.thinkSupportByModel[key] || 'unknown';
}

export function setThinkSupportByModel(modelName: string | undefined, status: ThinkSupportStatus): void {
  const key = normalizeThinkModelKey(modelName);
  if (!key) {
    return;
  }
  state.thinkSupportByModel[key] = status;
}

export function isThinkUnsupportedError(error: unknown): boolean {
  const message = readErrorMessage(error).toLowerCase();
  if (THINK_UNSUPPORTED_HINTS.some((hint) => message.includes(hint))) {
    return true;
  }

  const hasThinkContext = message.includes('set_think') || message.includes('think');
  const hasInvalidParams = message.includes('invalid params') || message.includes('invalid parameters');
  return hasThinkContext && hasInvalidParams;
}

// ── LocalStorage utilities ───────────────────────────────────────────────────

const LAST_CONNECTED_AGENT_STORAGE_KEY = 'iflow-last-connected-agent-id';

export function readLastConnectedAgentId(): string | null {
  try {
    const value = localStorage.getItem(LAST_CONNECTED_AGENT_STORAGE_KEY);
    if (!value) {
      return null;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  } catch (error) {
    console.error('Read last connected agent failed:', error);
    return null;
  }
}

export function markLastConnectedAgent(agentId: string): void {
  try {
    localStorage.setItem(LAST_CONNECTED_AGENT_STORAGE_KEY, agentId);
  } catch (error) {
    console.error('Save last connected agent failed:', error);
  }
}

export function removeLastConnectedAgentIfMatches(agentId: string): void {
  const lastAgentId = readLastConnectedAgentId();
  if (lastAgentId !== agentId) {
    return;
  }
  try {
    localStorage.removeItem(LAST_CONNECTED_AGENT_STORAGE_KEY);
  } catch (error) {
    console.error('Clear last connected agent failed:', error);
  }
}

// ── UI utilities ─────────────────────────────────────────────────────────────

export function showLoading(message: string): void {
  console.log('Loading:', message);
}

export function hideLoading(): void {
  console.log('Loading hidden');
}

export function showSuccess(message: string): void {
  console.log('Success:', message);
}

export function showError(message: string): void {
  console.error('Error:', message);
  alert(message);
}

// ── Validation utilities ──────────────────────────────────────────────────────

export async function confirmAgentDelete(agentName: string): Promise<boolean> {
  const confirmed = await showConfirmDialog(
    '确认删除',
    `确定要删除 Agent "${agentName}" 吗？此操作不可恢复。`
  );
  return confirmed;
}

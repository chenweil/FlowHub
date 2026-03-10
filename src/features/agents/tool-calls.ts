// src/features/agents/tool-calls.ts — tool call management
import type { ToolCall } from '../../types';
import { state } from '../../store';
import { toolCallsListEl, toolCallsPanelEl } from '../../dom';
import { escapeHtml } from '../../lib/html';

// ── Tool call normalizers ─────────────────────────────────────────────────────

export function normalizeToolCallStatus(rawStatus: string | undefined): ToolCall['status'] {
  if (rawStatus === 'running' || rawStatus === 'completed' || rawStatus === 'error') {
    return rawStatus;
  }
  return 'running';
}

export function normalizeToolCallItem(raw: ToolCall): ToolCall {
  return {
    id: raw.id || `tc_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    name: raw.name || 'unknown',
    status: normalizeToolCallStatus(raw.status),
    arguments: raw.arguments,
    output: raw.output,
  };
}

// ── Tool call state management ────────────────────────────────────────────────

export function mergeToolCalls(agentId: string, incoming: ToolCall[]): void {
  const existing = state.toolCallsByAgent[agentId] || [];
  const normalizedIncoming = incoming.map(normalizeToolCallItem);

  const merged = [...existing];
  for (const incomingItem of normalizedIncoming) {
    const index = merged.findIndex((item) => item.id === incomingItem.id);
    if (index >= 0) {
      merged[index] = { ...merged[index], ...incomingItem };
    } else {
      merged.push(incomingItem);
    }
  }

  state.toolCallsByAgent[agentId] = merged;

  if (state.currentAgentId === agentId) {
    renderToolCallsForAgent(agentId);
  }
}

export function resetToolCallsForAgent(agentId: string): void {
  state.toolCallsByAgent[agentId] = [];
  if (state.currentAgentId === agentId) {
    renderToolCallsForAgent(agentId);
  }
}

export function openCurrentAgentToolCallsPanel(): void {
  renderToolCallsForAgent(state.currentAgentId || '');
  toolCallsPanelEl.classList.remove('hidden');
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderToolCallsForAgent(agentId: string): void {
  const calls = state.toolCallsByAgent[agentId] || [];
  if (calls.length === 0) {
    toolCallsListEl.innerHTML = '<div class="tool-calls-empty">暂无工具调用</div>';
    return;
  }

  toolCallsListEl.innerHTML = calls
    .map(
      (call) => `
        <div class="tool-call-item tool-call-${call.status}">
          <div class="tool-call-header">
            <span class="tool-call-name">${escapeHtml(call.name)}</span>
            <span class="tool-call-status">${escapeHtml(call.status)}</span>
          </div>
          ${call.arguments ? `<div class="tool-call-input"><pre>${escapeHtml(JSON.stringify(call.arguments, null, 2))}</pre></div>` : ''}
          ${call.output ? `<div class="tool-call-output"><pre>${escapeHtml(String(call.output))}</pre></div>` : ''}
        </div>
      `
    )
    .join('');
}

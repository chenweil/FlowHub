// src/features/agents/tool-calls.ts — tool call management
import type { ToolCall } from '../../types';
import { state } from '../../store';

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
    void renderToolCallsForAgent(agentId);
  }
}

export function resetToolCallsForAgent(agentId: string): void {
  state.toolCallsByAgent[agentId] = [];
  if (state.currentAgentId === agentId) {
    void renderToolCallsForAgent(agentId);
  }
}

export function openCurrentAgentToolCallsPanel(): void {
  void renderToolCallsForAgent(state.currentAgentId || '', true);
}

// ── Rendering ─────────────────────────────────────────────────────────────────

async function renderToolCallsForAgent(agentId: string, forceOpen = false): Promise<void> {
  const calls = state.toolCallsByAgent[agentId] || [];
  const { showToolCalls } = await import('../ui');
  showToolCalls(calls, { forceOpen });
}

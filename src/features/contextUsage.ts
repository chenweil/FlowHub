// src/features/contextUsage.ts — context usage progress bar display

import { state } from '../store';
import { calculateContextUsage } from '../lib/tokens';
import { getContextWindow } from '../lib/modelContext';
import {
  canCompressContext,
  getCompressionDisabledReason,
  hasConversationMessages,
} from '../lib/contextCompression';

const contextUsageWrapperEl = document.getElementById('context-usage-wrapper') as HTMLDivElement | null;
const contextUsageBarEl = document.getElementById('context-usage-bar') as HTMLDivElement | null;
const contextUsageFillEl = document.getElementById('context-usage-fill') as HTMLDivElement | null;
const contextUsageTextEl = document.getElementById('context-usage-text') as HTMLSpanElement | null;

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}K`;
  }
  return String(tokens);
}

/**
 * Update the context usage progress bar based on current messages and model.
 */
export function updateContextUsageDisplay(): void {
  if (!contextUsageWrapperEl || !contextUsageFillEl) return;

  const agent = state.currentAgentId
    ? state.agents.find((a) => a.id === state.currentAgentId)
    : null;

  if (!agent || !state.currentSessionId) {
    contextUsageWrapperEl.style.display = 'none';
    return;
  }

  // Only show when there are user/assistant messages (not just system messages)
  const hasConversation = hasConversationMessages(state.messages);
  if (!hasConversation) {
    contextUsageWrapperEl.style.display = 'none';
    return;
  }

  const contextWindow = getContextWindow(agent.selectedModel);
  const usage = calculateContextUsage(state.messages, contextWindow);
  const pct = Math.min(usage.percentage, 100);

  // Show wrapper
  contextUsageWrapperEl.style.display = '';

  // Update fill width
  contextUsageFillEl.style.width = `${pct}%`;

  // Color thresholds
  let colorClass: string;
  if (usage.percentage > 80) {
    colorClass = 'context-usage-danger';
  } else if (usage.percentage > 50) {
    colorClass = 'context-usage-warning';
  } else {
    colorClass = 'context-usage-ok';
  }

  contextUsageFillEl.className = `context-usage-fill ${colorClass}`;

  // Text label
  if (contextUsageTextEl) {
    contextUsageTextEl.textContent = `${Math.round(usage.percentage)}%`;
    contextUsageTextEl.className = `context-usage-text ${colorClass}`;
  }

  const isBusy = Boolean(state.currentAgentId && state.inflightSessionByAgent[state.currentAgentId]);
  const eligibilityInput = {
    agent,
    hasSession: Boolean(state.currentSessionId),
    isBusy,
    messages: state.messages,
  };
  const canCompress = canCompressContext(eligibilityInput);
  const disabledReason = getCompressionDisabledReason(eligibilityInput);

  contextUsageWrapperEl.classList.toggle('context-usage-disabled', !canCompress);
  contextUsageWrapperEl.setAttribute('aria-disabled', String(!canCompress));

  const baseTooltip = `上下文: ${formatTokenCount(usage.usedTokens)}/${formatTokenCount(usage.contextWindow)} (${Math.round(usage.percentage)}%, 估算)`;
  const tooltip = canCompress
    ? `${baseTooltip}，点击压缩`
    : disabledReason
      ? `${baseTooltip}，不可压缩：${disabledReason}`
      : baseTooltip;
  if (contextUsageBarEl) {
    contextUsageBarEl.title = tooltip;
  }
  contextUsageWrapperEl.title = tooltip;
}

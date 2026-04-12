import type { AgentActivity } from '../../types';

interface AgentActivityInput {
  timestamp: number;
  label: string;
  toolName?: string;
}

function formatElapsedSeconds(elapsedMs: number): number {
  return Math.max(0, Math.floor(elapsedMs / 1000));
}

function formatRecentActivity(elapsedMs: number): string {
  const seconds = formatElapsedSeconds(elapsedMs);
  if (seconds < 5) {
    return '刚刚有新动作';
  }
  return `${seconds}秒前有新动作`;
}

function appendDetailParts(activity: AgentActivity, parts: string[]): string[] {
  if (activity.label) {
    parts.push(`当前阶段：${activity.label}`);
  }
  if (activity.toolName) {
    parts.push(`最近工具：${activity.toolName}`);
  }
  return parts;
}

export function recordAgentActivity(
  previous: AgentActivity | undefined,
  input: AgentActivityInput
): AgentActivity {
  return {
    lastUpdatedAt: input.timestamp,
    label: input.label,
    toolName: input.toolName || previous?.toolName,
  };
}

export function buildBusyActivityHint(
  activity: AgentActivity | undefined,
  now: number,
  idleThresholdMs: number
): string {
  if (!activity) {
    return '正在执行中，等待新动作...';
  }

  const elapsedMs = Math.max(0, now - activity.lastUpdatedAt);
  const elapsedSeconds = formatElapsedSeconds(elapsedMs);
  if (elapsedMs >= idleThresholdMs) {
    const stalledParts = [`${elapsedSeconds}秒无新动作，可能卡住`];
    if (activity.toolName) {
      stalledParts.push(`最近工具：${activity.toolName}`);
    }
    return stalledParts.join(' · ');
  }

  return appendDetailParts(activity, ['正在执行中', formatRecentActivity(elapsedMs)]).join(' · ');
}

export function buildToolPanelActivitySummary(
  activity: AgentActivity | undefined,
  now: number,
  idleThresholdMs: number,
  isBusy = true
): string {
  if (!activity) {
    return '暂无最近活动';
  }

  const elapsedMs = Math.max(0, now - activity.lastUpdatedAt);
  const elapsedSeconds = formatElapsedSeconds(elapsedMs);

  if (!isBusy) {
    return appendDetailParts(activity, ['已结束', formatRecentActivity(elapsedMs)]).join(' · ');
  }

  if (elapsedMs >= idleThresholdMs) {
    return appendDetailParts(activity, ['疑似卡住', `${elapsedSeconds}秒无新动作`]).join(' · ');
  }

  return appendDetailParts(activity, ['活跃中', formatRecentActivity(elapsedMs)]).join(' · ');
}

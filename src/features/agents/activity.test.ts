import { describe, expect, it } from 'vitest';

import {
  buildBusyActivityHint,
  buildToolPanelActivitySummary,
  recordAgentActivity,
} from './activity';

describe('agent activity helpers', () => {
  it('builds active hint with current stage and recent tool', () => {
    const activity = recordAgentActivity(undefined, {
      timestamp: 10_000,
      label: '调用工具',
      toolName: 'read_file',
    });

    expect(buildBusyActivityHint(activity, 12_000, 120_000)).toBe(
      '正在执行中 · 刚刚有新动作 · 当前阶段：调用工具 · 最近工具：read_file'
    );
  });

  it('builds stalled hint after idle threshold', () => {
    const activity = recordAgentActivity(undefined, {
      timestamp: 10_000,
      label: '执行命令',
      toolName: 'run_shell_command',
    });

    expect(buildBusyActivityHint(activity, 140_000, 120_000)).toBe(
      '130秒无新动作，可能卡住 · 最近工具：run_shell_command'
    );
  });

  it('builds tool panel summary text', () => {
    const activity = recordAgentActivity(undefined, {
      timestamp: 10_000,
      label: '生成内容',
      toolName: 'agent',
    });

    expect(buildToolPanelActivitySummary(activity, 25_000, 120_000)).toBe(
      '活跃中 · 15秒前有新动作 · 当前阶段：生成内容 · 最近工具：agent'
    );
  });
});

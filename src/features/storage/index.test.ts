// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/tauri', () => ({
  loadStorageSnapshot: vi.fn(),
  saveStorageSnapshot: vi.fn(),
}));

import type { Session } from '../../types';
import { mergeLikelyDuplicateSessions } from './index';

function buildSession(overrides: Partial<Session>): Session {
  return {
    id: 'sess-default',
    agentId: 'agent-1',
    title: '默认会话',
    createdAt: new Date('2026-04-12T07:23:50.309Z'),
    updatedAt: new Date('2026-04-12T07:35:18.040Z'),
    acpSessionId: 'local-random-id',
    source: 'local',
    ...overrides,
  };
}

describe('mergeLikelyDuplicateSessions', () => {
  it('merges local/qwen-log pseudo duplicates into the local session', () => {
    const local = buildSession({
      id: 'sess-local',
      title: '默认会话',
      messageCountHint: 8,
    });
    const history = buildSession({
      id: 'iflowlog-agent-1-actual-id',
      title: '查看当前目录有什么文件',
      createdAt: new Date('2026-04-12T07:24:00.416Z'),
      acpSessionId: 'actual-id',
      source: 'qwen-log',
      messageCountHint: 8,
    });

    const result = mergeLikelyDuplicateSessions([local, history]);

    expect(result.removedSessionIds).toEqual(['iflowlog-agent-1-actual-id']);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].id).toBe('sess-local');
    expect(result.sessions[0].acpSessionId).toBe('actual-id');
    expect(result.sessions[0].title).toBe('查看当前目录有什么文件');
  });

  it('keeps distinct sessions when timestamps differ too much', () => {
    const local = buildSession({
      id: 'sess-local',
      title: '把内容写入文件',
      messageCountHint: 8,
    });
    const history = buildSession({
      id: 'iflowlog-agent-1-actual-id',
      title: '查看当前目录有什么文件',
      createdAt: new Date('2026-04-12T07:40:00.416Z'),
      updatedAt: new Date('2026-04-12T07:40:18.040Z'),
      acpSessionId: 'actual-id',
      source: 'qwen-log',
      messageCountHint: 8,
    });

    const result = mergeLikelyDuplicateSessions([local, history]);

    expect(result.removedSessionIds).toEqual([]);
    expect(result.sessions).toHaveLength(2);
  });
});

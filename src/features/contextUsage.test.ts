// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from 'vitest';

function setupDom() {
  document.body.innerHTML = `
    <div id="context-usage-wrapper" class="context-usage-wrapper" style="display:none">
      <div id="context-usage-bar" class="context-usage-bar">
        <div class="context-usage-fill" id="context-usage-fill"></div>
      </div>
      <span id="context-usage-text" class="context-usage-text"></span>
    </div>
  `;
}

describe('contextUsage disabled state', () => {
  beforeEach(async () => {
    vi.resetModules();
    setupDom();
  });

  it('marks wrapper as disabled when agent is busy', async () => {
    const { state } = await import('../store');
    const { updateContextUsageDisplay } = await import('./contextUsage');

    state.currentAgentId = 'agent-1';
    state.currentSessionId = 'session-1';
    state.sessionsByAgent = {
      'agent-1': [
        {
          id: 'session-1',
          agentId: 'agent-1',
          title: 'Session',
          createdAt: new Date(),
          updatedAt: new Date(),
          source: 'local',
        },
      ],
    };
    state.agents = [
      { id: 'agent-1', name: 'A', type: 'iflow', status: 'connected', workspacePath: '/tmp' },
    ];
    state.inflightSessionByAgent = { 'agent-1': 'session-1' };
    state.messages = [
      { id: 'm1', role: 'user', content: 'hi', timestamp: new Date() },
    ];

    updateContextUsageDisplay();

    const wrapper = document.getElementById('context-usage-wrapper');
    expect(wrapper?.classList.contains('context-usage-disabled')).toBe(true);
    expect(wrapper?.title).toContain('正在生成回复中');
  });

  it('keeps wrapper enabled when compression is allowed', async () => {
    const { state } = await import('../store');
    const { updateContextUsageDisplay } = await import('./contextUsage');

    state.currentAgentId = 'agent-1';
    state.currentSessionId = 'session-1';
    state.sessionsByAgent = {
      'agent-1': [
        {
          id: 'session-1',
          agentId: 'agent-1',
          title: 'Session',
          createdAt: new Date(),
          updatedAt: new Date(),
          source: 'local',
        },
      ],
    };
    state.agents = [
      { id: 'agent-1', name: 'A', type: 'iflow', status: 'connected', workspacePath: '/tmp' },
    ];
    state.inflightSessionByAgent = {};
    state.messages = [
      { id: 'm1', role: 'user', content: 'hi', timestamp: new Date() },
      { id: 'm2', role: 'assistant', content: 'ok', timestamp: new Date() },
    ];

    updateContextUsageDisplay();

    const wrapper = document.getElementById('context-usage-wrapper');
    expect(wrapper?.classList.contains('context-usage-disabled')).toBe(false);
  });

  it('marks wrapper as disabled when session is history', async () => {
    const { state } = await import('../store');
    const { updateContextUsageDisplay } = await import('./contextUsage');

    state.currentAgentId = 'agent-1';
    state.currentSessionId = 'session-1';
    state.sessionsByAgent = {
      'agent-1': [
        {
          id: 'session-1',
          agentId: 'agent-1',
          title: 'History',
          createdAt: new Date(),
          updatedAt: new Date(),
          source: 'iflow-log',
        },
      ],
    };
    state.agents = [
      { id: 'agent-1', name: 'A', type: 'iflow', status: 'connected', workspacePath: '/tmp' },
    ];
    state.inflightSessionByAgent = {};
    state.messages = [
      { id: 'm1', role: 'user', content: 'hi', timestamp: new Date() },
      { id: 'm2', role: 'assistant', content: 'ok', timestamp: new Date() },
    ];

    updateContextUsageDisplay();

    const wrapper = document.getElementById('context-usage-wrapper');
    expect(wrapper?.classList.contains('context-usage-disabled')).toBe(true);
    expect(wrapper?.title).toContain('历史会话不可压缩');
  });
});

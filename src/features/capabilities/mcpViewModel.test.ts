import { describe, expect, it } from 'vitest';
import type { Agent, AgentRegistry } from '../../types';
import { buildMcpCapabilityViewModel } from './mcpViewModel';
import { createEmptyCapabilityEnableMaps, setMcpSuggestionEnabled } from './enables';

describe('buildMcpCapabilityViewModel', () => {
  it('returns no-agent state when current agent is missing', () => {
    const viewModel = buildMcpCapabilityViewModel({
      currentAgentId: null,
      agents: [],
      registryByAgent: {},
      mcpEnabledByAgent: {},
    });

    expect(viewModel.state).toBe('no-agent');
    expect(viewModel.servers).toEqual([]);
  });

  it('returns ready state for connected agent with runtime MCP servers', () => {
    const agents: Agent[] = [
      {
        id: 'a-1',
        name: 'iFlow',
        type: 'iflow',
        status: 'connected',
        workspacePath: '/tmp/workspace',
      },
    ];
    const registryByAgent: Record<string, AgentRegistry> = {
      'a-1': {
        commands: [],
        mcpServers: [{ name: 'filesystem', description: '访问本地文件' }],
      },
    };

    const viewModel = buildMcpCapabilityViewModel({
      currentAgentId: 'a-1',
      agents,
      registryByAgent,
      mcpEnabledByAgent: {},
    });

    expect(viewModel.state).toBe('ready');
    expect(viewModel.servers).toHaveLength(1);
    expect(viewModel.isReadOnlySnapshot).toBe(false);
    expect(viewModel.servers[0]?.suggestionEnabled).toBe(true);
  });

  it('returns offline state and keeps last known MCP list when agent is offline', () => {
    const agents: Agent[] = [
      {
        id: 'a-1',
        name: 'iFlow',
        type: 'iflow',
        status: 'disconnected',
        workspacePath: '/tmp/workspace',
      },
    ];
    const registryByAgent: Record<string, AgentRegistry> = {
      'a-1': {
        commands: [],
        mcpServers: [{ name: 'github', description: 'GitHub MCP' }],
      },
    };

    const viewModel = buildMcpCapabilityViewModel({
      currentAgentId: 'a-1',
      agents,
      registryByAgent,
      mcpEnabledByAgent: {},
    });

    expect(viewModel.state).toBe('offline');
    expect(viewModel.servers).toHaveLength(1);
    expect(viewModel.isReadOnlySnapshot).toBe(true);
  });

  it('returns empty state for connected agent without MCP servers', () => {
    const agents: Agent[] = [
      {
        id: 'a-1',
        name: 'iFlow',
        type: 'iflow',
        status: 'connected',
        workspacePath: '/tmp/workspace',
      },
    ];

    const viewModel = buildMcpCapabilityViewModel({
      currentAgentId: 'a-1',
      agents,
      registryByAgent: {},
      mcpEnabledByAgent: {},
    });

    expect(viewModel.state).toBe('empty');
    expect(viewModel.servers).toEqual([]);
    expect(viewModel.isReadOnlySnapshot).toBe(false);
  });

  it('marks MCP suggestion as disabled when agent setting is false', () => {
    const agents: Agent[] = [
      {
        id: 'a-1',
        name: 'iFlow',
        type: 'iflow',
        status: 'connected',
        workspacePath: '/tmp/workspace',
      },
    ];
    const registryByAgent: Record<string, AgentRegistry> = {
      'a-1': {
        commands: [],
        mcpServers: [
          { name: 'GitHub', description: 'GitHub MCP' },
          { name: 'filesystem', description: 'FS MCP' },
        ],
      },
    };
    const maps = createEmptyCapabilityEnableMaps();
    maps.mcpEnabledByAgent = setMcpSuggestionEnabled(maps.mcpEnabledByAgent, 'a-1', 'github', false);

    const viewModel = buildMcpCapabilityViewModel({
      currentAgentId: 'a-1',
      agents,
      registryByAgent,
      mcpEnabledByAgent: maps.mcpEnabledByAgent,
    });

    expect(viewModel.servers).toEqual([
      { name: 'GitHub', description: 'GitHub MCP', suggestionEnabled: false },
      { name: 'filesystem', description: 'FS MCP', suggestionEnabled: true },
    ]);
  });
});

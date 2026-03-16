import type { Agent, AgentRegistry, RegistryMcpServer } from '../../types';
import { isMcpSuggestionEnabled, type CapabilityEnabledMap } from './enables';

export type McpCapabilityViewState = 'no-agent' | 'ready' | 'empty' | 'offline';
export interface McpCapabilityServerItem extends RegistryMcpServer {
  suggestionEnabled: boolean;
}

export interface McpCapabilityViewModel {
  state: McpCapabilityViewState;
  agentName: string;
  agentStatus: Agent['status'] | null;
  servers: McpCapabilityServerItem[];
  isReadOnlySnapshot: boolean;
}

interface BuildMcpCapabilityViewModelParams {
  currentAgentId: string | null;
  agents: Agent[];
  registryByAgent: Record<string, AgentRegistry>;
  mcpEnabledByAgent: CapabilityEnabledMap;
}

export function buildMcpCapabilityViewModel(
  params: BuildMcpCapabilityViewModelParams
): McpCapabilityViewModel {
  const { currentAgentId, agents, registryByAgent, mcpEnabledByAgent } = params;
  if (!currentAgentId) {
    return {
      state: 'no-agent',
      agentName: '未选择 Agent',
      agentStatus: null,
      servers: [],
      isReadOnlySnapshot: false,
    };
  }

  const agent = agents.find((item) => item.id === currentAgentId);
  const runtimeServers = (registryByAgent[currentAgentId]?.mcpServers || []).map((server) => ({
    ...server,
    suggestionEnabled: isMcpSuggestionEnabled(mcpEnabledByAgent, currentAgentId, server.name),
  }));
  const agentName = agent?.name || currentAgentId;
  const agentStatus = agent?.status || null;

  if (agentStatus && agentStatus !== 'connected') {
    return {
      state: 'offline',
      agentName,
      agentStatus,
      servers: runtimeServers,
      isReadOnlySnapshot: true,
    };
  }

  if (runtimeServers.length === 0) {
    return {
      state: 'empty',
      agentName,
      agentStatus,
      servers: [],
      isReadOnlySnapshot: false,
    };
  }

  return {
    state: 'ready',
    agentName,
    agentStatus,
    servers: runtimeServers,
    isReadOnlySnapshot: false,
  };
}

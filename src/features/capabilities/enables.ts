import type { RegistryMcpServer } from '../../types';

export const CAPABILITY_ENABLES_STORAGE_KEY = 'iflow-capability-enables-v1';

export type CapabilityEnabledMap = Record<string, Record<string, boolean>>;

export interface CapabilityEnableSettings {
  version: 1;
  mcpEnabledByAgent: CapabilityEnabledMap;
  skillEnabledByAgentType: CapabilityEnabledMap;
  updatedAt: number;
}

function normalizeCapabilityKey(value: string): string {
  return value.trim().toLowerCase();
}

function readObjectFromUnknown(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeEnabledMap(rawMap: unknown): CapabilityEnabledMap {
  const outerObj = readObjectFromUnknown(rawMap);
  if (!outerObj) {
    return {};
  }

  const normalized: CapabilityEnabledMap = {};
  for (const [outerKey, outerValue] of Object.entries(outerObj)) {
    const normalizedOuterKey = normalizeCapabilityKey(outerKey);
    if (!normalizedOuterKey) {
      continue;
    }

    const innerObj = readObjectFromUnknown(outerValue);
    if (!innerObj) {
      continue;
    }

    const innerNormalized: Record<string, boolean> = {};
    for (const [innerKey, innerValue] of Object.entries(innerObj)) {
      const normalizedInnerKey = normalizeCapabilityKey(innerKey);
      if (!normalizedInnerKey) {
        continue;
      }
      if (typeof innerValue === 'boolean') {
        innerNormalized[normalizedInnerKey] = innerValue;
      }
    }

    if (Object.keys(innerNormalized).length > 0) {
      normalized[normalizedOuterKey] = innerNormalized;
    }
  }

  return normalized;
}

export function createEmptyCapabilityEnableMaps(): Pick<
  CapabilityEnableSettings,
  'mcpEnabledByAgent' | 'skillEnabledByAgentType'
> {
  return {
    mcpEnabledByAgent: {},
    skillEnabledByAgentType: {},
  };
}

export function loadCapabilityEnableSettings(): CapabilityEnableSettings {
  const fallback: CapabilityEnableSettings = {
    version: 1,
    ...createEmptyCapabilityEnableMaps(),
    updatedAt: Date.now(),
  };

  try {
    const rawValue = localStorage.getItem(CAPABILITY_ENABLES_STORAGE_KEY);
    if (!rawValue) {
      return fallback;
    }

    const parsed = JSON.parse(rawValue) as Record<string, unknown>;
    const updatedAt =
      typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
        ? parsed.updatedAt
        : fallback.updatedAt;

    return {
      version: 1,
      mcpEnabledByAgent: normalizeEnabledMap(parsed.mcpEnabledByAgent),
      skillEnabledByAgentType: normalizeEnabledMap(parsed.skillEnabledByAgentType),
      updatedAt,
    };
  } catch {
    return fallback;
  }
}

export function persistCapabilityEnableSettings(settings: CapabilityEnableSettings): void {
  localStorage.setItem(CAPABILITY_ENABLES_STORAGE_KEY, JSON.stringify(settings));
}

export function isMcpSuggestionEnabled(
  mcpEnabledByAgent: CapabilityEnabledMap,
  agentId: string,
  serverName: string
): boolean {
  const normalizedAgentId = normalizeCapabilityKey(agentId);
  const normalizedServerName = normalizeCapabilityKey(serverName);
  if (!normalizedAgentId || !normalizedServerName) {
    return true;
  }

  const byAgent = mcpEnabledByAgent[normalizedAgentId];
  if (!byAgent) {
    return true;
  }

  const enabled = byAgent[normalizedServerName];
  return typeof enabled === 'boolean' ? enabled : true;
}

export function setMcpSuggestionEnabled(
  mcpEnabledByAgent: CapabilityEnabledMap,
  agentId: string,
  serverName: string,
  enabled: boolean
): CapabilityEnabledMap {
  const normalizedAgentId = normalizeCapabilityKey(agentId);
  const normalizedServerName = normalizeCapabilityKey(serverName);
  if (!normalizedAgentId || !normalizedServerName) {
    return mcpEnabledByAgent;
  }

  return {
    ...mcpEnabledByAgent,
    [normalizedAgentId]: {
      ...(mcpEnabledByAgent[normalizedAgentId] || {}),
      [normalizedServerName]: enabled,
    },
  };
}

export function isSkillSuggestionEnabled(
  skillEnabledByAgentType: CapabilityEnabledMap,
  agentType: string,
  skillName: string
): boolean {
  const normalizedAgentType = normalizeCapabilityKey(agentType);
  const normalizedSkillName = normalizeCapabilityKey(skillName);
  if (!normalizedAgentType || !normalizedSkillName) {
    return true;
  }

  const byAgentType = skillEnabledByAgentType[normalizedAgentType];
  if (!byAgentType) {
    return true;
  }

  const enabled = byAgentType[normalizedSkillName];
  return typeof enabled === 'boolean' ? enabled : true;
}

export function setSkillSuggestionEnabled(
  skillEnabledByAgentType: CapabilityEnabledMap,
  agentType: string,
  skillName: string,
  enabled: boolean
): CapabilityEnabledMap {
  const normalizedAgentType = normalizeCapabilityKey(agentType);
  const normalizedSkillName = normalizeCapabilityKey(skillName);
  if (!normalizedAgentType || !normalizedSkillName) {
    return skillEnabledByAgentType;
  }

  return {
    ...skillEnabledByAgentType,
    [normalizedAgentType]: {
      ...(skillEnabledByAgentType[normalizedAgentType] || {}),
      [normalizedSkillName]: enabled,
    },
  };
}

export function filterEnabledMcpServersForAgent(
  servers: RegistryMcpServer[],
  agentId: string,
  mcpEnabledByAgent: CapabilityEnabledMap
): RegistryMcpServer[] {
  return servers.filter((server) => isMcpSuggestionEnabled(mcpEnabledByAgent, agentId, server.name));
}

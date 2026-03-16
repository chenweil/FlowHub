import { beforeEach, describe, expect, it } from 'vitest';
import type { RegistryMcpServer } from '../../types';
import {
  CAPABILITY_ENABLES_STORAGE_KEY,
  createEmptyCapabilityEnableMaps,
  filterEnabledMcpServersForAgent,
  isSkillSuggestionEnabled,
  isMcpSuggestionEnabled,
  loadCapabilityEnableSettings,
  persistCapabilityEnableSettings,
  setSkillSuggestionEnabled,
  setMcpSuggestionEnabled,
} from './enables';

describe('capability enables', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('loads defaults when storage is empty', () => {
    const settings = loadCapabilityEnableSettings();
    expect(settings.version).toBe(1);
    expect(settings.mcpEnabledByAgent).toEqual({});
    expect(settings.skillEnabledByAgentType).toEqual({});
    expect(settings.updatedAt).toBeTypeOf('number');
  });

  it('falls back to defaults when storage is invalid json', () => {
    localStorage.setItem(CAPABILITY_ENABLES_STORAGE_KEY, '{not-json');
    const settings = loadCapabilityEnableSettings();
    expect(settings.mcpEnabledByAgent).toEqual({});
    expect(settings.skillEnabledByAgentType).toEqual({});
  });

  it('disables mcp suggestion by agent and server name (case-insensitive)', () => {
    let maps = createEmptyCapabilityEnableMaps();
    maps.mcpEnabledByAgent = setMcpSuggestionEnabled(
      maps.mcpEnabledByAgent,
      'Agent-A',
      'GitHub',
      false
    );

    expect(isMcpSuggestionEnabled(maps.mcpEnabledByAgent, 'agent-a', 'github')).toBe(false);
    expect(isMcpSuggestionEnabled(maps.mcpEnabledByAgent, 'agent-a', 'filesystem')).toBe(true);
    expect(isMcpSuggestionEnabled(maps.mcpEnabledByAgent, 'agent-b', 'github')).toBe(true);
  });

  it('persists and reloads capability enable settings', () => {
    const maps = createEmptyCapabilityEnableMaps();
    maps.mcpEnabledByAgent = setMcpSuggestionEnabled(maps.mcpEnabledByAgent, 'Agent-A', 'GitHub', false);
    maps.skillEnabledByAgentType.iflow = { summarize: true };

    persistCapabilityEnableSettings({
      version: 1,
      mcpEnabledByAgent: maps.mcpEnabledByAgent,
      skillEnabledByAgentType: maps.skillEnabledByAgentType,
      updatedAt: 123,
    });

    const reloaded = loadCapabilityEnableSettings();
    expect(reloaded.mcpEnabledByAgent['agent-a'].github).toBe(false);
    expect(reloaded.skillEnabledByAgentType.iflow.summarize).toBe(true);
    expect(reloaded.updatedAt).toBe(123);
  });

  it('filters disabled mcp suggestions for current agent', () => {
    const servers: RegistryMcpServer[] = [
      { name: 'GitHub', description: 'github mcp' },
      { name: 'filesystem', description: 'fs mcp' },
    ];

    const maps = createEmptyCapabilityEnableMaps();
    maps.mcpEnabledByAgent = setMcpSuggestionEnabled(maps.mcpEnabledByAgent, 'agent-a', 'GitHub', false);

    const filtered = filterEnabledMcpServersForAgent(servers, 'agent-a', maps.mcpEnabledByAgent);
    expect(filtered).toEqual([{ name: 'filesystem', description: 'fs mcp' }]);
  });

  it('disables skill suggestion by agent type and skill name (case-insensitive)', () => {
    let maps = createEmptyCapabilityEnableMaps();
    maps.skillEnabledByAgentType = setSkillSuggestionEnabled(
      maps.skillEnabledByAgentType,
      'IFLOW',
      'Daily-Plan',
      false
    );

    expect(isSkillSuggestionEnabled(maps.skillEnabledByAgentType, 'iflow', 'daily-plan')).toBe(false);
    expect(isSkillSuggestionEnabled(maps.skillEnabledByAgentType, 'iflow', 'summarize')).toBe(true);
    expect(isSkillSuggestionEnabled(maps.skillEnabledByAgentType, 'codex', 'daily-plan')).toBe(true);
  });
});

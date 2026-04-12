import { describe, expect, it } from 'vitest';
import type { SkillRuntimeItem } from '../../types';
import { createEmptyCapabilityEnableMaps, setSkillSuggestionEnabled } from './enables';
import { buildSkillCapabilityViewModel } from './skillViewModel';

describe('buildSkillCapabilityViewModel', () => {
  it('returns unsupported state for non-qwen agent type', () => {
    const viewModel = buildSkillCapabilityViewModel({
      agentType: 'codex',
      skillRuntimeByAgentType: {},
      skillEnabledByAgentType: {},
      loading: false,
      errorMessage: '',
    });

    expect(viewModel.state).toBe('unsupported');
    expect(viewModel.skills).toEqual([]);
  });

  it('returns loading state', () => {
    const viewModel = buildSkillCapabilityViewModel({
      agentType: 'qwen',
      skillRuntimeByAgentType: {},
      skillEnabledByAgentType: {},
      loading: true,
      errorMessage: '',
    });

    expect(viewModel.state).toBe('loading');
  });

  it('returns error state', () => {
    const viewModel = buildSkillCapabilityViewModel({
      agentType: 'qwen',
      skillRuntimeByAgentType: {},
      skillEnabledByAgentType: {},
      loading: false,
      errorMessage: '无法访问目录',
    });

    expect(viewModel.state).toBe('error');
    expect(viewModel.errorMessage).toBe('无法访问目录');
  });

  it('maps runtime skills and enabled state', () => {
    const runtimeSkills: SkillRuntimeItem[] = [
      {
        agentType: 'qwen',
        skillName: 'daily-plan',
        title: 'Daily Plan',
        description: '生成每日计划',
        path: '/Users/demo/.qwen/skills/daily-plan',
        source: 'qwen-cli-dir',
        discoveredAt: 100,
      },
      {
        agentType: 'qwen',
        skillName: 'summarize',
        title: 'Summarize',
        description: '总结长文本',
        path: '/Users/demo/.qwen/skills/summarize',
        source: 'qwen-cli-dir',
        discoveredAt: 101,
      },
    ];
    const maps = createEmptyCapabilityEnableMaps();
    maps.skillEnabledByAgentType = setSkillSuggestionEnabled(
      maps.skillEnabledByAgentType,
      'qwen',
      'daily-plan',
      false
    );

    const viewModel = buildSkillCapabilityViewModel({
      agentType: 'qwen',
      skillRuntimeByAgentType: { qwen: runtimeSkills },
      skillEnabledByAgentType: maps.skillEnabledByAgentType,
      loading: false,
      errorMessage: '',
    });

    expect(viewModel.state).toBe('ready');
    expect(viewModel.skills).toEqual([
      {
        ...runtimeSkills[0],
        suggestionEnabled: false,
      },
      {
        ...runtimeSkills[1],
        suggestionEnabled: true,
      },
    ]);
  });
});

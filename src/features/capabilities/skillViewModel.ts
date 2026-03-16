import type { SkillRuntimeItem } from '../../types';
import { isSkillSuggestionEnabled, type CapabilityEnabledMap } from './enables';

export type SkillCapabilityViewState = 'unsupported' | 'loading' | 'error' | 'empty' | 'ready';

export interface SkillCapabilityViewItem extends SkillRuntimeItem {
  suggestionEnabled: boolean;
}

export interface SkillCapabilityViewModel {
  state: SkillCapabilityViewState;
  errorMessage: string;
  skills: SkillCapabilityViewItem[];
}

interface BuildSkillCapabilityViewModelParams {
  agentType: string;
  skillRuntimeByAgentType: Record<string, SkillRuntimeItem[]>;
  skillEnabledByAgentType: CapabilityEnabledMap;
  loading: boolean;
  errorMessage: string;
}

function normalizeAgentType(value: string): string {
  return value.trim().toLowerCase();
}

export function buildSkillCapabilityViewModel(
  params: BuildSkillCapabilityViewModelParams
): SkillCapabilityViewModel {
  const agentType = normalizeAgentType(params.agentType);
  if (agentType !== 'iflow') {
    return {
      state: 'unsupported',
      errorMessage: '',
      skills: [],
    };
  }

  if (params.loading) {
    return {
      state: 'loading',
      errorMessage: '',
      skills: [],
    };
  }

  if (params.errorMessage) {
    return {
      state: 'error',
      errorMessage: params.errorMessage,
      skills: [],
    };
  }

  const runtimeSkills = params.skillRuntimeByAgentType[agentType] || [];
  const skills = runtimeSkills.map((skill) => ({
    ...skill,
    suggestionEnabled: isSkillSuggestionEnabled(
      params.skillEnabledByAgentType,
      agentType,
      skill.skillName
    ),
  }));

  if (skills.length === 0) {
    return {
      state: 'empty',
      errorMessage: '',
      skills: [],
    };
  }

  return {
    state: 'ready',
    errorMessage: '',
    skills,
  };
}

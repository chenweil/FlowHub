import { describe, expect, it, vi } from 'vitest';

vi.mock('../../dom', () => ({
  currentAgentStatusEl: {} as HTMLSpanElement,
  currentAgentModelBtnEl: {} as HTMLButtonElement,
  currentAgentModelTextEl: {} as HTMLSpanElement,
  currentAgentModelMenuEl: {} as HTMLDivElement,
  toggleThinkBtnEl: {} as HTMLButtonElement,
  connectionStatusEl: {} as HTMLDivElement,
}));

vi.mock('./actions', () => ({
  renderAgentList: () => {},
  saveAgents: async () => {},
}));

vi.mock('./ui', () => ({
  updateCurrentAgentModelUI: () => {},
  updateCurrentAgentThinkUI: () => {},
  updateAgentStatusUI: () => {},
  renderCurrentAgentModelMenu: () => {},
  closeCurrentAgentModelMenu: () => {},
  currentAgentModelLabel: () => '',
}));

vi.mock('../../services/tauri', () => ({
  switchQwenModel: async () => ({ success: true }),
  toggleAgentThink: async () => true,
}));

import { normalizeModelOption } from './model';

describe('normalizeModelOption', () => {
  it('rejects invalid records', () => {
    expect(normalizeModelOption(null)).toBeNull();
    expect(normalizeModelOption({})).toBeNull();
  });

  it('uses value as label when label missing', () => {
    expect(normalizeModelOption({ value: 'gpt-4' })).toEqual({ value: 'gpt-4', label: 'gpt-4' });
  });

  it('trims value/label', () => {
    expect(normalizeModelOption({ value: '  gpt-4  ', label: '  GPT 4  ' }))
      .toEqual({ value: 'gpt-4', label: 'GPT 4' });
  });

  it('supports non-string payloads via text normalization', () => {
    expect(normalizeModelOption({ value: { text: 'gpt-4' }, label: { text: 'GPT 4' } }))
      .toEqual({ value: 'gpt-4', label: 'GPT 4' });
  });
});

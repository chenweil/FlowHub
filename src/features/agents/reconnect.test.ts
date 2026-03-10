import { describe, expect, it, vi } from 'vitest';

vi.mock('../../dom', () => ({
  showConfirmDialog: async () => true,
}));
import { normalizeAutoReconnectMode, AUTO_RECONNECT_MODE_DEFAULT } from './reconnect';

describe('normalizeAutoReconnectMode', () => {
  it('returns default for empty', () => {
    expect(normalizeAutoReconnectMode('')).toBe(AUTO_RECONNECT_MODE_DEFAULT);
  });

  it('accepts valid modes', () => {
    expect(normalizeAutoReconnectMode('all')).toBe('all');
    expect(normalizeAutoReconnectMode('last')).toBe('last');
    expect(normalizeAutoReconnectMode('off')).toBe('off');
  });

  it('trims and lowercases', () => {
    expect(normalizeAutoReconnectMode('  LAST ')).toBe('last');
  });
});

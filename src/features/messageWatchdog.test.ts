import { describe, expect, it, vi } from 'vitest';
import type { MessageWatchdogState, MessageWatchdogRuntime } from './messageWatchdog';
import { clearMessageWatchdog, resetMessageWatchdog } from './messageWatchdog';

function createState(): MessageWatchdogState {
  return {
    inflightSessionByAgent: {},
    messageTimeout: null,
  };
}

describe('messageWatchdog', () => {
  it('clearMessageWatchdog does nothing when no timer exists', () => {
    const state = createState();
    const runtime: MessageWatchdogRuntime = {
      schedule: vi.fn(() => 1),
      cancel: vi.fn(),
    };

    clearMessageWatchdog(state, runtime);

    expect(runtime.cancel).not.toHaveBeenCalled();
    expect(state.messageTimeout).toBeNull();
  });

  it('resetMessageWatchdog cancels previous timer and starts a new one', () => {
    const state = createState();
    state.inflightSessionByAgent.agent1 = 'session-1';
    state.messageTimeout = 11;

    let callback: () => void = () => {};
    const schedule = vi.fn((cb: () => void) => {
      callback = cb;
      return 22;
    });
    const runtime: MessageWatchdogRuntime = {
      schedule,
      cancel: vi.fn(),
    };
    const onTimeout = vi.fn();

    resetMessageWatchdog(state, 'agent1', 'session-1', 1234, onTimeout, runtime);
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 1234);
    expect(runtime.cancel).toHaveBeenCalledWith(11);
    expect(state.messageTimeout).toBe(22);

    callback();
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it('resetMessageWatchdog ignores stale timer callback when inflight session changed', () => {
    const state = createState();
    state.inflightSessionByAgent.agent1 = 'session-1';

    let callback: () => void = () => {};
    const schedule = vi.fn((cb: () => void) => {
      callback = cb;
      return 33;
    });
    const runtime: MessageWatchdogRuntime = {
      schedule,
      cancel: vi.fn(),
    };
    const onTimeout = vi.fn();

    resetMessageWatchdog(state, 'agent1', 'session-1', 2000, onTimeout, runtime);
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 2000);
    state.inflightSessionByAgent.agent1 = 'session-2';

    callback();
    expect(onTimeout).not.toHaveBeenCalled();
  });
});

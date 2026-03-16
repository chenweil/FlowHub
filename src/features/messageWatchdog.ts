export interface MessageWatchdogState {
  inflightSessionByAgent: Record<string, string>;
  messageTimeout: number | null;
}

export interface MessageWatchdogRuntime {
  schedule: (callback: () => void, delayMs: number) => number;
  cancel: (timerId: number) => void;
}

const browserRuntime: MessageWatchdogRuntime = {
  schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
  cancel: (timerId) => window.clearTimeout(timerId),
};

export function clearMessageWatchdog(
  state: MessageWatchdogState,
  runtime: MessageWatchdogRuntime = browserRuntime
): void {
  if (state.messageTimeout === null) {
    return;
  }
  runtime.cancel(state.messageTimeout);
  state.messageTimeout = null;
}

export function resetMessageWatchdog(
  state: MessageWatchdogState,
  agentId: string,
  sessionId: string,
  timeoutMs: number,
  onTimeout: () => void,
  runtime: MessageWatchdogRuntime = browserRuntime
): void {
  clearMessageWatchdog(state, runtime);
  state.messageTimeout = runtime.schedule(() => {
    if (state.inflightSessionByAgent[agentId] !== sessionId) {
      return;
    }
    onTimeout();
  }, timeoutMs);
}

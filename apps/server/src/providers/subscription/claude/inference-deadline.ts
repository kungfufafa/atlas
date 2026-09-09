export interface ClaudeInferenceClock {
  now(): number;
  schedule(callback: () => void, milliseconds: number): () => void;
}

const systemClock: ClaudeInferenceClock = {
  now: () => Date.now(),
  schedule(callback, milliseconds) {
    const timeout = setTimeout(callback, milliseconds);
    return () => clearTimeout(timeout);
  },
};

/** Counts native inference time while excluding Atlas host work and approvals. */
export function createClaudeInferenceDeadline(
  timeoutMs: number,
  signal: AbortSignal,
  onTimeout: () => void,
  clock: ClaudeInferenceClock = systemClock
) {
  let remainingMs = timeoutMs;
  let startedAt = 0;
  let pendingTools = 0;
  let active = false;
  let cancelTimeout: (() => void) | undefined;

  const arm = () => {
    if (!active || signal.aborted || pendingTools > 0) {
      return;
    }
    startedAt = clock.now();
    cancelTimeout = clock.schedule(onTimeout, remainingMs);
  };
  return {
    async duringHostExecution<T>(execute: () => Promise<T>): Promise<T> {
      if (pendingTools === 0 && cancelTimeout !== undefined) {
        cancelTimeout();
        cancelTimeout = undefined;
        remainingMs = Math.max(0, remainingMs - (clock.now() - startedAt));
      }
      pendingTools++;
      try {
        return await execute();
      } finally {
        pendingTools--;
        if (pendingTools === 0) {
          arm();
        }
      }
    },
    start() {
      active = true;
      arm();
    },
    stop() {
      active = false;
      cancelTimeout?.();
      cancelTimeout = undefined;
    },
  };
}

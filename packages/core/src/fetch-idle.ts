/**
 * Bun fetch `idleTimeout` is in seconds (max 255). Long LLM completions and
 * automation HTTP waits can sit quiet longer than the default (10s), which
 * surfaces as "The socket connection was closed unexpectedly".
 */
export const BUN_FETCH_DISABLE_IDLE_TIMEOUT_S = 0;

/** Hard cap for one outbound LLM HTTP call after idle timeout is disabled. */
export const LLM_FETCH_TIMEOUT_MS = 600_000;

export type BunFetchInit = RequestInit & { idleTimeout?: number };

export type TimeoutAbortSignal = {
  dispose: () => void;
  signal: AbortSignal;
};

function timeoutAbortReason(): DOMException {
  return new DOMException("The operation timed out.", "TimeoutError");
}

/**
 * Deadline signal that can be cleared when the request finishes.
 * `AbortSignal.timeout()` leaves a timer that keeps `bun test` (and idle
 * processes) alive for the full duration after the caller has returned.
 */
export function createTimeoutAbortSignal(
  timeoutMs: number
): TimeoutAbortSignal {
  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) {
      controller.abort(timeoutAbortReason());
    }
  };

  const timer = setTimeout(abort, Math.max(0, timeoutMs));
  timer.unref();
  return {
    dispose: () => clearTimeout(timer),
    signal: controller.signal,
  };
}

export function withDisabledFetchIdle(init?: RequestInit): BunFetchInit {
  return { ...init, idleTimeout: BUN_FETCH_DISABLE_IDLE_TIMEOUT_S };
}

export function withLlmFetchDeadline(init?: RequestInit): BunFetchInit {
  const timeout = createTimeoutAbortSignal(LLM_FETCH_TIMEOUT_MS);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeout.signal])
    : timeout.signal;

  return withDisabledFetchIdle({ ...init, signal });
}

export function fetchWithoutIdleTimeout(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const timeout = createTimeoutAbortSignal(LLM_FETCH_TIMEOUT_MS);
  const signal = init?.signal
    ? AbortSignal.any([init.signal, timeout.signal])
    : timeout.signal;

  return fetch(input, withDisabledFetchIdle({ ...init, signal })).finally(() =>
    timeout.dispose()
  );
}

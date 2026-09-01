export const DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS = 15_000;
export const DEFAULT_DOWNLOAD_OVERALL_TIMEOUT_MS = 60_000;

export class DownloadTimeoutError extends Error {
  readonly kind: "idle" | "overall";

  constructor(kind: "idle" | "overall") {
    super(
      kind === "idle"
        ? "Download stalled before it completed."
        : "Download did not complete in time."
    );
    this.kind = kind;
    this.name = "DownloadTimeoutError";
  }
}

export class EmptyDownloadError extends Error {
  constructor() {
    super("Downloaded file is empty.");
    this.name = "EmptyDownloadError";
  }
}

export interface DownloadDeadline {
  dispose(): void;
  resetIdle(): void;
  signal: AbortSignal;
  throwIfAborted(): void;
}

export function createDownloadDeadline(options?: {
  idleTimeoutMs?: number;
  overallTimeoutMs?: number;
  signal?: AbortSignal;
}): DownloadDeadline {
  const controller = new AbortController();
  const idleTimeoutMs =
    options?.idleTimeoutMs ?? DEFAULT_DOWNLOAD_IDLE_TIMEOUT_MS;
  const overallTimeoutMs =
    options?.overallTimeoutMs ?? DEFAULT_DOWNLOAD_OVERALL_TIMEOUT_MS;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let overallTimer: ReturnType<typeof setTimeout> | undefined;

  const abort = (reason: unknown): void => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };
  const abortFromParent = (): void => {
    abort(
      options?.signal?.reason ??
        new DOMException("The operation was aborted.", "AbortError")
    );
  };

  if (options?.signal?.aborted) {
    abortFromParent();
  } else {
    options?.signal?.addEventListener("abort", abortFromParent, { once: true });
  }

  if (overallTimeoutMs > 0 && !controller.signal.aborted) {
    overallTimer = setTimeout(() => {
      abort(new DownloadTimeoutError("overall"));
    }, overallTimeoutMs);
  }

  const dispose = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    if (overallTimer) {
      clearTimeout(overallTimer);
      overallTimer = undefined;
    }
    options?.signal?.removeEventListener("abort", abortFromParent);
  };

  return {
    dispose,
    resetIdle(): void {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
      if (idleTimeoutMs > 0 && !controller.signal.aborted) {
        idleTimer = setTimeout(() => {
          abort(new DownloadTimeoutError("idle"));
        }, idleTimeoutMs);
      }
    },
    signal: controller.signal,
    throwIfAborted(): void {
      throwIfSignalAborted(controller.signal);
    },
  };
}

export async function waitForAbortable<T>(
  promise: Promise<T>,
  signal: AbortSignal
): Promise<T> {
  throwIfSignalAborted(signal);

  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

export function throwIfSignalAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortReason(signal);
  }
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new DOMException("The operation was aborted.", "AbortError")
  );
}

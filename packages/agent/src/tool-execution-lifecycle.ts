import type { ToolCall, ToolContext, ToolExecutionResult } from "@atlas/core";

/** Held by the trusted host, separately from the context passed to a tool. */
export interface ToolInvocationLifecycle {
  complete(result: ToolExecutionResult<unknown>): Promise<void>;
  publisher?: ToolContext["artifactPublisher"];
}

export interface ToolExecutionLifecycle {
  begin(
    call: Readonly<ToolCall>,
    context: Readonly<ToolContext>
  ): ToolInvocationLifecycle | Promise<ToolInvocationLifecycle>;
  /** Diagnostics must not replace an execution result or cause producer replay. */
  onError?(error: unknown, phase: "begin" | "complete"): void | Promise<void>;
}

export function reportToolLifecycleError(
  lifecycle: ToolExecutionLifecycle,
  error: unknown,
  phase: "begin" | "complete"
): void {
  try {
    Promise.resolve(lifecycle.onError?.(error, phase)).catch(() => {
      // Asynchronous diagnostic failures are isolated too.
    });
  } catch {
    // A diagnostic failure cannot erase an actual tool effect or its receipt.
  }
}

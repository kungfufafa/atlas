import type { ChatCompletionResult } from "./contract";

/** Diagnostic fragments only: these are never executable ToolCalls. */
export interface IncompleteCompletionEvidence {
  content: string;
  thinking?: string;
  toolInputFragments: { id?: string; name?: string; arguments: string }[];
  usage?: ChatCompletionResult["usage"];
}

/** Explicit output-limit evidence, including any subsequent stream failure. */
export class IncompleteCompletionError extends Error {
  readonly reason = "output_limit";
  readonly finishReason = "length";
  readonly recoveryAllowed: boolean;

  constructor(
    label: string,
    readonly evidence: IncompleteCompletionEvidence,
    options?: { cause?: unknown; recoveryAllowed?: boolean }
  ) {
    super(`${label} stopped before completing the response (length).`, options);
    this.recoveryAllowed = options?.recoveryAllowed ?? true;
    this.name = "IncompleteCompletionError";
  }
}

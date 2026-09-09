import type { CodexTurnInput } from "./app-server";

// Transport limit in the pinned Codex 0.150.1 user_input/turn-start protocol.
// It counts Unicode scalar values across ALL text items, independently of the
// selected model's context window. Splitting turn/start items cannot avoid it.
export const MAX_CODEX_TURN_TEXT_CHARS = 1_048_576;
export function codexTurnTextChars(input: CodexTurnInput[] | string): number {
  const parts = typeof input === "string" ? [input] : input;
  let count = 0;
  for (const part of parts) {
    const text =
      typeof part === "string" ? part : part.type === "text" ? part.text : "";
    for (const _character of text) {
      count += 1;
    }
  }
  return count;
}

export class CodexTurnInputTooLargeError extends Error {
  readonly code = "input_too_large";
  readonly maxChars = MAX_CODEX_TURN_TEXT_CHARS;

  constructor(readonly actualChars: number) {
    super(
      `Codex turn input has ${actualChars} text characters; its transport limit is ${MAX_CODEX_TURN_TEXT_CHARS}. Use the bounded conversation source before starting the turn.`
    );
    this.name = "CodexTurnInputTooLargeError";
  }
}

export function assertCodexTurnInputSize(
  input: CodexTurnInput[] | string
): void {
  const chars = codexTurnTextChars(input);
  if (chars > MAX_CODEX_TURN_TEXT_CHARS) {
    throw new CodexTurnInputTooLargeError(chars);
  }
}

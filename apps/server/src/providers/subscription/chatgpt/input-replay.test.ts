import { expect, test } from "bun:test";
import type { CodexTurnInput } from "./app-server";
import {
  assertCodexTurnInputSize,
  CodexTurnInputTooLargeError,
  codexTurnTextChars,
  MAX_CODEX_TURN_TEXT_CHARS,
} from "./input-replay";

function textInput(text: string): CodexTurnInput {
  return { text, text_elements: [], type: "text" };
}

test("counts Unicode scalars and accepts exactly the aggregate transport limit", () => {
  const input = [
    textInput("a".repeat(MAX_CODEX_TURN_TEXT_CHARS - 1)),
    textInput("😀"),
  ];
  expect(codexTurnTextChars(input)).toBe(MAX_CODEX_TURN_TEXT_CHARS);
  expect(() => assertCodexTurnInputSize(input)).not.toThrow();
  expect(codexTurnTextChars("a😀é")).toBe(3);
  input.push(textInput("z"));
  expect(() => assertCodexTurnInputSize(input)).toThrow(
    CodexTurnInputTooLargeError
  );
});

test("separate below-limit text items can still exceed the turn limit", () => {
  const part = "x".repeat(MAX_CODEX_TURN_TEXT_CHARS / 2 + 1);
  expect(() => assertCodexTurnInputSize(part)).not.toThrow();
  const input = [textInput(part), textInput(part)];
  expect(codexTurnTextChars(input)).toBe(MAX_CODEX_TURN_TEXT_CHARS + 2);
  try {
    assertCodexTurnInputSize(input);
    throw new Error("Expected the aggregate input to be rejected.");
  } catch (error) {
    expect(error).toBeInstanceOf(CodexTurnInputTooLargeError);
    expect(error).toMatchObject({
      actualChars: MAX_CODEX_TURN_TEXT_CHARS + 2,
      code: "input_too_large",
      maxChars: MAX_CODEX_TURN_TEXT_CHARS,
    });
  }
});

test("image URLs do not consume the native text-character budget", () => {
  const input: CodexTurnInput[] = [
    textInput("Inspect"),
    {
      type: "image",
      url: `data:image/png;base64,${"A".repeat(MAX_CODEX_TURN_TEXT_CHARS + 1)}`,
    },
  ];
  expect(codexTurnTextChars(input)).toBe(7);
  expect(() => assertCodexTurnInputSize(input)).not.toThrow();
});

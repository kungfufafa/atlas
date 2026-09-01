import { describe, expect, test } from "bun:test";
import {
  clearActiveStream,
  registerActiveStream,
  resetActiveStreamsForTests,
  stopActiveStream,
} from "./active-stream";

describe("WhatsApp active stream ownership", () => {
  test("an older operation cannot clear its replacement", () => {
    resetActiveStreamsForTests();
    const first = registerActiveStream("chat");
    const second = registerActiveStream("chat");

    expect(first.aborted).toBe(true);
    clearActiveStream("chat", first);
    expect(stopActiveStream("chat")).toBe(true);

    clearActiveStream("chat", second);
    expect(stopActiveStream("chat")).toBe(false);
  });
});

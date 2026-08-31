import { afterEach, describe, expect, test } from "bun:test";
import {
  resetChatLocksForTests,
  seedChatLockForTests,
  withChatLock,
} from "./chat-handler";

afterEach(() => {
  resetChatLocksForTests();
});

describe("Telegram chat lock", () => {
  test("continues safely after a rejected predecessor", async () => {
    seedChatLockForTests("chat-1", Promise.reject(new Error("prior failed")));
    let called = false;

    await withChatLock("chat-1", async () => {
      called = true;
    });

    expect(called).toBe(true);
  });
});

import { expect, test } from "bun:test";
import { settledSessionIdToPersist } from "@/features/chat/chat-navigation";

test("keeps a newly created chat mounted while its first turn is streaming", () => {
  expect(
    settledSessionIdToPersist({
      activeSessionId: "created-session",
      currentSessionId: undefined,
      isSending: true,
    })
  ).toBeNull();
});

test("persists the created session after its first turn settles", () => {
  expect(
    settledSessionIdToPersist({
      activeSessionId: "created-session",
      currentSessionId: undefined,
      isSending: false,
    })
  ).toBe("created-session");
});

test("does not persist a session id already present in route state", () => {
  expect(
    settledSessionIdToPersist({
      activeSessionId: "current-session",
      currentSessionId: "current-session",
      isSending: false,
    })
  ).toBeNull();
});

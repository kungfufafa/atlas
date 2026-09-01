import { expect, test } from "bun:test";
import { nextSessionIdForNavigation } from "@/features/chat/chat-navigation";

test("keeps a newly created chat mounted while its first turn is streaming", () => {
  expect(
    nextSessionIdForNavigation({
      activeSessionId: "created-session",
      currentSessionId: undefined,
      isSending: true,
    })
  ).toBeNull();
});

test("opens the created session after its first turn settles", () => {
  expect(
    nextSessionIdForNavigation({
      activeSessionId: "created-session",
      currentSessionId: undefined,
      isSending: false,
    })
  ).toBe("created-session");
});

test("does not replace a route that already shows the active session", () => {
  expect(
    nextSessionIdForNavigation({
      activeSessionId: "current-session",
      currentSessionId: "current-session",
      isSending: false,
    })
  ).toBeNull();
});

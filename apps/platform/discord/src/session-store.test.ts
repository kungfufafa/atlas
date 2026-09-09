import { describe, expect, test } from "bun:test";
import { SessionStore } from "./session-store";

describe("Discord SessionStore hot session cache", () => {
  test("invalidates wrappers when the persisted session changes or is deleted", () => {
    const store = new SessionStore("unused");
    store.set("chat-1", {
      profileId: "default",
      sessionId: "session-a",
      updatedAt: "2026-08-31T00:00:00.000Z",
    });
    store.setHotSession("chat-1", { id: "session-a" });
    expect(store.getHotSession<{ id: string }>("chat-1")).toEqual({
      id: "session-a",
    });

    store.set("chat-1", {
      profileId: "default",
      sessionId: "session-b",
      updatedAt: "2026-08-31T00:01:00.000Z",
    });
    expect(store.getHotSession<{ id: string }>("chat-1")).toBeUndefined();

    store.setHotSession("chat-1", { id: "session-b" });
    store.delete("chat-1");
    expect(store.getHotSession<{ id: string }>("chat-1")).toBeUndefined();
  });
});

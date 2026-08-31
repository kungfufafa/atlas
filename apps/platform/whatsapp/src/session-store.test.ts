import { describe, expect, test } from "bun:test";
import { SessionStore } from "./session-store";

describe("WhatsApp SessionStore hot session cache", () => {
  test("normalizes keys and invalidates wrappers on replacement or deletion", () => {
    const store = new SessionStore("unused");
    const deviceJid = "628123:7@s.whatsapp.net";
    const canonicalJid = "628123@s.whatsapp.net";
    store.set(deviceJid, {
      profileId: "default",
      sessionId: "session-a",
      updatedAt: "2026-08-31T00:00:00.000Z",
    });
    store.setHotSession(deviceJid, { id: "session-a" });
    expect(store.getHotSession(canonicalJid)).toEqual({ id: "session-a" });

    store.set(canonicalJid, {
      profileId: "default",
      sessionId: "session-b",
      updatedAt: "2026-08-31T00:01:00.000Z",
    });
    expect(store.getHotSession(deviceJid)).toBeUndefined();

    store.setHotSession(canonicalJid, { id: "session-b" });
    store.delete(deviceJid);
    expect(store.getHotSession(canonicalJid)).toBeUndefined();
  });
});

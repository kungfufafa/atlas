import { describe, expect, spyOn, test } from "bun:test";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveWhatsAppSessionKey } from "./chat-handler";
import { SessionStore } from "./session-store";

const CHANNEL_USER_ID = "628111111111@s.whatsapp.net";

describe("SessionStore", () => {
  test("isolates hot sessions by group and sender and clears only revoked identities", () => {
    const store = new SessionStore("unused");
    const otherSender = "628222222222@s.whatsapp.net";
    const keys = [
      resolveWhatsAppSessionKey("120363042000000000@g.us", CHANNEL_USER_ID),
      resolveWhatsAppSessionKey("120363042000000000@g.us", otherSender),
      resolveWhatsAppSessionKey("120363043000000000@g.us", CHANNEL_USER_ID),
    ];
    for (const [index, key] of keys.entries()) {
      store.set(key, {
        ...sessionRecord(`session_${index}`),
        channelUserId: index === 1 ? otherSender : CHANNEL_USER_ID,
      });
      store.setHotSession(key, { id: `session_${index}` });
    }
    expect(keys.map((key) => store.getHotSession(key))).toEqual([
      { id: "session_0" },
      { id: "session_1" },
      { id: "session_2" },
    ]);
    expect(store.deleteByChannelUserId(CHANNEL_USER_ID)).toEqual([
      keys[0]!,
      keys[2]!,
    ]);
    expect(keys.map((key) => store.getHotSession(key))).toEqual([
      undefined,
      { id: "session_1" },
      undefined,
    ]);
  });

  test("normalizes keys and invalidates hot wrappers on replacement or deletion", () => {
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

  test("serializes atomic snapshots with private permissions", async () => {
    await withTempSessionPath(async (sessionPath) => {
      const store = new SessionStore(sessionPath);
      store.set(CHANNEL_USER_ID, sessionRecord("session_direct"));
      const firstSave = store.save();

      store.set(
        `group:120363042000000000@g.us:${CHANNEL_USER_ID}`,
        sessionRecord("session_group")
      );
      const secondSave = store.save();
      await Promise.all([firstSave, secondSave]);

      const persisted = JSON.parse(
        await readFile(sessionPath, "utf8")
      ) as Record<string, { sessionId: string }>;
      expect(persisted[CHANNEL_USER_ID]?.sessionId).toBe("session_direct");
      expect(
        persisted[`group:120363042000000000@g.us:${CHANNEL_USER_ID}`]?.sessionId
      ).toBe("session_group");
      expect((await stat(sessionPath)).mode % 0o1000).toBe(0o600);
      expect(
        (await readdir(path.dirname(sessionPath))).some((entry) =>
          entry.endsWith(".tmp")
        )
      ).toBe(false);
    });
  });

  test("quarantines corrupt JSON and starts with an empty cache", async () => {
    await withTempSessionPath(async (sessionPath) => {
      await writeFile(sessionPath, "{not valid json", {
        encoding: "utf8",
        mode: 0o644,
      });
      const warning = spyOn(console, "warn").mockImplementation(() => {});

      try {
        const store = new SessionStore(sessionPath);
        await expect(store.load()).resolves.toBeUndefined();
        expect(store.get(CHANNEL_USER_ID)).toBeUndefined();
        expect(warning).toHaveBeenCalledWith(
          "Ignored a corrupt WhatsApp chat session store and started with no cached sessions."
        );

        const entries = await readdir(path.dirname(sessionPath));
        const corruptBackup = entries.find((entry) =>
          entry.startsWith(`${path.basename(sessionPath)}.corrupt-`)
        );
        expect(corruptBackup).toBeDefined();
        if (!corruptBackup) {
          throw new Error("Expected a quarantined session-store backup.");
        }
        expect(
          (await stat(path.join(path.dirname(sessionPath), corruptBackup)))
            .mode % 0o1000
        ).toBe(0o600);

        store.set(CHANNEL_USER_ID, sessionRecord("session_recovered"));
        await store.save();
        const recovered = new SessionStore(sessionPath);
        await recovered.load();
        expect(recovered.get(CHANNEL_USER_ID)?.sessionId).toBe(
          "session_recovered"
        );
      } finally {
        warning.mockRestore();
      }
    });
  });
});

function sessionRecord(sessionId: string) {
  return {
    channelUserId: CHANNEL_USER_ID,
    profileId: "default",
    sessionId,
    updatedAt: new Date().toISOString(),
  };
}

async function withTempSessionPath(
  callback: (sessionPath: string) => Promise<void>
): Promise<void> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "atlas-wa-sessions-"));
  try {
    await callback(path.join(tempDir, "chat-sessions.json"));
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

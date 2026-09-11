import { describe, expect, spyOn, test } from "bun:test";
import { createRequire } from "node:module";

// Resolve the actual transitive copy used by Baileys, including isolated Bun
// installs; a test of an unrelated top-level libsignal could miss a bad patch.
const require = createRequire(import.meta.url);
const baileysRequire = createRequire(
  require.resolve("@whiskeysockets/baileys")
);
const { SessionRecord, SessionCipher } = baileysRequire("libsignal") as {
  SessionRecord: {
    new (): {
      closeSession: (session: unknown) => void;
      openSession: (session: unknown) => void;
    };
  };
  SessionCipher: {
    prototype: {
      decryptWithSessions: (
        data: Uint8Array,
        sessions: unknown[]
      ) => Promise<unknown>;
    };
  };
};

describe("libsignal private diagnostics", () => {
  test("never logs ratchet keys when opening, closing, or reclosing a session", () => {
    const messages: unknown[][] = [];
    const info = spyOn(console, "info").mockImplementation((...args) => {
      messages.push(args);
    });
    const warn = spyOn(console, "warn").mockImplementation((...args) => {
      messages.push(args);
    });
    try {
      const record = new SessionRecord();
      const session = {
        currentRatchet: {
          ephemeralKeyPair: { privKey: Buffer.from("private-ratchet-canary") },
          rootKey: Buffer.from("root-key-canary"),
        },
        indexInfo: { closed: -1 },
      };
      record.closeSession(session);
      expect(session.indexInfo.closed).toBeGreaterThan(0);
      record.closeSession(session);
      record.openSession(session);
      expect(session.indexInfo.closed).toBe(-1);
      expect(
        messages.every((args) => args.every((arg) => typeof arg === "string"))
      ).toBe(true);
      expect(JSON.stringify(messages)).not.toContain("private-ratchet-canary");
      expect(JSON.stringify(messages)).not.toContain("root-key-canary");
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  test("failed decrypts retain failure semantics without raw error or stack dumps", async () => {
    const messages: unknown[][] = [];
    const error = spyOn(console, "error").mockImplementation((...args) => {
      messages.push(args);
    });
    try {
      await expect(
        SessionCipher.prototype.decryptWithSessions.call(
          {
            doDecryptWhisperMessage: () => {
              throw new Error("private-ciphertext-canary");
            },
          },
          new Uint8Array(),
          [{}, {}]
        )
      ).rejects.toThrow();
      expect(messages).toHaveLength(1);
      expect(JSON.stringify(messages)).not.toContain(
        "private-ciphertext-canary"
      );
    } finally {
      error.mockRestore();
    }
  });
});

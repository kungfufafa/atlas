import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runWithUserConfigDir } from "@atlas/core";
import {
  beginSubscriptionSessionDeletion,
  clearSubscriptionSessionsForConversation,
  deleteSubscriptionProviderSessions,
  listSubscriptionSessionDeletionCandidates,
  readSubscriptionSession,
  withSubscriptionSessionLease,
  writeSubscriptionSession,
} from "./session-store";

describe("subscription session store", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    for (const directory of temporaryDirectories) {
      await rm(directory, { force: true, recursive: true });
    }
    temporaryDirectories.length = 0;
  });

  test("preserves every binding during concurrent writes", async () => {
    const directory = await mkdtemp("/tmp/atlas-subscription-sessions-");
    temporaryDirectories.push(directory);

    await runWithUserConfigDir(directory, async () => {
      await Promise.all(
        Array.from({ length: 40 }, (_, index) =>
          writeSubscriptionSession("chatgpt", `conversation-${index}`, {
            historyFingerprint: `fingerprint-${index}`,
            lastMessageCount: index,
            runtimeSessionId: `runtime-${index}`,
          })
        )
      );

      const bindings = await Promise.all(
        Array.from({ length: 40 }, (_, index) =>
          readSubscriptionSession("chatgpt", `conversation-${index}`)
        )
      );
      expect(bindings).toHaveLength(40);
      expect(bindings.every(Boolean)).toBe(true);
      expect(bindings[17]).toMatchObject({
        historyFingerprint: "fingerprint-17",
        lastMessageCount: 17,
        runtimeSessionId: "runtime-17",
      });

      const raw = await readFile(
        join(directory, "subscription-sessions.json"),
        "utf8"
      );
      expect(() => JSON.parse(raw)).not.toThrow();
    });
  });

  test("clears both provider bindings for an Atlas conversation", async () => {
    const directory = await mkdtemp("/tmp/atlas-subscription-sessions-");
    temporaryDirectories.push(directory);

    await runWithUserConfigDir(directory, async () => {
      await writeSubscriptionSession("chatgpt", "session-1", {
        lastMessageCount: 1,
        runtimeSessionId: "codex-thread",
      });
      await writeSubscriptionSession("claude", "session-1", {
        lastMessageCount: 1,
        runtimeSessionId: "claude-session",
      });

      await clearSubscriptionSessionsForConversation("session-1");

      expect(await readSubscriptionSession("chatgpt", "session-1")).toBeNull();
      expect(await readSubscriptionSession("claude", "session-1")).toBeNull();
    });
  });

  test("invalidates an in-flight write and retains its native id for cleanup", async () => {
    const directory = await mkdtemp("/tmp/atlas-subscription-sessions-");
    temporaryDirectories.push(directory);
    let releaseTurn: () => void = () => undefined;
    let markTurnStarted: () => void = () => undefined;
    const turnStarted = new Promise<void>((resolve) => {
      markTurnStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    await runWithUserConfigDir(directory, async () => {
      const activeTurn = withSubscriptionSessionLease(
        "chatgpt",
        "session-race",
        async () => {
          markTurnStarted();
          await release;
          await writeSubscriptionSession("chatgpt", "session-race", {
            lastMessageCount: 1,
            runtimeSessionId: "late-native-thread",
          });
        },
        async () => {
          throw new Error("native deletion is unavailable");
        }
      );
      await turnStarted;

      const barrier = beginSubscriptionSessionDeletion("session-race");
      try {
        const idle = barrier.waitForIdle(1000);
        releaseTurn();
        await activeTurn;
        await idle;
      } finally {
        barrier.release();
      }

      expect(
        await readSubscriptionSession("chatgpt", "session-race")
      ).toBeNull();
      expect(
        await listSubscriptionSessionDeletionCandidates("session-race")
      ).toEqual([
        expect.objectContaining({
          kind: "chatgpt",
          runtimeSessionId: "late-native-thread",
        }),
      ]);
    });
  });

  test("deletes the replaced native session after a history reset", async () => {
    const directory = await mkdtemp("/tmp/atlas-subscription-sessions-");
    temporaryDirectories.push(directory);
    const deletedRuntimeSessionIds: string[] = [];

    await runWithUserConfigDir(directory, async () => {
      await writeSubscriptionSession("claude", "session-reset", {
        lastMessageCount: 1,
        runtimeSessionId: "old-native-session",
      });
      await withSubscriptionSessionLease(
        "claude",
        "session-reset",
        () =>
          writeSubscriptionSession("claude", "session-reset", {
            lastMessageCount: 2,
            runtimeSessionId: "new-native-session",
          }),
        async (candidate) => {
          deletedRuntimeSessionIds.push(candidate.runtimeSessionId);
        }
      );

      expect(deletedRuntimeSessionIds).toEqual(["old-native-session"]);
      expect(
        await readSubscriptionSession("claude", "session-reset")
      ).toMatchObject({ runtimeSessionId: "new-native-session" });
      expect(
        await listSubscriptionSessionDeletionCandidates("session-reset")
      ).toEqual([
        expect.objectContaining({ runtimeSessionId: "new-native-session" }),
      ]);
    });
  });

  test("queues and deletes the native binding evicted by the store cap", async () => {
    const directory = await mkdtemp("/tmp/atlas-subscription-sessions-");
    temporaryDirectories.push(directory);
    const sessions = Object.fromEntries(
      Array.from({ length: 2000 }, (_, index) => [
        `chatgpt:conversation-${index}`,
        {
          lastMessageCount: index,
          runtimeSessionId: `runtime-${index}`,
          updatedAt: new Date(index * 1000).toISOString(),
        },
      ])
    );
    await writeFile(
      join(directory, "subscription-sessions.json"),
      JSON.stringify({ sessions }),
      "utf8"
    );
    const deletedRuntimeSessionIds: string[] = [];

    await runWithUserConfigDir(directory, async () => {
      await withSubscriptionSessionLease(
        "chatgpt",
        "new-conversation",
        () =>
          writeSubscriptionSession("chatgpt", "new-conversation", {
            lastMessageCount: 1,
            runtimeSessionId: "new-runtime",
          }),
        async (candidate) => {
          deletedRuntimeSessionIds.push(candidate.runtimeSessionId);
        }
      );

      expect(deletedRuntimeSessionIds).toEqual(["runtime-0"]);
      expect(
        await readSubscriptionSession("chatgpt", "conversation-0")
      ).toBeNull();
      expect(
        await readSubscriptionSession("chatgpt", "new-conversation")
      ).toMatchObject({ runtimeSessionId: "new-runtime" });
    });
  });

  test("drains provider leases before deleting every provider session", async () => {
    const directory = await mkdtemp("/tmp/atlas-subscription-sessions-");
    temporaryDirectories.push(directory);
    let markStarted: () => void = () => undefined;
    let releaseTurn: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    let markPostDeletionStarted: () => void = () => undefined;
    let releasePostDeletion: () => void = () => undefined;
    const postDeletionStarted = new Promise<void>((resolve) => {
      markPostDeletionStarted = resolve;
    });
    const postDeletionRelease = new Promise<void>((resolve) => {
      releasePostDeletion = resolve;
    });
    const deletedRuntimeSessionIds: string[] = [];

    await runWithUserConfigDir(directory, async () => {
      await writeSubscriptionSession("chatgpt", "conversation-logout", {
        lastMessageCount: 1,
        runtimeSessionId: "runtime-logout",
      });
      await writeSubscriptionSession("claude", "conversation-claude", {
        lastMessageCount: 1,
        runtimeSessionId: "runtime-claude",
      });
      const activeTurn = withSubscriptionSessionLease(
        "chatgpt",
        "conversation-active",
        async () => {
          markStarted();
          await release;
        }
      );
      await started;

      const deletion = deleteSubscriptionProviderSessions(
        "chatgpt",
        async (candidate) => {
          deletedRuntimeSessionIds.push(candidate.runtimeSessionId);
        },
        async () => {
          markPostDeletionStarted();
          await postDeletionRelease;
        }
      );
      await Promise.resolve();
      await expect(
        withSubscriptionSessionLease(
          "chatgpt",
          "conversation-blocked",
          async () => undefined
        )
      ).rejects.toThrow("currently being cleared");
      expect(deletedRuntimeSessionIds).toEqual([]);

      releaseTurn();
      await activeTurn;
      await postDeletionStarted;

      expect(deletedRuntimeSessionIds).toEqual(["runtime-logout"]);
      await expect(
        withSubscriptionSessionLease(
          "chatgpt",
          "conversation-blocked-during-logout",
          async () => undefined
        )
      ).rejects.toThrow("currently being cleared");

      releasePostDeletion();
      await deletion;

      expect(deletedRuntimeSessionIds).toEqual(["runtime-logout"]);
      expect(
        await readSubscriptionSession("chatgpt", "conversation-logout")
      ).toBeNull();
      expect(
        await readSubscriptionSession("claude", "conversation-claude")
      ).toMatchObject({ runtimeSessionId: "runtime-claude" });
    });
  });

  test("treats an already-missing native provider session as deleted", async () => {
    const directory = await mkdtemp("/tmp/atlas-subscription-sessions-");
    temporaryDirectories.push(directory);
    let logoutCompleted = false;

    await runWithUserConfigDir(directory, async () => {
      await writeSubscriptionSession("chatgpt", "conversation-missing", {
        lastMessageCount: 1,
        runtimeSessionId: "thread-missing",
      });

      await deleteSubscriptionProviderSessions(
        "chatgpt",
        async () => {
          throw new Error("Thread thread-missing not found");
        },
        async () => {
          logoutCompleted = true;
        }
      );

      expect(logoutCompleted).toBe(true);
      expect(
        await readSubscriptionSession("chatgpt", "conversation-missing")
      ).toBeNull();
      expect(
        await listSubscriptionSessionDeletionCandidates("conversation-missing")
      ).toEqual([]);
    });
  });

  test("does not overwrite a malformed non-empty session store", async () => {
    const directory = await mkdtemp("/tmp/atlas-subscription-sessions-");
    temporaryDirectories.push(directory);
    const path = join(directory, "subscription-sessions.json");
    const malformedStore = '{"sessions":';
    await writeFile(path, malformedStore, "utf8");

    await runWithUserConfigDir(directory, async () => {
      await expect(
        writeSubscriptionSession("chatgpt", "conversation-new", {
          lastMessageCount: 1,
          runtimeSessionId: "thread-new",
        })
      ).rejects.toThrow("session store is corrupted");
    });

    expect(await readFile(path, "utf8")).toBe(malformedStore);
  });

  test("rejects invalid entries instead of silently dropping native ids", async () => {
    const directory = await mkdtemp("/tmp/atlas-subscription-sessions-");
    temporaryDirectories.push(directory);
    const path = join(directory, "subscription-sessions.json");
    const invalidStore = JSON.stringify({
      sessions: {
        "chatgpt:conversation-invalid": {
          lastMessageCount: -1,
          runtimeSessionId: "thread-that-must-not-be-forgotten",
        },
      },
    });
    await writeFile(path, invalidStore, "utf8");

    await runWithUserConfigDir(directory, async () => {
      await expect(
        readSubscriptionSession("chatgpt", "conversation-invalid")
      ).rejects.toThrow("session store is corrupted");
    });

    expect(await readFile(path, "utf8")).toBe(invalidStore);
  });
});

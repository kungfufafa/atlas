import { describe, expect, test } from "bun:test";
import type { AgentChatSession } from "@atlas/agent";
import type { DatabaseAdapter } from "@atlas/db";
import { wrapPersistedSession } from "./session-persistence";

describe("wrapPersistedSession", () => {
  test("clear leaves the delete to clearSession instead of firing it unawaited", () => {
    let cleared = false;
    const session = {
      clear() {
        cleared = true;
      },
      getHistoryRevision: () => 0,
    } as unknown as AgentChatSession;

    // An unawaited call here rejects with nowhere to report, and Bun ends the
    // process on an unhandled rejection. AgentService.clearSession awaits the
    // same delete right after, so this wrapper must not repeat it.
    const db = {
      deleteMessagesForSession() {
        throw new Error("clear() must not delete messages");
      },
    } as unknown as DatabaseAdapter;

    wrapPersistedSession("session_1", session, db).clear();

    expect(cleared).toBe(true);
  });

  test("does not persist a completed reply after the organization is archived", async () => {
    const history: Array<
      { content: string; role: "user" } | { content: string; role: "assistant" }
    > = [];
    let appendCalls = 0;
    let replaceCalls = 0;
    let providerCompleted = false;
    const session = {
      getHistory: () => history,
      getHistoryRevision: () => 0,
      async send() {
        providerCompleted = true;
        history.push(
          { content: "hello", role: "user" },
          { content: "reply", role: "assistant" }
        );
        return "reply";
      },
    } as unknown as AgentChatSession;
    const db = {
      appendMessagesForSession() {
        appendCalls += 1;
        return Promise.resolve();
      },
      listMessagesForSession: () => Promise.resolve([]),
      replaceMessagesForSession() {
        replaceCalls += 1;
        return Promise.resolve();
      },
    } as unknown as DatabaseAdapter;
    const persisted = wrapPersistedSession("session_1", session, db, {
      async beforePersist() {
        expect(providerCompleted).toBe(true);
        throw new Error("Organization not found.");
      },
    });

    await expect(persisted.send("hello")).rejects.toThrow(
      "Organization not found."
    );
    expect(appendCalls).toBe(0);
    expect(replaceCalls).toBe(0);
  });

  test("revalidates after reading existing history and immediately before append", async () => {
    let releaseList: (() => void) | undefined;
    let markListStarted: (() => void) | undefined;
    const listStarted = new Promise<void>((resolve) => {
      markListStarted = resolve;
    });
    const listGate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    let organizationActive = true;
    let appendCalls = 0;
    const history: Array<
      { content: string; role: "user" } | { content: string; role: "assistant" }
    > = [];
    const session = {
      getHistory: () => history,
      getHistoryRevision: () => 0,
      async send() {
        history.push(
          { content: "hello", role: "user" },
          { content: "reply", role: "assistant" }
        );
        return "reply";
      },
    } as unknown as AgentChatSession;
    const db = {
      appendMessagesForSession() {
        appendCalls += 1;
        return Promise.resolve();
      },
      async listMessagesForSession() {
        markListStarted?.();
        await listGate;
        return [];
      },
    } as unknown as DatabaseAdapter;
    const persisted = wrapPersistedSession("session_race", session, db, {
      async beforePersist() {
        if (!organizationActive) {
          throw new Error("Organization not found.");
        }
      },
    });

    const pending = persisted.send("hello");
    await listStarted;
    organizationActive = false;
    releaseList?.();

    await expect(pending).rejects.toThrow("Organization not found.");
    expect(appendCalls).toBe(0);
  });
});

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
    let resolvedCalls = 0;
    let rejectedCalls = 0;
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
      onSendRejected: async () => {
        rejectedCalls += 1;
      },
      onSendResolved: () => {
        resolvedCalls += 1;
      },
    });

    await expect(persisted.send("hello")).rejects.toThrow(
      "Organization not found."
    );
    expect(appendCalls).toBe(0);
    expect(replaceCalls).toBe(0);
    expect(rejectedCalls).toBe(1);
    expect(resolvedCalls).toBe(0);
    expect(history).toEqual([]);
  });

  test("rolls back a completed turn when persist fails so a follow-up does not skip it", async () => {
    const history: Array<
      { content: string; role: "user" } | { content: string; role: "assistant" }
    > = [];
    const appended: string[][] = [];
    let persistShouldFail = true;
    const session = {
      getHistory: () => history,
      getHistoryRevision: () => 0,
      async send(message: string) {
        history.push(
          { content: message, role: "user" },
          { content: `${message}-reply`, role: "assistant" }
        );
        return `${message}-reply`;
      },
      async sendStream(message: string) {
        return session.send(message);
      },
    } as unknown as AgentChatSession;
    const db = {
      appendMessagesForSession(
        _sessionId: string,
        messages: Array<{ payload: { content: string } }>
      ) {
        appended.push(messages.map((message) => message.payload.content));
        return Promise.resolve();
      },
      listMessagesForSession: () => Promise.resolve([]),
    } as unknown as DatabaseAdapter;
    const persisted = wrapPersistedSession("session_1", session, db, {
      async beforePersist() {
        if (persistShouldFail) {
          throw new Error("disk full");
        }
      },
    });

    await expect(persisted.sendStream("first", {})).rejects.toThrow(
      "disk full"
    );
    expect(history).toEqual([]);
    expect(appended).toEqual([]);

    persistShouldFail = false;
    await expect(persisted.send("second")).resolves.toBe("second-reply");
    expect(appended).toEqual([["second", "second-reply"]]);
  });

  test("notifies rejection for underlying send and stream failures", async () => {
    const providerError = new Error("provider failed");
    const session = {
      getHistory: () => [],
      getHistoryRevision: () => 0,
      send: () => Promise.reject(providerError),
      sendStream: () => Promise.reject(providerError),
    } as unknown as AgentChatSession;
    const db = {} as DatabaseAdapter;
    const rejectedModes: string[] = [];
    const persisted = wrapPersistedSession("session_failure", session, db, {
      onSendRejected: async (_sessionId, error) => {
        expect(error).toBe(providerError);
        rejectedModes.push("rejected");
      },
    });

    await expect(persisted.send("hello")).rejects.toBe(providerError);
    await expect(persisted.sendStream("hello", {})).rejects.toBe(providerError);
    expect(rejectedModes).toEqual(["rejected", "rejected"]);
  });

  test("releases rejection cleanup after the underlying send succeeds", async () => {
    const history = [
      { content: "hello", role: "user" as const },
      { content: "reply", role: "assistant" as const },
    ];
    const session = {
      getHistory: () => history,
      getHistoryRevision: () => 0,
      send: () => Promise.resolve("reply"),
    } as unknown as AgentChatSession;
    let committed = 0;
    const db = {
      appendMessagesForSession: () => Promise.resolve(),
      listMessagesForSession: () => Promise.resolve([]),
    } as unknown as DatabaseAdapter;
    const persisted = wrapPersistedSession("session_success", session, db, {
      onSendResolved: () => {
        committed += 1;
      },
    });

    await expect(persisted.send("hello")).resolves.toBe("reply");
    expect(committed).toBe(1);
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

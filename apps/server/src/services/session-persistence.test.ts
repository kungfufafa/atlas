import { describe, expect, test } from "bun:test";
import type { AgentChatSession } from "@atlas/agent";
import type { ChatMessage, CompactedHistoryArchive } from "@atlas/core";
import { SYNTHETIC_SECRET_FIXTURES } from "@atlas/core/testing/synthetic-secret-fixtures";
import type {
  DatabaseAdapter,
  StoredSessionHistoryArchiveRecord,
} from "@atlas/db";
import { wrapPersistedSession } from "./session-persistence";

function completedToolTurn(): ChatMessage[] {
  return [
    { content: "create the report", role: "user" },
    {
      content: "",
      role: "assistant",
      toolCalls: [{ arguments: {}, id: "call_1", name: "save_report" }],
    },
    {
      content: '{"path":"artifacts/report.txt"}',
      name: "save_report",
      role: "tool",
      toolCallId: "call_1",
    },
  ];
}

function persistenceRecorder(initial: ChatMessage[] = []) {
  const stored = initial.map((payload, seq) => ({ payload, seq }));
  let appendCalls = 0;
  let replaceCalls = 0;
  const archives: StoredSessionHistoryArchiveRecord[] = [];
  const db = {
    async appendMessagesForSession(
      _sessionId: string,
      messages: Array<{ payload: ChatMessage; seq: number }>
    ) {
      appendCalls += 1;
      stored.push(...messages);
    },
    listMessagesForSession: async () => stored,
    async replaceMessagesForSession(
      _sessionId: string,
      messages: Array<{ payload: ChatMessage; seq: number }>,
      snapshots: StoredSessionHistoryArchiveRecord[] = []
    ) {
      replaceCalls += 1;
      stored.splice(0, stored.length, ...messages);
      archives.push(...snapshots);
    },
  } as unknown as DatabaseAdapter;
  return {
    get appendCalls() {
      return appendCalls;
    },
    archives,
    db,
    get history() {
      return stored.map((record) => record.payload);
    },
    get replaceCalls() {
      return replaceCalls;
    },
  };
}

describe("wrapPersistedSession", () => {
  test("does not mistake cloned archived tool history for effects from a failed new turn", async () => {
    const history = completedToolTurn();
    const pending: CompactedHistoryArchive[] = [];
    const failure = new Error("First provider request failed");
    let retained = false;
    const session = {
      getHistory: () => history,
      getHistoryRevision: () => 0,
      getPendingHistoryArchives: () => pending,
      async send() {
        pending.push({
          createdAt: "2026-09-06T00:00:00.000Z",
          id: "archive_old_tools",
          messages: structuredClone([
            ...history,
            { content: "new rejected request", role: "user" },
          ]),
        });
        throw failure;
      },
    } as unknown as AgentChatSession;
    const recorder = persistenceRecorder(history);
    const persisted = wrapPersistedSession(
      "session_old_tools",
      session,
      recorder.db,
      {
        onToolEvidenceRetained: () => {
          retained = true;
        },
      }
    );

    await expect(persisted.send("new rejected request")).rejects.toBe(failure);
    expect(retained).toBe(false);
    expect(recorder.replaceCalls).toBe(0);
    expect(recorder.appendCalls).toBe(0);
    expect(recorder.archives).toEqual([]);
    expect(recorder.history).toEqual(history);
  });

  test.each(["send", "stream", "compact"])(
    "clear blocks an older %s from restoring history or archives after the persistence guard resolves",
    async (mode) => {
      const history: ChatMessage[] = [];
      const archives: CompactedHistoryArchive[] = [];
      let revision = 0;
      let acknowledgments = 0;
      let retained = false;
      let firstOperation = true;
      const gate = Promise.withResolvers<void>();
      const guardStarted = Promise.withResolvers<void>();
      const session = {
        acknowledgeHistoryArchives() {
          acknowledgments += 1;
        },
        clear() {
          history.splice(0, history.length);
          archives.splice(0, archives.length);
          revision += 1;
        },
        async compact() {
          archives.push({
            createdAt: "2026-09-06T00:00:00.000Z",
            id: "archive_clear",
            messages: completedToolTurn(),
          });
          history.push({
            content: "Old report saved",
            role: "assistant",
            summary: true,
          });
          revision += 1;
          return { action: "summarized", messagesAfter: 1, messagesBefore: 3 };
        },
        getHistory: () => history,
        getHistoryRevision: () => revision,
        getPendingHistoryArchives: () => archives,
        async send() {
          if (firstOperation) {
            firstOperation = false;
            await session.compact();
          } else {
            history.push(
              { content: "New conversation", role: "user" },
              { content: "New reply", role: "assistant" }
            );
          }
          return "Reply";
        },
        sendStream: async () => session.send("fixture"),
      } as unknown as AgentChatSession;
      const recorder = persistenceRecorder();
      const persisted = wrapPersistedSession(
        "session_clear_guard",
        session,
        recorder.db,
        {
          beforePersist: async () => {
            guardStarted.resolve();
            await gate.promise;
          },
          onToolEvidenceRetained: () => {
            retained = true;
          },
        }
      );
      let operation: Promise<unknown>;
      if (mode === "compact") {
        firstOperation = false;
        operation = persisted.compact({ force: true });
      } else if (mode === "stream") {
        operation = persisted.sendStream("old request", { onChunk() {} });
      } else {
        operation = persisted.send("old request");
      }
      await guardStarted.promise;
      const rejected = operation.catch((error: unknown) => error);
      persisted.clear();
      gate.resolve();
      expect(await rejected).toMatchObject({ name: "AbortError" });

      expect(history).toEqual([]);
      expect(archives).toEqual([]);
      expect(recorder.history).toEqual([]);
      expect(recorder.archives).toEqual([]);
      expect(recorder.replaceCalls).toBe(0);
      expect(recorder.appendCalls).toBe(0);
      expect(acknowledgments).toBe(0);
      expect(retained).toBe(false);
      await persisted.send("new request");
      expect(recorder.replaceCalls).toBe(0);
      expect(recorder.appendCalls).toBe(1);
      expect(recorder.history).toEqual(history);
    }
  );

  test("a cleared send cannot acknowledge archives or alter retry state after an in-flight DB write returns", async () => {
    const history: ChatMessage[] = [];
    const archives: CompactedHistoryArchive[] = [];
    let revision = 0;
    let acknowledgments = 0;
    const databaseStarted = Promise.withResolvers<void>();
    const databaseGate = Promise.withResolvers<void>();
    const session = {
      acknowledgeHistoryArchives() {
        acknowledgments += 1;
      },
      clear() {
        history.splice(0, history.length);
        archives.splice(0, archives.length);
        revision += 1;
      },
      getHistory: () => history,
      getHistoryRevision: () => revision,
      getPendingHistoryArchives: () => archives,
      async send() {
        history.push(...completedToolTurn());
        archives.push({
          createdAt: "2026-09-06T00:00:00.000Z",
          id: "archive_inflight",
          messages: [...history],
        });
        return "Finished";
      },
    } as unknown as AgentChatSession;
    const db = {
      async replaceMessagesForSession() {
        databaseStarted.resolve();
        await databaseGate.promise;
      },
    } as unknown as DatabaseAdapter;
    const persisted = wrapPersistedSession("session_clear_db", session, db);
    const operation = persisted.send("old request");
    await databaseStarted.promise;
    const rejected = operation.catch((error: unknown) => error);
    persisted.clear();
    databaseGate.resolve();
    expect(await rejected).toMatchObject({ name: "AbortError" });
    expect(acknowledgments).toBe(0);
    expect(history).toEqual([]);
    expect(archives).toEqual([]);
  });

  test("an older provider failure cannot retain or persist tools belonging to the conversation after clear", async () => {
    const history: ChatMessage[] = [];
    let revision = 0;
    let retained = false;
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const failure = new Error("Old provider failed");
    const session = {
      clear() {
        history.splice(0, history.length);
        revision += 1;
      },
      getHistory: () => history,
      getHistoryRevision: () => revision,
      async send() {
        started.resolve();
        await gate.promise;
        throw failure;
      },
    } as unknown as AgentChatSession;
    const recorder = persistenceRecorder();
    const persisted = wrapPersistedSession(
      "session_old_failure",
      session,
      recorder.db,
      {
        onToolEvidenceRetained: () => {
          retained = true;
        },
      }
    );
    const operation = persisted
      .send("old request")
      .catch((error: unknown) => error);
    await started.promise;
    persisted.clear();
    const newHistory = completedToolTurn();
    history.push(...newHistory);
    gate.resolve();
    expect(await operation).toBe(failure);
    expect(history).toEqual(newHistory);
    expect(recorder.appendCalls).toBe(0);
    expect(recorder.replaceCalls).toBe(0);
    expect(retained).toBe(false);
  });

  test("persists pending archives atomically with the active transcript and redacts archive contents", async () => {
    const original: ChatMessage[] = [
      {
        content: `Credential ${SYNTHETIC_SECRET_FIXTURES.openAiApiKey}`,
        role: "user",
      },
    ];
    const archive: CompactedHistoryArchive = {
      createdAt: "2026-09-06T00:00:00.000Z",
      id: "archive_mid_turn",
      messages: original,
    };
    const pending = [archive];
    const history: ChatMessage[] = [
      { content: "Compacted context", role: "assistant", summary: true },
    ];
    const recorder = persistenceRecorder();
    const acknowledgments: string[] = [];
    const session = {
      acknowledgeHistoryArchives(ids: readonly string[]) {
        expect(recorder.replaceCalls).toBe(1);
        acknowledgments.push(...ids);
        pending.splice(0, pending.length);
      },
      getHistory: () => history,
      getHistoryRevision: () => 0,
      getPendingHistoryArchives: () => pending,
      async send() {
        history.push({ content: "Finished", role: "assistant" });
        return "Finished";
      },
    } as unknown as AgentChatSession;
    const persisted = wrapPersistedSession(
      "session_archive",
      session,
      recorder.db
    );

    expect(persisted.getPendingHistoryArchives?.()).toEqual([archive]);
    await expect(persisted.send("continue")).resolves.toBe("Finished");
    expect(recorder.appendCalls).toBe(0);
    expect(recorder.replaceCalls).toBe(1);
    expect(recorder.history).toEqual(history);
    expect(recorder.archives).toEqual([
      {
        ...archive,
        messages: [{ content: "Credential [REDACTED]", role: "user" }],
        sessionId: "session_archive",
      },
    ]);
    expect(original[0]?.content).toContain(
      SYNTHETIC_SECRET_FIXTURES.openAiApiKey
    );
    expect(acknowledgments).toEqual([archive.id]);
    expect(persisted.getPendingHistoryArchives?.()).toEqual([]);
  });

  test("retries a failed compaction archive save even when the next compaction makes no change", async () => {
    const original = completedToolTurn();
    const history = [...original];
    const pending: CompactedHistoryArchive[] = [];
    let revision = 0;
    let canPersist = false;
    const session = {
      acknowledgeHistoryArchives: () => pending.splice(0, pending.length),
      async compact() {
        if (revision === 0) {
          pending.push({
            createdAt: "2026-09-06T00:00:00.000Z",
            id: "archive_retry",
            messages: [...history],
          });
          history.splice(0, history.length, {
            content: "Compacted context",
            role: "assistant",
            summary: true,
          });
          revision += 1;
          return { action: "summarized", messagesAfter: 1, messagesBefore: 3 };
        }
        return { action: "none", messagesAfter: 1, messagesBefore: 1 };
      },
      getHistory: () => history,
      getHistoryRevision: () => revision,
      getPendingHistoryArchives: () => pending,
    } as unknown as AgentChatSession;
    const recorder = persistenceRecorder(original);
    const persisted = wrapPersistedSession(
      "session_archive_retry",
      session,
      recorder.db,
      {
        beforePersist: async () => {
          if (!canPersist) {
            throw new Error("Archive storage unavailable");
          }
        },
      }
    );

    await expect(persisted.compact({ force: true })).rejects.toThrow();
    expect(pending).toHaveLength(1);
    expect(recorder.history).toEqual(original);
    expect(recorder.archives).toEqual([]);
    canPersist = true;
    await persisted.compact({ force: true });
    expect(pending).toEqual([]);
    expect(recorder.replaceCalls).toBe(1);
    expect(recorder.history).toEqual(history);
    expect(recorder.archives).toMatchObject([
      { id: "archive_retry", messages: original },
    ]);
  });

  test.each([false, true])(
    "retains completed effects after a successful reply cannot be saved, including compacted=%s",
    async (compacted) => {
      const history: ChatMessage[] = [];
      const pending: CompactedHistoryArchive[] = [];
      let actions = 0;
      let canPersist = false;
      let retained = false;
      let rejected = 0;
      const failure = new Error("Storage unavailable");
      const session = {
        acknowledgeHistoryArchives: () => pending.splice(0, pending.length),
        getHistory: () => history,
        getHistoryRevision: () => 0,
        getPendingHistoryArchives: () => pending,
        async send() {
          if (actions === 0) {
            actions += 1;
            history.push(...completedToolTurn());
            if (compacted) {
              pending.push({
                createdAt: "2026-09-06T00:00:00.000Z",
                id: "archive_completed_effects",
                messages: [...history],
              });
              history.splice(0, history.length, {
                content: "Report saved",
                role: "assistant",
                summary: true,
              });
            }
          } else {
            history.push({ content: "continue", role: "user" });
          }
          history.push({ content: "The report is ready", role: "assistant" });
          return "The report is ready";
        },
      } as unknown as AgentChatSession;
      const recorder = persistenceRecorder();
      const persisted = wrapPersistedSession(
        "session_success_effects",
        session,
        recorder.db,
        {
          beforePersist: async () => {
            if (!canPersist) {
              throw failure;
            }
          },
          onSendRejected: async () => {
            expect(retained).toBe(true);
            rejected += 1;
          },
          onToolEvidenceRetained: () => {
            retained = true;
          },
        }
      );

      await expect(persisted.send("create the report")).rejects.toBe(failure);
      expect(actions).toBe(1);
      expect(history.length).toBeGreaterThan(0);
      expect(retained).toBe(true);
      expect(rejected).toBe(1);
      expect(recorder.history).toEqual([]);
      canPersist = true;
      await persisted.send("continue");
      expect(actions).toBe(1);
      expect(recorder.replaceCalls).toBe(1);
      expect(recorder.history).toEqual(history);
      expect(recorder.archives).toHaveLength(compacted ? 1 : 0);
      expect(pending).toEqual([]);
    }
  );

  test.each(["send", "stream"])(
    "persists completed tool evidence after a failed %s without pretending the reply succeeded",
    async (mode) => {
      const history: ChatMessage[] = [];
      const failure = new Error("Follow-up provider unavailable");
      const checkpoint = completedToolTurn();
      const session = {
        getHistory: () => history,
        getHistoryRevision: () => 0,
        async send() {
          history.push(...checkpoint);
          throw failure;
        },
        async sendStream() {
          return await session.send("fixture");
        },
      } as unknown as AgentChatSession;
      const recorder = persistenceRecorder();
      let resourcesRetained = false;
      let rejections = 0;
      let resolutions = 0;
      const persisted = wrapPersistedSession(
        "session_tool",
        session,
        recorder.db,
        {
          beforePersist: async () => {
            expect(resourcesRetained).toBe(true);
          },
          onSendRejected: async () => {
            expect(resourcesRetained).toBe(true);
            rejections += 1;
          },
          onSendResolved: () => {
            resolutions += 1;
          },
          onToolEvidenceRetained: () => {
            resourcesRetained = true;
          },
        }
      );

      const pending =
        mode === "send"
          ? persisted.send("create the report")
          : persisted.sendStream("create the report", { onChunk() {} });
      await expect(pending).rejects.toBe(failure);
      expect(recorder.history).toEqual(checkpoint);
      expect(recorder.appendCalls).toBe(1);
      expect(rejections).toBe(1);
      expect(resolutions).toBe(0);
    }
  );

  test("does not persist pre-tool failures, incomplete batches, or unchanged old tool evidence", async () => {
    const checkpoint = completedToolTurn();
    for (const scenario of [
      { added: checkpoint.slice(0, 1), initial: [] },
      { added: checkpoint.slice(0, 2), initial: [] },
      {
        added: [
          checkpoint[0],
          {
            content: "",
            role: "assistant",
            toolCalls: [
              { arguments: {}, id: "call_1", name: "save_report" },
              { arguments: {}, id: "call_2", name: "save_report" },
            ],
          },
          checkpoint[2],
        ],
        initial: [],
      },
      { added: [], initial: checkpoint },
    ]) {
      const history = [...scenario.initial] as ChatMessage[];
      const session = {
        getHistory: () => history,
        getHistoryRevision: () => 0,
        async send() {
          history.push(...(scenario.added as ChatMessage[]));
          throw new Error("Provider failed");
        },
      } as unknown as AgentChatSession;
      const recorder = persistenceRecorder(scenario.initial as ChatMessage[]);
      let retained = false;
      const persisted = wrapPersistedSession(
        "session_partial",
        session,
        recorder.db,
        {
          onToolEvidenceRetained: () => {
            retained = true;
          },
        }
      );

      await expect(persisted.send("run")).rejects.toThrow();
      expect(recorder.appendCalls).toBe(0);
      expect(recorder.replaceCalls).toBe(0);
      expect(retained).toBe(false);
    }
  });

  test("replaces history when a failed turn retained tool evidence after compaction", async () => {
    const old: ChatMessage[] = [
      { content: "old request", role: "user" },
      { content: "old reply", role: "assistant" },
    ];
    const history = [...old];
    let revision = 0;
    const checkpoint: ChatMessage[] = [
      { content: "Previous work summary", role: "assistant", summary: true },
      ...completedToolTurn(),
    ];
    const session = {
      getHistory: () => history,
      getHistoryRevision: () => revision,
      async send() {
        history.splice(0, history.length, ...checkpoint);
        revision += 1;
        throw new Error("Follow-up failed");
      },
    } as unknown as AgentChatSession;
    const recorder = persistenceRecorder(old);
    const persisted = wrapPersistedSession(
      "session_compacted",
      session,
      recorder.db
    );

    await expect(persisted.send("create the report")).rejects.toThrow();
    expect(recorder.replaceCalls).toBe(1);
    expect(recorder.appendCalls).toBe(0);
    expect(recorder.history).toEqual(checkpoint);
  });

  test("guards checkpoint persistence and retries unsaved evidence with a full replacement", async () => {
    const history: ChatMessage[] = [];
    const failure = new Error("Follow-up failed");
    const storageFailure = new Error("Persistence unavailable");
    let firstTurn = true;
    let canPersist = false;
    const session = {
      getHistory: () => history,
      getHistoryRevision: () => 0,
      async send() {
        if (firstTurn) {
          firstTurn = false;
          history.push(...completedToolTurn());
          throw failure;
        }
        history.push(
          { content: "continue", role: "user" },
          { content: "The report is ready", role: "assistant" }
        );
        return "The report is ready";
      },
    } as unknown as AgentChatSession;
    const recorder = persistenceRecorder();
    let resourcesRetained = false;
    const persisted = wrapPersistedSession(
      "session_retry_save",
      session,
      recorder.db,
      {
        beforePersist: async () => {
          if (!canPersist) {
            throw storageFailure;
          }
        },
        onToolEvidenceRetained: () => {
          resourcesRetained = true;
        },
      }
    );

    await expect(persisted.send("create the report")).rejects.toMatchObject({
      cause: failure,
      errors: [failure, storageFailure],
    });
    expect(resourcesRetained).toBe(true);
    expect(history).toEqual(completedToolTurn());
    expect(recorder.history).toEqual([]);
    expect(recorder.appendCalls).toBe(0);
    expect(recorder.replaceCalls).toBe(0);

    canPersist = true;
    await expect(persisted.send("continue")).resolves.toBe(
      "The report is ready"
    );
    expect(recorder.history).toEqual(history);
    expect(recorder.replaceCalls).toBe(1);
    expect(recorder.history).toHaveLength(5);
  });

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

    await expect(
      persisted.sendStream("first", { onChunk() {} })
    ).rejects.toThrow("disk full");
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
    await expect(persisted.sendStream("hello", { onChunk() {} })).rejects.toBe(
      providerError
    );
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

test.each([false, true])(
  "runtime receipts reach persistence before SDK acknowledgement (disconnect=%s)",
  async (disconnect) => {
    const { createAgentHarness } = await import("@atlas/agent");
    const recorder = persistenceRecorder();
    let effects = 0;
    let acknowledged = 0;
    const provider = {
      async generateChat(input: import("@atlas/core").GenerateChatInput) {
        for (let index = 0; index < 2; index += 1) {
          await input.executeToolCall!({
            arguments: {},
            id: `call-${index}`,
            name: "save_report",
          });
          expect(
            recorder.history.filter((message) => message.role === "tool")
          ).toHaveLength(index + 1);
          acknowledged += 1;
        }
        if (disconnect) {
          throw new Error("Runtime disconnected");
        }
        return {
          assistantMessage: { content: "Saved.", role: "assistant" as const },
          content: "Saved.",
          toolCalls: [],
        };
      },
      async generateText() {
        return { content: "unused" };
      },
      name: "openai_compatible" as const,
      async streamChat() {
        throw new Error("Streaming is not used by this fixture");
      },
    };
    const session = createAgentHarness({
      provider,
      tools: [
        {
          description: "Save a report",
          name: "save_report",
          parameters: { type: "object" },
          async run() {
            effects += 1;
            return { saved: effects };
          },
        },
      ],
    }).createChatSession();
    const persisted = wrapPersistedSession(
      "session-checkpoint",
      session,
      recorder.db
    );
    if (disconnect) {
      await expect(persisted.send("Save twice")).rejects.toThrow();
    } else {
      expect(await persisted.send("Save twice")).toBe("Saved.");
    }
    expect(effects).toBe(2);
    expect(acknowledged).toBe(2);
    expect(recorder.history).toEqual([...session.getHistory()]);
    expect(
      recorder.history.filter((message) => message.role === "tool")
    ).toHaveLength(2);
  }
);

test("persistence failure prevents SDK acknowledgement and retains completed evidence for recovery", async () => {
  const { createAgentHarness } = await import("@atlas/agent");
  const recorder = persistenceRecorder();
  let failWrites = true;
  const append = recorder.db.appendMessagesForSession.bind(recorder.db);
  const replace = recorder.db.replaceMessagesForSession.bind(recorder.db);
  recorder.db.appendMessagesForSession = async (...args) => {
    if (failWrites) {
      throw new Error("Disk full");
    }
    return append(...args);
  };
  recorder.db.replaceMessagesForSession = async (...args) => {
    if (failWrites) {
      throw new Error("Disk full");
    }
    return replace(...args);
  };
  let acknowledged = false;
  let turns = 0;
  let effects = 0;
  const provider = {
    async generateChat(input: import("@atlas/core").GenerateChatInput) {
      turns += 1;
      if (turns === 1) {
        await input.executeToolCall!({
          arguments: {},
          id: "write",
          name: "save_report",
        });
        acknowledged = true;
      }
      return {
        assistantMessage: { content: "Recovered.", role: "assistant" as const },
        content: "Recovered.",
        toolCalls: [],
      };
    },
    async generateText() {
      return { content: "unused" };
    },
    name: "openai_compatible" as const,
    async streamChat() {
      throw new Error("Streaming is not used by this fixture");
    },
  };
  const session = createAgentHarness({
    provider,
    tools: [
      {
        description: "Save",
        name: "save_report",
        async run() {
          effects += 1;
          return { saved: true };
        },
      },
    ],
  }).createChatSession();
  const persisted = wrapPersistedSession(
    "session-write-failure",
    session,
    recorder.db
  );
  await expect(persisted.send("Save")).rejects.toThrow();
  expect(effects).toBe(1);
  expect(acknowledged).toBe(false);
  expect(session.getHistory().at(-1)).toMatchObject({
    role: "tool",
    toolCallId: "write",
  });
  failWrites = false;
  expect(await persisted.send("Explain saved evidence")).toBe("Recovered.");
  expect(effects).toBe(1);
  expect(recorder.history).toEqual([...session.getHistory()]);
  expect(
    recorder.history.filter((message) => message.role === "tool")
  ).toHaveLength(1);
});

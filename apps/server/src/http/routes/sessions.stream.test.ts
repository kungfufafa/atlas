import { describe, expect, test } from "bun:test";
import type { AgentChatSession } from "@atlas/agent";
import { sessionTurnRegistry } from "../../services/session-turn-registry";
import { streamMessage, streamTurnSubscribe } from "../shared";

/** Stands in for a turn stuck in a long tool run: it only settles when cancelled. */
function createCancellableSession(): {
  session: AgentChatSession;
  sawSignal: () => AbortSignal | undefined;
} {
  let signal: AbortSignal | undefined;

  const session = {
    getContextUsage: () => null,
    sendStream: (
      _input: unknown,
      handlers: { onPolicyResolved?: (policy: "standard") => void },
      options?: { signal?: AbortSignal }
    ) =>
      new Promise<string>((_resolve, reject) => {
        signal = options?.signal;
        handlers.onPolicyResolved?.("standard");

        if (!signal) {
          return;
        }

        signal.addEventListener("abort", () => reject(signal?.reason), {
          once: true,
        });
      }),
  } as unknown as AgentChatSession;

  return { sawSignal: () => signal, session };
}

/** Emits once and then stalls: a healthy turn sitting in a long tool run. */
function createChattyThenStalledSession(): AgentChatSession {
  return {
    getContextUsage: () => null,
    sendStream: (
      _input: unknown,
      handlers: { onChunk: (delta: string) => void },
      options?: { signal?: AbortSignal }
    ) =>
      new Promise<string>((_resolve, reject) => {
        handlers.onChunk("working");
        options?.signal?.addEventListener(
          "abort",
          () => reject(options.signal?.reason),
          { once: true }
        );
      }),
  } as unknown as AgentChatSession;
}

/** Mirrors the real agent, which resolves policy before contacting a provider. */
function createPolicyThenSilentSession(): AgentChatSession {
  return {
    getContextUsage: () => null,
    sendStream: (
      _input: unknown,
      handlers: { onPolicyResolved: (policy: "standard") => void },
      options?: { signal?: AbortSignal }
    ) =>
      new Promise<string>((_resolve, reject) => {
        handlers.onPolicyResolved("standard");
        options?.signal?.addEventListener(
          "abort",
          () => reject(options.signal?.reason),
          { once: true }
        );
      }),
  } as unknown as AgentChatSession;
}

function createDelayedPolicyThenSilentSession(
  delayMs: number
): AgentChatSession {
  return {
    getContextUsage: () => null,
    sendStream: async (
      _input: unknown,
      handlers: { onPolicyResolved: (policy: "standard") => void },
      options?: { signal?: AbortSignal }
    ) => {
      await Bun.sleep(delayMs);
      handlers.onPolicyResolved("standard");
      return new Promise<string>((_resolve, reject) => {
        options?.signal?.addEventListener(
          "abort",
          () => reject(options.signal?.reason),
          { once: true }
        );
      });
    },
  } as unknown as AgentChatSession;
}

async function waitForTurnToEnd(sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!sessionTurnRegistry.isActive(sessionId)) {
      return;
    }

    await Bun.sleep(10);
  }
}

describe("streamTurnSubscribe", () => {
  test("returns null when no active turn", () => {
    expect(streamTurnSubscribe("missing_session")).toBeNull();
  });

  test("replays buffered events to subscribe connection", async () => {
    const sessionId = `session_stream_test_${Date.now()}`;

    sessionTurnRegistry.beginTurn(sessionId);
    sessionTurnRegistry.publish(sessionId, { delta: "hello", type: "chunk" });

    const response = streamTurnSubscribe(sessionId);
    expect(response).not.toBeNull();

    const reader = response!.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      if (buffer.includes('"delta":"hello"')) {
        break;
      }
    }

    expect(buffer).toContain('"delta":"hello"');

    sessionTurnRegistry.endTurn(sessionId, { reply: "hello", type: "done" });
  });

  test("returns 429 when the subscriber cap is reached", async () => {
    const sessionId = `session_stream_cap_${Date.now()}`;
    sessionTurnRegistry.beginTurn(sessionId);
    const open: Response[] = [];
    for (let index = 0; index < 3; index += 1) {
      const response = streamTurnSubscribe(sessionId);
      expect(response?.status).toBe(200);
      open.push(response!);
    }

    const fourth = streamTurnSubscribe(sessionId);
    expect(fourth?.status).toBe(429);

    await Promise.all(open.map((response) => response.body?.cancel()));
    const afterCancel = streamTurnSubscribe(sessionId);
    expect(afterCancel?.status).toBe(200);
    sessionTurnRegistry.endTurn(sessionId, { reply: "ok", type: "done" });
  });
});

describe("streamMessage cancellation", () => {
  test("client abort ends the turn so the next message is not a 409", async () => {
    const sessionId = `session_abort_test_${Date.now()}`;
    const { session, sawSignal } = createCancellableSession();
    const request = new AbortController();

    expect(sessionTurnRegistry.beginTurn(sessionId).started).toBe(true);
    streamMessage(
      sessionId,
      session,
      { message: "run something long" },
      undefined,
      request.signal
    );

    await Bun.sleep(10);
    expect(sawSignal()).toBeDefined();
    expect(sessionTurnRegistry.isActive(sessionId)).toBe(true);

    // This is Discord /stop: the worker aborts its fetch, so the server request aborts.
    request.abort();
    await waitForTurnToEnd(sessionId);

    expect(sessionTurnRegistry.isActive(sessionId)).toBe(false);
    // The follow-up message the user sends right after /stop.
    expect(sessionTurnRegistry.beginTurn(sessionId).started).toBe(true);
    sessionTurnRegistry.endTurn(sessionId, { reply: "ok", type: "done" });
  });

  test("cancelling the response stream also ends the turn", async () => {
    const sessionId = `session_cancel_test_${Date.now()}`;
    const { session } = createCancellableSession();

    expect(sessionTurnRegistry.beginTurn(sessionId).started).toBe(true);
    const response = streamMessage(sessionId, session, { message: "hi" });

    await Bun.sleep(10);
    await response.body?.cancel();
    await waitForTurnToEnd(sessionId);

    expect(sessionTurnRegistry.isActive(sessionId)).toBe(false);
  });
});

describe("streamMessage timeout", () => {
  test("a provider that goes quiet is timed out, aborted, and reported as a timeout", async () => {
    const sessionId = `session_timeout_test_${Date.now()}`;
    const { session, sawSignal } = createCancellableSession();

    expect(sessionTurnRegistry.beginTurn(sessionId).started).toBe(true);
    const response = streamMessage(
      sessionId,
      session,
      { message: "hi" },
      undefined,
      undefined,
      10
    );

    const body = await new Response(response.body).text();
    await waitForTurnToEnd(sessionId);

    expect(body).toContain("timed out after");
    // The deadline aborts the turn, so this is the message the user would get
    // if the abort were mistaken for a cancel.
    expect(body).not.toContain("Turn cancelled.");
    // Nothing else stops the provider request once the race is lost.
    expect(sawSignal()?.aborted).toBe(true);
    expect(sessionTurnRegistry.isActive(sessionId)).toBe(false);
    // The session is usable again rather than 409ing for the rest of the window.
    expect(sessionTurnRegistry.beginTurn(sessionId).started).toBe(true);
    sessionTurnRegistry.endTurn(sessionId, { reply: "ok", type: "done" });
  });

  test("a silent provider is released on the first-token deadline, not the stream deadline", async () => {
    const sessionId = `session_first_token_test_${Date.now()}`;
    const { session, sawSignal } = createCancellableSession();

    expect(sessionTurnRegistry.beginTurn(sessionId).started).toBe(true);
    const startedAt = Bun.nanoseconds();
    const response = streamMessage(
      sessionId,
      session,
      { message: "hi" },
      undefined,
      undefined,
      5000,
      50
    );

    const body = await new Response(response.body).text();
    const heldMs = (Bun.nanoseconds() - startedAt) / 1e6;
    await waitForTurnToEnd(sessionId);

    expect(body).toContain("sent nothing for");
    expect(sawSignal()?.aborted).toBe(true);
    expect(sessionTurnRegistry.isActive(sessionId)).toBe(false);
    // The point of the whole change: the session comes back on the short
    // deadline instead of being held for the long one.
    expect(heldMs).toBeLessThan(2500);
  });

  test("policy bookkeeping does not disarm the first-token deadline", async () => {
    const sessionId = `session_policy_timeout_test_${Date.now()}`;
    const session = createPolicyThenSilentSession();

    expect(sessionTurnRegistry.beginTurn(sessionId).started).toBe(true);
    const response = streamMessage(
      sessionId,
      session,
      { message: "hi" },
      undefined,
      undefined,
      5000,
      50
    );

    const body = await new Response(response.body).text();
    await waitForTurnToEnd(sessionId);

    expect(body).toContain('"type":"policy_resolved"');
    expect(body).toContain("sent nothing for");
    expect(sessionTurnRegistry.isActive(sessionId)).toBe(false);
  });

  test("the first-token deadline starts after preprocessing resolves policy", async () => {
    const sessionId = `session_delayed_policy_test_${Date.now()}`;
    const session = createDelayedPolicyThenSilentSession(80);

    expect(sessionTurnRegistry.beginTurn(sessionId).started).toBe(true);
    const startedAt = Bun.nanoseconds();
    const response = streamMessage(
      sessionId,
      session,
      { message: "hi" },
      undefined,
      undefined,
      1000,
      40
    );

    const body = await new Response(response.body).text();
    const heldMs = (Bun.nanoseconds() - startedAt) / 1e6;
    await waitForTurnToEnd(sessionId);

    expect(body).toContain('"type":"policy_resolved"');
    expect(body).toContain("sent nothing for");
    expect(heldMs).toBeGreaterThanOrEqual(100);
  });

  test("a provider that has produced output keeps the full stream deadline", async () => {
    const sessionId = `session_slow_tool_test_${Date.now()}`;
    const session = createChattyThenStalledSession();

    expect(sessionTurnRegistry.beginTurn(sessionId).started).toBe(true);
    const response = streamMessage(
      sessionId,
      session,
      { message: "hi" },
      undefined,
      undefined,
      400,
      50
    );

    const body = await new Response(response.body).text();
    await waitForTurnToEnd(sessionId);

    expect(body).toContain('"delta":"working"');
    // It outlived the 50ms first-token deadline and died on the stream one, so
    // a long tool run is not collateral damage.
    expect(body).not.toContain("sent nothing for");
    expect(body).toContain("timed out after");
  });

  test("a completed turn clears its deadline instead of leaving a timer behind", async () => {
    const sessionId = `session_deadline_test_${Date.now()}`;
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const pending = new Set<ReturnType<typeof setTimeout>>();
    // Distinctive enough that only the stream deadline matches.
    const deadlineMs = 300_000;

    globalThis.setTimeout = ((
      handler: TimerHandler,
      delay?: number,
      ...rest: unknown[]
    ) => {
      const handle = realSetTimeout(
        handler as () => void,
        delay,
        ...(rest as [])
      );
      if (delay === deadlineMs) {
        pending.add(handle);
      }
      return handle;
    }) as typeof globalThis.setTimeout;
    globalThis.clearTimeout = ((handle?: ReturnType<typeof setTimeout>) => {
      if (handle !== undefined) {
        pending.delete(handle);
      }
      realClearTimeout(handle);
    }) as typeof globalThis.clearTimeout;

    try {
      const session = {
        getContextUsage: () => null,
        sendStream: () => Promise.resolve("done"),
      } as unknown as AgentChatSession;

      expect(sessionTurnRegistry.beginTurn(sessionId).started).toBe(true);
      const response = streamMessage(
        sessionId,
        session,
        { message: "hi" },
        undefined,
        undefined,
        deadlineMs
      );

      await new Response(response.body).text();
      await waitForTurnToEnd(sessionId);

      expect(pending.size).toBe(0);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      for (const handle of pending) {
        realClearTimeout(handle);
      }
    }
  });
});

test.each(["approved", "denied"] as const)(
  "approval waiting preserves both stream deadlines (%s)",
  async (decision) => {
    const sessionId = `session_approval_deadline_${crypto.randomUUID()}`;
    const session: AgentChatSession = {
      getContextUsage: () => null,
      async sendStream(_input, handlers, options) {
        handlers.onPolicyResolved?.("standard");
        handlers.onApprovalRequested?.({
          createdAt: new Date().toISOString(),
          details: {},
          id: "approval",
          status: "pending",
          title: "Delete",
          tool: "delete_file",
          toolCallId: "call",
        });
        await Bun.sleep(100);
        expect(options?.signal?.aborted).toBe(false);
        if (decision === "approved") {
          handlers.onToolStart?.({
            input: {},
            tool: "delete_file",
            toolCallId: "call",
          });
        }
        handlers.onToolEnd?.({
          result: {},
          tool: "delete_file",
          toolCallId: "call",
        });
        return "Decision handled.";
      },
    } as AgentChatSession;
    expect(sessionTurnRegistry.beginTurn(sessionId).started).toBe(true);
    const response = streamMessage(
      sessionId,
      session,
      { message: "Delete" },
      undefined,
      undefined,
      60,
      20
    );
    const body = await new Response(response.body).text();
    expect(body).toContain('"type":"approval_requested"');
    expect(body).toContain('"type":"done"');
    expect(body).not.toContain('"type":"error"');
  }
);

test("a cancelled stream cannot publish into or end its replacement turn", async () => {
  const sessionId = `stream-owner-${crypto.randomUUID()}`;
  const finish = Promise.withResolvers<void>();
  const session = {
    getContextUsage: () => null,
    async sendStream(
      _input: unknown,
      handlers: { onChunk: (text: string) => void }
    ) {
      await finish.promise;
      handlers.onChunk("old output");
      throw new DOMException("Cancelled", "AbortError");
    },
  } as AgentChatSession;
  expect(sessionTurnRegistry.beginTurn(sessionId).started).toBe(true);
  const response = streamMessage(sessionId, session, { message: "old" });
  sessionTurnRegistry.cancelTurn(sessionId);
  expect(sessionTurnRegistry.beginTurn(sessionId).started).toBe(true);
  const events: unknown[] = [];
  const subscription = sessionTurnRegistry.subscribe(sessionId, (event) =>
    events.push(event)
  );
  finish.resolve();
  await new Response(response.body).text();
  expect(events).toEqual([]);
  expect(sessionTurnRegistry.isActive(sessionId)).toBe(true);
  subscription?.unsubscribe();
  sessionTurnRegistry.cancelTurn(sessionId);
});

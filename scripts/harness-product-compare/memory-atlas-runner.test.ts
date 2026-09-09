import { expect, test } from "bun:test";
import { parseMemoryRequest, runAtlasMemory } from "./memory-atlas-runner";
import { MEMORY_BUDGET, type MemoryRunRequest } from "./memory-types";

const MODEL = "native-memory-offline-fixture";
const USER_FACT = "Private fixture depot Linden-739 has 47 crates.";
const PROFILE_FACT = "Shared fixture profile prefers CSV exports.";

interface WireMessage {
  content?: string;
  role: string;
  tool_call_id?: string;
}

function fixture(titleDelayMs = 0) {
  const requests: Array<{ messages: WireMessage[]; tools?: unknown[] }> = [];
  const mainRequests: typeof requests = [];
  let count = 0;
  const server = Bun.serve({
    async fetch(incoming) {
      if (
        new URL(incoming.url).pathname !==
        "/runs/memory-test/v1/chat/completions"
      ) {
        return new Response("Unknown offline route", { status: 404 });
      }
      const request = (await incoming.json()) as {
        messages: WireMessage[];
        tools?: unknown[];
      };
      requests.push(request);
      const titleRequest = !request.tools?.length;
      if (titleRequest && titleDelayMs) {
        await new Promise((resolveDelay) =>
          setTimeout(resolveDelay, titleDelayMs)
        );
      }
      if (!titleRequest) {
        mainRequests.push(request);
        count += 1;
      }
      const tool = titleRequest
        ? null
        : count === 1
          ? {
              arguments: { content: USER_FACT, importance: 5, scope: "user" },
              name: "memory_write",
            }
          : count === 2
            ? {
                arguments: {
                  content: `# Memory Log\n\n---\n\n- ${PROFILE_FACT}\n`,
                  path: "MEMORY.md",
                },
                name: "write_file",
              }
            : count === 4
              ? {
                  arguments: { query: "Linden-739", scope: "user" },
                  name: "memory_search",
                }
              : null;
      const message = tool
        ? {
            content: null,
            role: "assistant",
            tool_calls: [
              {
                function: {
                  arguments: JSON.stringify(tool.arguments),
                  name: tool.name,
                },
                id: "reused-fixture-call",
                type: "function",
              },
            ],
          }
        : {
            content: titleRequest
              ? "Fixture memory session"
              : count === 3
                ? "Acquisition done."
                : (request.messages.findLast((item) => item.role === "tool")
                    ?.content ?? "No retrieval result."),
            role: "assistant",
          };
      return Response.json({
        choices: [
          { finish_reason: tool ? "tool_calls" : "stop", index: 0, message },
        ],
        created: 1,
        id: `offline-${count}`,
        model: MODEL,
        object: "chat.completion",
        usage: { completion_tokens: 10, prompt_tokens: 20, total_tokens: 30 },
      });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const request: MemoryRunRequest = {
    budget: { ...MEMORY_BUDGET, timeoutMs: 30_000 },
    condition: "native-default",
    model: MODEL,
    modelMetadata: {
      entry: {
        capabilities: {
          "chat.tool-use": {
            source: "runtime-probe",
            status: "supported",
            verified: true,
          },
        },
        id: MODEL,
      },
      evidence: {
        endpoint: server.url.origin,
        model: MODEL,
        observedAt: new Date().toISOString(),
        source:
          "Local deterministic transport fixture, not measured model behavior",
      },
    },
    proxyBaseUrl: server.url.origin,
    recallTurns: [
      "Recall my private depot crate count and profile export preference.",
    ],
    runId: "memory-test",
    trainingTurns: [
      "My private depot has a crate count; store that in my user memory. My profile has an export preference too.",
    ],
  };
  return { mainRequests, request, requests, server };
}

test("actual native writes persist across reopened SQLite and fresh empty-history sessions", async () => {
  const local = fixture();
  try {
    const result = await runAtlasMemory(local.request);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("completed");
    expect(result.sessions).toHaveLength(2);
    expect(
      result.sessions.every((session) => session.initialHistoryCount === 0)
    ).toBe(true);
    expect(result.sessions[0]?.id).not.toBe(result.sessions[1]?.id);
    expect(result.sessions[0]?.nativeStateRoot).toBe(
      result.sessions[1]?.nativeStateRoot
    );
    expect(result.nativeEvents.map((event) => event.name)).toEqual([
      "memory_write",
      "write_file",
      "memory_search",
    ]);
    expect(result.finalText).toContain(USER_FACT);
    expect(JSON.stringify(local.mainRequests[3]?.messages)).toContain(
      PROFILE_FACT
    );
    expect(
      local.mainRequests[3]?.messages.filter(
        (message) => message.role === "user"
      )
    ).toHaveLength(1);
    expect(JSON.stringify(local.mainRequests[3]?.messages)).not.toContain(
      "Acquisition done."
    );
    expect(
      result.sessions
        .flatMap((session) => session.turns)
        .map((turn) => turn.review)
    ).toEqual(["flag_disabled", "flag_disabled"]);
    expect(result.evidence.observedUsage).toMatchObject({ requestCount: 5 });
    expect(local.requests).toHaveLength(7);
    expect(
      result.sessions
        .flatMap((session) => session.turns)
        .map((turn) => turn.title)
    ).toEqual([
      { value: "Fixture memory session" },
      { value: "Fixture memory session" },
    ]);
    expect(result.snapshots.map((item) => item.label)).toEqual([
      "training:before",
      "training:after",
      "recall:before",
      "recall:after",
    ]);
  } finally {
    await local.server.stop(true);
  }
}, 45_000);

test("cold recall has neither acquired native memory nor training history after the same A workload", async () => {
  const local = fixture();
  try {
    const result = await runAtlasMemory({
      ...local.request,
      coldControl: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("completed");
    expect(result.nativeEvents.map((event) => event.name)).toEqual([
      "memory_write",
      "write_file",
      "memory_search",
    ]);
    expect(result.sessions[0]?.nativeStateRoot).not.toBe(
      result.sessions[1]?.nativeStateRoot
    );
    expect(result.finalText).not.toContain(USER_FACT);
    expect(JSON.stringify(local.mainRequests[3]?.messages)).not.toContain(
      PROFILE_FACT
    );
    expect(local.requests).toHaveLength(7);
  } finally {
    await local.server.stop(true);
  }
}, 45_000);

test("different user cannot retrieve native user DB memory but shares profile memory by design", async () => {
  const local = fixture();
  try {
    const result = await runAtlasMemory({
      ...local.request,
      recallIdentity: "different-user",
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("completed");
    expect(result.finalText).not.toContain(USER_FACT);
    expect(JSON.stringify(local.mainRequests[3]?.messages)).toContain(
      PROFILE_FACT
    );
  } finally {
    await local.server.stop(true);
  }
}, 45_000);

test("different tenant sees neither previous profile file nor user DB facts", async () => {
  const local = fixture();
  try {
    const result = await runAtlasMemory({
      ...local.request,
      recallIdentity: "different-organization",
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("completed");
    expect(result.finalText).not.toContain(USER_FACT);
    expect(JSON.stringify(local.mainRequests[3]?.messages)).not.toContain(
      PROFILE_FACT
    );
  } finally {
    await local.server.stop(true);
  }
}, 45_000);

test("request validation rejects answer injection, wrong-model evidence and external endpoints", async () => {
  const local = fixture();
  try {
    expect(() =>
      parseMemoryRequest({ ...local.request, expected: { answer: 42 } })
    ).toThrow();
    expect(() =>
      parseMemoryRequest({
        ...local.request,
        proxyBaseUrl: "https://example.com",
      })
    ).toThrow();
    expect(() =>
      parseMemoryRequest({ ...local.request, model: "other-model" })
    ).toThrow();
    expect(() =>
      parseMemoryRequest({
        ...local.request,
        budget: { ...MEMORY_BUDGET, maxProviderRequests: 25 },
      })
    ).toThrow();
  } finally {
    await local.server.stop(true);
  }
});

test("shared deadline during a native auxiliary retains completed writes and the partial session", async () => {
  const local = fixture(2000);
  try {
    const started = performance.now();
    const result = await runAtlasMemory({
      ...local.request,
      budget: { ...MEMORY_BUDGET, timeoutMs: 500 },
    });
    expect(result.status).toBe("budget_exceeded");
    expect(performance.now() - started).toBeLessThan(1500);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.turns[0]?.finalText).toBe("Acquisition done.");
    expect(result.nativeEvents.map((event) => event.name)).toEqual([
      "memory_write",
      "write_file",
    ]);
    expect(result.snapshots.at(-1)?.label).toBe("training:after");
  } finally {
    await local.server.stop(true);
  }
}, 10_000);

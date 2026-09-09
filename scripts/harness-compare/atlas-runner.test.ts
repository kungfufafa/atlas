import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type AtlasComparisonRequest,
  parseAtlasComparisonRequest,
  runAtlasComparison,
} from "./atlas-runner";

const MODEL_ID = "fixture-model-exact";
const PROOF_TEXT = "verified bytes\n";

function createFixture(failAfterWrite = false, reuseCallId = false) {
  const files = new Map<string, string>();
  const requests: Record<string, unknown>[] = [];
  const toolCalls: string[] = [];
  let completionCount = 0;
  const server = Bun.serve({
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/tool-schemas") {
        return Response.json([
          {
            description: "Write text to a workspace file.",
            name: "write_file",
            parameters: {
              additionalProperties: false,
              properties: {
                content: { type: "string" },
                path: { type: "string" },
              },
              required: ["path", "content"],
              type: "object",
            },
          },
          {
            description: "Read text from a workspace file.",
            name: "read_file",
            parameters: {
              additionalProperties: false,
              properties: { path: { type: "string" } },
              required: ["path"],
              type: "object",
            },
          },
        ]);
      }
      if (path.startsWith("/runs/test-run/tools/")) {
        const tool = path.split("/").at(-1)!;
        const input = (await request.json()) as {
          content?: string;
          path: string;
        };
        toolCalls.push(tool);
        if (tool === "write_file") {
          files.set(input.path, input.content!);
          return Response.json({
            bytes: new TextEncoder().encode(input.content).length,
            path: input.path,
          });
        }
        return Response.json({
          content: files.get(input.path),
          path: input.path,
        });
      }
      if (path === "/runs/test-run/v1/chat/completions") {
        const input = (await request.json()) as Record<string, unknown>;
        requests.push(input);
        completionCount += 1;
        if (failAfterWrite && completionCount === 2) {
          return Response.json(
            { error: { message: "controlled provider outage" } },
            { status: 503 }
          );
        }
        const message =
          completionCount <= 2
            ? {
                content: null,
                reasoning_content: "fixture reasoning continuation",
                role: "assistant",
                tool_calls: [
                  {
                    function: {
                      arguments: JSON.stringify(
                        completionCount === 1
                          ? {
                              content: PROOF_TEXT,
                              path: "artifacts/result.txt",
                            }
                          : { path: "artifacts/result.txt" }
                      ),
                      name: completionCount === 1 ? "write_file" : "read_file",
                    },
                    id: reuseCallId
                      ? "reused-call-id"
                      : `call-${completionCount}`,
                    type: "function",
                  },
                ],
              }
            : {
                content:
                  completionCount === 3 ? PROOF_TEXT : "second turn complete",
                role: "assistant",
              };
        return Response.json({
          choices: [
            {
              finish_reason: completionCount <= 2 ? "tool_calls" : "stop",
              index: 0,
              message,
            },
          ],
          created: 1,
          id: `completion-${completionCount}`,
          model: MODEL_ID,
          object: "chat.completion",
          usage: { completion_tokens: 5, prompt_tokens: 20, total_tokens: 25 },
        });
      }
      return new Response("Unknown fixture route", { status: 404 });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const request: AtlasComparisonRequest = {
    model: MODEL_ID,
    modelMetadata: {
      entry: {
        capabilities: {
          "chat.tool-use": {
            source: "runtime-probe",
            status: "supported",
            verified: true,
          },
        },
        id: MODEL_ID,
      },
      evidence: {
        endpoint: server.url.origin,
        model: MODEL_ID,
        observedAt: new Date().toISOString(),
        source: "controlled protocol fixture; not live inference",
      },
    },
    runId: "test-run",
    serverBaseUrl: server.url.origin,
    timeoutMs: 30_000,
    turns: [
      "Write the requested file and verify it with a dependent read.",
      "Keep the earlier result and finish the second turn.",
    ],
  };
  return { files, request, requests, server, toolCalls };
}

test("production adapter preserves dependent tool receipts and both turns in isolated SQLite", async () => {
  const fixture = createFixture(false, true);
  try {
    const result = await runAtlasComparison(fixture.request);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe("completed");
    expect(fixture.toolCalls).toEqual(["write_file", "read_file"]);
    expect(fixture.files.get("artifacts/result.txt")).toBe(PROOF_TEXT);
    expect(result.turnResults).toHaveLength(2);
    expect(result.finalText).toBe("second turn complete");
    expect(result.toolEvents.map((event) => event.name)).toEqual([
      "write_file",
      "read_file",
    ]);
    expect(result.toolEvents[1]?.result).toEqual({
      content: PROOF_TEXT,
      path: "artifacts/result.txt",
    });
    expect(result.persistedMessages.map((message) => message.payload)).toEqual([
      ...result.history,
    ]);
    expect(
      result.history.filter((message) => message.role === "user")
    ).toHaveLength(2);
    expect(result.usage).toMatchObject({
      inputTokens: 80,
      outputTokens: 20,
      requestCount: 4,
    });
    expect(
      fixture.requests.every((request) => request.model === MODEL_ID)
    ).toBe(true);
    expect(fixture.requests[1]?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reasoning_content: "fixture reasoning continuation",
          role: "assistant",
        }),
      ])
    );
    expect(result.isolatedConfigDir).toBeDefined();
    expect(
      (await readFile(join(result.isolatedConfigDir!, "comparison.sqlite")))
        .byteLength
    ).toBeGreaterThan(0);
  } finally {
    fixture.server.stop(true);
  }
}, 40_000);

test("production adapter retains a completed effect when the next provider request fails", async () => {
  const fixture = createFixture(true);
  try {
    const result = await runAtlasComparison(fixture.request);
    expect(result.status).toBe("failed");
    expect(fixture.toolCalls).toEqual(["write_file"]);
    expect(fixture.files.get("artifacts/result.txt")).toBe(PROOF_TEXT);
    expect(result.toolEvents).toHaveLength(1);
    expect(result.toolEvents[0]?.isError).toBe(false);
    expect(result.persistedMessages.map((message) => message.payload)).toEqual([
      ...result.history,
    ]);
    expect(
      result.history.filter((message) => message.role === "tool")
    ).toHaveLength(1);
    expect(result.turnResults).toHaveLength(1);
    expect(result.turnResults[0]?.status).toBe("failed");
    expect(result.finalText).toBe("");
  } finally {
    fixture.server.stop(true);
  }
}, 40_000);

test("comparison request refuses a direct provider endpoint or mismatched metadata", () => {
  const fixture = createFixture();
  try {
    expect(() =>
      parseAtlasComparisonRequest({
        ...fixture.request,
        serverBaseUrl: "https://provider.example",
      })
    ).toThrow();
    expect(() =>
      parseAtlasComparisonRequest({
        ...fixture.request,
        model: "different-model",
      })
    ).toThrow();
  } finally {
    fixture.server.stop(true);
  }
});

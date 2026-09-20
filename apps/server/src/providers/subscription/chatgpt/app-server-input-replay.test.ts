import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { JsonRpcStdioClient, type JsonRpcStdioProcess } from "../jsonrpc-stdio";
import { CodexAppServer, type CodexTurnInput } from "./app-server";
import {
  CodexTurnInputTooLargeError,
  MAX_CODEX_TURN_TEXT_CHARS,
} from "./input-replay";

class FakeProcess extends EventEmitter implements JsonRpcStdioProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  kill(): void {
    this.emit("exit", 0);
  }
}

interface RpcRequest {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

const servers: CodexAppServer[] = [];
afterEach(() => {
  for (const server of servers) {
    server.close();
  }
  servers.length = 0;
});

function harness(
  runtimeVersion: string | undefined,
  onRequest?: (request: RpcRequest, send: (message: unknown) => void) => void
) {
  const child = new FakeProcess();
  const requests: RpcRequest[] = [];
  const client = new JsonRpcStdioClient(child);
  const send = (message: unknown) => {
    child.stdout.write(`${JSON.stringify(message)}\n`);
  };
  child.stdin.on("data", (chunk) => {
    for (const line of String(chunk).trim().split("\n")) {
      const request = JSON.parse(line) as RpcRequest;
      if (typeof request.method !== "string") {
        continue;
      }
      requests.push(request);
      if (onRequest) {
        onRequest(request, send);
      } else {
        send({ id: request.id, result: {} });
      }
    }
  });
  const server = new CodexAppServer({
    client,
    runtimeVersion,
    turnTimeoutMs: 1000,
  });
  servers.push(server);
  return { client, requests, send, server };
}

test("rejects oversized input before sending RPC or registering tool handlers", async () => {
  const h = harness(undefined);
  let calls = 0;
  await expect(
    h.server.startTurn({
      input: "x".repeat(MAX_CODEX_TURN_TEXT_CHARS + 1),
      onToolCall: async () => {
        calls += 1;
        return { contentItems: [], success: true };
      },
      threadId: "large-input",
    })
  ).rejects.toBeInstanceOf(CodexTurnInputTooLargeError);
  expect(h.requests).toHaveLength(0);
  expect(calls).toBe(0);
  const unregister = h.client.onRequest("item/tool/call", async () => null);
  unregister();
});

test("accepts exact-cap Unicode input and completes a native turn", async () => {
  const h = harness("0.150.1", (request, send) => {
    send({ id: request.id, result: { turn: { id: "boundary-turn" } } });
    send({
      method: "turn/completed",
      params: {
        threadId: "boundary-thread",
        turn: { id: "boundary-turn", status: "completed" },
      },
    });
  });
  const input: CodexTurnInput[] = [
    {
      text: "a".repeat(MAX_CODEX_TURN_TEXT_CHARS - 1),
      text_elements: [],
      type: "text",
    },
    { text: "😀", text_elements: [], type: "text" },
  ];
  await expect(
    h.server.startTurn({ input, threadId: "boundary-thread" })
  ).resolves.toMatchObject({ text: "" });
  expect(h.requests).toHaveLength(1);
  expect(h.requests[0]).toMatchObject({
    method: "turn/start",
    params: { input },
  });
});

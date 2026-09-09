import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate as nextTick } from "node:timers/promises";
import { JsonRpcStdioClient, type JsonRpcStdioProcess } from "../jsonrpc-stdio";
import {
  CodexAppServer,
  type CodexDynamicToolResult,
  initializeCodexClient,
} from "./app-server";

class FakeProcess extends EventEmitter implements JsonRpcStdioProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  kill(): void {
    this.emit("exit", 0);
  }
}

interface RpcMessage {
  error?: { code: number };
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
}

const servers: CodexAppServer[] = [];

function fixture(
  options: {
    delayStart?: boolean;
    runtimeVersion?: string | null;
    turnTimeoutMs?: number;
  } = {}
) {
  const child = new FakeProcess();
  const messages: RpcMessage[] = [];
  const send = (message: unknown) => {
    child.stdout.write(`${JSON.stringify(message)}\n`);
  };
  child.stdin.on("data", (chunk) => {
    for (const line of String(chunk).trim().split("\n")) {
      const message: RpcMessage = JSON.parse(line);
      messages.push(message);
      if (message.method === "turn/start" && !options.delayStart) {
        send({
          id: message.id,
          result: { turn: { id: `turn-${message.params?.threadId}` } },
        });
      }
      if (message.method === "turn/interrupt") {
        send({ id: message.id, result: {} });
      }
      if (message.method === "thread/start") {
        send({ id: message.id, result: { thread: { id: "thread" } } });
      }
    }
  });
  const server = new CodexAppServer({
    client: new JsonRpcStdioClient(child),
    runtimeVersion:
      options.runtimeVersion === null
        ? undefined
        : (options.runtimeVersion ?? "0.150.1"),
    turnTimeoutMs: options.turnTimeoutMs ?? 1000,
  });
  servers.push(server);
  const call = (id: string, overrides: Record<string, unknown> = {}) =>
    send({
      id,
      method: "item/tool/call",
      params: {
        arguments: { path: "example.txt" },
        callId: id,
        threadId: "thread",
        tool: "read_file",
        turnId: "turn-thread",
        ...overrides,
      },
    });
  const complete = (threadId = "thread") =>
    send({
      method: "turn/completed",
      params: {
        threadId,
        turn: { id: `turn-${threadId}`, status: "completed" },
      },
    });
  return { call, child, complete, messages, send, server };
}

function output(text: string): CodexDynamicToolResult {
  return { contentItems: [{ text, type: "inputText" }], success: true };
}

afterEach(() => {
  for (const server of servers) {
    server.close();
  }
  servers.length = 0;
});

describe("Codex structured Atlas tools", () => {
  test("negotiates experimental methods before declaring the client initialized", async () => {
    const child = new FakeProcess();
    const client = new JsonRpcStdioClient(child);
    const messages: RpcMessage[] = [];
    child.stdin.on("data", (chunk) => {
      const message: RpcMessage = JSON.parse(String(chunk));
      messages.push(message);
      if (message.method === "initialize") {
        child.stdout.write(
          `${JSON.stringify({ id: message.id, result: { userAgent: "atlas/0.150.1 (Mac OS 27.0.0; arm64) unknown (atlas; 1)" } })}\n`
        );
      }
    });
    const version = await initializeCodexClient(client);
    expect(version).toBe("0.150.1");
    expect(messages[0]).toMatchObject({
      method: "initialize",
      params: { capabilities: { experimentalApi: true } },
    });
    expect(messages[1]).toEqual({ method: "initialized" });
    client.close();
  });

  test.each([null, "0.149.0", "0.150.2"])(
    "rejects unverified structured protocol version %s before starting work",
    async (runtimeVersion) => {
      const f = fixture({ runtimeVersion });
      await expect(
        f.server.startThread({ cwd: "/tmp/atlas", dynamicTools: [] })
      ).rejects.toBeInstanceOf(Error);
      await expect(
        f.server.startTurn({
          input: "go",
          onToolCall: async () => output("done"),
          threadId: "thread",
        })
      ).rejects.toBeInstanceOf(Error);
      expect(f.messages).toHaveLength(0);
    }
  );

  test("registers experimental 0.150.1 function specs while retaining native tool isolation", async () => {
    const f = fixture();
    const dynamicTools = [
      {
        description: "Read a file",
        inputSchema: { type: "object" },
        name: "read_file",
        type: "function" as const,
      },
    ];
    await f.server.startThread({ cwd: "/tmp/atlas", dynamicTools });
    expect(f.messages[0]).toMatchObject({
      method: "thread/start",
      params: {
        approvalPolicy: "never",
        config: {
          features: {
            apps: false,
            image_generation: false,
            plugins: false,
            shell_tool: false,
            unified_exec: false,
          },
          mcp_servers: {},
          web_search: "disabled",
        },
        dynamicTools,
        sandbox: "read-only",
      },
    });
  });

  test("continues multiple tools within one native turn and returns typed results", async () => {
    const f = fixture();
    const calls: string[] = [];
    const turn = f.server.startTurn({
      input: "Read then compare",
      onToolCall: async (call) => {
        calls.push(call.tool);
        return output(
          call.tool === "read_file" ? "file contents" : "comparison"
        );
      },
      threadId: "thread",
    });
    await nextTick();
    f.call("read");
    await nextTick();
    f.call("compare", { tool: "compare_files" });
    await nextTick();
    f.send({
      method: "item/agentMessage/delta",
      params: { delta: "Compared.", threadId: "thread", turnId: "turn-thread" },
    });
    f.complete();
    await expect(turn).resolves.toMatchObject({ text: "Compared." });
    expect(calls).toEqual(["read_file", "compare_files"]);
    expect(f.messages.filter((message) => message.result)).toEqual([
      { id: "read", result: output("file contents") },
      { id: "compare", result: output("comparison") },
    ]);
    expect(
      f.messages.filter((message) => message.method === "turn/start")
    ).toHaveLength(1);
  });

  test("waits for the turn id and routes concurrent threads independently", async () => {
    const f = fixture({ delayStart: true });
    const calls: string[] = [];
    const turns = ["alpha", "beta"].map((threadId) =>
      f.server.startTurn({
        input: "go",
        onToolCall: async (call) => {
          calls.push(call.threadId);
          return output(call.threadId);
        },
        threadId,
      })
    );
    await nextTick();
    f.call("early", { threadId: "alpha", turnId: "turn-alpha" });
    await nextTick();
    expect(calls).toHaveLength(0);
    for (const request of f.messages.filter(
      (message) => message.method === "turn/start"
    )) {
      f.send({
        id: request.id,
        result: { turn: { id: `turn-${request.params?.threadId}` } },
      });
    }
    f.call("beta", { threadId: "beta", turnId: "turn-beta" });
    f.call("wrong-turn", { threadId: "alpha", turnId: "turn-beta" });
    f.call("wrong-thread", { threadId: "unknown" });
    f.call("namespace", {
      namespace: "native",
      threadId: "alpha",
      turnId: "turn-alpha",
    });
    await nextTick();
    expect(calls.toSorted()).toEqual(["alpha", "beta"]);
    for (const id of ["wrong-turn", "wrong-thread", "namespace"]) {
      expect(f.messages.find((message) => message.id === id)).toMatchObject({
        error: { code: -32_603 },
      });
    }
    f.complete("alpha");
    f.complete("beta");
    await Promise.all(turns);
  });

  test("deduplicates a call id across pending and completed RPC request ids", async () => {
    const f = fixture();
    let finish: () => void = () => undefined;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let calls = 0;
    const turn = f.server.startTurn({
      input: "go",
      onToolCall: async () => {
        calls += 1;
        await wait;
        return output("done");
      },
      threadId: "thread",
    });
    await nextTick();
    f.call("rpc-1", { callId: "action" });
    f.call("rpc-2", { callId: "action" });
    await nextTick();
    expect(calls).toBe(1);
    finish();
    await nextTick();
    f.call("rpc-3", { callId: "action" });
    await nextTick();
    expect(calls).toBe(1);
    expect(f.messages.filter((message) => message.result)).toHaveLength(3);
    f.complete();
    await turn;
  });

  test("rejects conflicting call ids before dispatching a second action", async () => {
    const f = fixture();
    let calls = 0;
    const turn = f.server.startTurn({
      input: "go",
      onToolCall: async () => {
        calls += 1;
        return output("done");
      },
      threadId: "thread",
    });
    await nextTick();
    f.call("rpc-1", { callId: "action" });
    await nextTick();
    const rejected = turn.catch((error: unknown) => error);
    f.call("rpc-2", { arguments: { path: "other.txt" }, callId: "action" });
    expect(await rejected).toBeInstanceOf(Error);
    await nextTick();
    expect(calls).toBe(1);
    expect(
      f.messages.filter((message) => message.method === "turn/interrupt")
    ).toHaveLength(1);
  });

  test("preserves approval suspension identity and prevents queued dispatch", async () => {
    const f = fixture();
    const suspension = new Error("Approval pending");
    let finish: () => void = () => undefined;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const calls: string[] = [];
    const turn = f.server.startTurn({
      input: "go",
      onToolCall: async (call) => {
        calls.push(call.callId);
        await wait;
        throw suspension;
      },
      threadId: "thread",
    });
    await nextTick();
    f.call("approval");
    f.call("queued");
    await nextTick();
    const rejected = turn.catch((error: unknown) => error);
    finish();
    expect(await rejected).toBe(suspension);
    await nextTick();
    expect(calls).toEqual(["approval"]);
    expect(
      f.messages.filter((message) => message.method === "turn/interrupt")
    ).toHaveLength(1);
    expect(f.messages.filter((message) => message.error)).toHaveLength(2);
  });

  test("aborts running tool signals and blocks queued actions after cancellation", async () => {
    const f = fixture();
    const controller = new AbortController();
    let toolSignal: AbortSignal | undefined;
    let finish: () => void = () => undefined;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let calls = 0;
    const turn = f.server.startTurn({
      input: "go",
      onToolCall: async (_call, signal) => {
        calls += 1;
        toolSignal = signal;
        await wait;
        return output("done");
      },
      signal: controller.signal,
      threadId: "thread",
    });
    await nextTick();
    f.call("running");
    f.call("queued");
    await nextTick();
    const rejected = turn.catch((error: unknown) => error);
    controller.abort();
    expect(await rejected).toBeInstanceOf(Error);
    expect(toolSignal?.aborted).toBe(true);
    finish();
    await nextTick();
    expect(calls).toBe(1);
    f.call("late");
    await nextTick();
    expect(f.messages.find((message) => message.id === "late")).toMatchObject({
      error: { code: -32_603 },
    });
  });

  test("rejects completion while an Atlas tool is unfinished", async () => {
    const f = fixture();
    let finish: () => void = () => undefined;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const turn = f.server.startTurn({
      input: "go",
      onToolCall: async () => {
        await wait;
        return output("done");
      },
      threadId: "thread",
    });
    await nextTick();
    f.call("unfinished");
    await nextTick();
    const rejected = turn.catch((error: unknown) => error);
    f.complete();
    expect(await rejected).toBeInstanceOf(Error);
    finish();
    await nextTick();
  });

  test("does not send results or reconnect when a callback finishes after process exit", async () => {
    const f = fixture();
    let finish: () => void = () => undefined;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let signal: AbortSignal | undefined;
    const turn = f.server.startTurn({
      input: "go",
      onToolCall: async (_call, toolSignal) => {
        signal = toolSignal;
        await wait;
        return output("finished");
      },
      threadId: "thread",
    });
    await nextTick();
    f.call("running");
    await nextTick();
    const rejected = turn.catch((error: unknown) => error);
    f.child.emit("exit", 1);
    expect(await rejected).toBeInstanceOf(Error);
    expect(signal?.aborted).toBe(true);
    finish();
    await nextTick();
    expect(f.server.isConnected()).toBe(false);
    expect(
      f.messages.filter(
        (message) => message.result || message.method === "turn/interrupt"
      )
    ).toHaveLength(0);
  });
});

test("the native inference deadline pauses while an Atlas tool waits for approval", async () => {
  const context = fixture({ turnTimeoutMs: 50 });
  const ready = Promise.withResolvers<void>();
  const turn = context.server.startTurn({
    input: "Read",
    async onToolCall(_call, signal) {
      ready.resolve();
      await Bun.sleep(100);
      expect(signal.aborted).toBe(false);
      return output("Approved result");
    },
    threadId: "thread",
  });
  await nextTick();
  context.call("approval-call");
  await ready.promise;
  // Complete only after the RPC response actually crossed the transport.
  await new Promise<void>((resolve) => {
    const onData = (chunk: unknown) => {
      if (String(chunk).includes('"result"')) {
        context.child.stdin.off("data", onData);
        resolve();
      }
    };
    context.child.stdin.on("data", onData);
  });
  context.complete();
  await expect(turn).resolves.toMatchObject({ text: "" });
});

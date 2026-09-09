import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setImmediate as nextTick } from "node:timers/promises";
import {
  JsonRpcResponseError,
  JsonRpcStdioClient,
  type JsonRpcStdioProcess,
} from "./jsonrpc-stdio";

class FakeProcess extends EventEmitter implements JsonRpcStdioProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  pid = 1;
  kill(): void {
    this.emit("exit", 0);
  }
}

describe("JsonRpcStdioClient", () => {
  test("matches JSON-RPC responses by id and forwards notifications", async () => {
    const child = new FakeProcess();
    const client = new JsonRpcStdioClient(child);
    const notifications: string[] = [];
    client.onNotification((notification) => {
      notifications.push(notification.method);
    });

    child.stdin.on("data", (chunk) => {
      const message = JSON.parse(String(chunk).trim()) as {
        id: number;
        method: string;
      };
      expect(message.method).toBe("account/read");
      child.stdout.write(
        `${JSON.stringify({ id: message.id, result: { ok: true } })}\n`
      );
      child.stdout.write(
        `${JSON.stringify({ method: "account/login/completed", params: { success: true } })}\n`
      );
    });

    const result = await client.request("account/read", {
      refreshToken: false,
    });
    expect(result).toEqual({ ok: true });
    expect(notifications).toContain("account/login/completed");
    client.close();
  });

  test("rejects server-initiated requests without resolving a client request", async () => {
    const child = new FakeProcess();
    const client = new JsonRpcStdioClient(child);
    const outbound: Array<Record<string, unknown>> = [];

    child.stdin.on("data", (chunk) => {
      for (const line of String(chunk).trim().split("\n")) {
        const message = JSON.parse(line) as Record<string, unknown>;
        outbound.push(message);
        if (message.method === "account/read") {
          child.stdout.write(
            `${JSON.stringify({ id: message.id, method: "item/requestApproval", params: {} })}\n`
          );
        } else if (message.error) {
          child.stdout.write(
            `${JSON.stringify({ id: 1, result: { account: null } })}\n`
          );
        }
      }
    });

    await expect(client.request("account/read")).resolves.toEqual({
      account: null,
    });
    expect(outbound.at(1)).toMatchObject({
      error: {
        code: -32_601,
        message: "Server-initiated requests are not supported.",
      },
      id: 1,
    });
    client.close();
  });

  test("retains structured response errors without confusing server requests", async () => {
    const child = new FakeProcess();
    const client = new JsonRpcStdioClient(child);
    const outbound = recordResponses(child);
    const data = {
      actual_chars: 1_048_577,
      input_error_code: "input_too_large",
      max_chars: 1_048_576,
    };
    const message = "The supplied input is too large.";
    let toolCalls = 0;
    client.onRequest("item/tool/call", async () => {
      toolCalls += 1;
      return { completed: true };
    });
    const pending = client
      .request("turn/start")
      .catch((error: unknown) => error);
    serverRequest(child, 1, { error: { code: -32_602, data, message } });
    await nextTick();
    expect(toolCalls).toBe(1);
    expect(outbound.at(-1)).toEqual({ id: 1, result: { completed: true } });
    child.stdout.write(
      `${JSON.stringify({ error: { code: -32_602, data, message }, id: 1 })}\n`
    );
    const error = await pending;
    expect(error).toBeInstanceOf(JsonRpcResponseError);
    expect(error).toMatchObject({
      code: -32_602,
      data,
      message,
      method: "turn/start",
    });
    expect(client.isClosed()).toBe(false);
    client.close();
  });

  test.each([
    [{ message: "Provider unavailable" }, "Provider unavailable"],
    [{ code: "invalid", data: null }, "Runtime request failed."],
  ])(
    "preserves existing response messages when metadata is absent or malformed",
    async (payload, message) => {
      const child = new FakeProcess();
      const client = new JsonRpcStdioClient(child);
      const pending = client
        .request("account/read")
        .catch((error: unknown) => error);
      child.stdout.write(`${JSON.stringify({ error: payload, id: 1 })}\n`);
      const error = await pending;
      expect(error).toBeInstanceOf(JsonRpcResponseError);
      expect(error).toMatchObject({
        code: undefined,
        message,
        method: "account/read",
      });
      if (error instanceof JsonRpcResponseError) {
        expect(error.data).toBe("data" in payload ? payload.data : undefined);
      }
      client.close();
    }
  );

  test("times out requests and reports closed clients", async () => {
    const child = new FakeProcess();
    const client = new JsonRpcStdioClient(child, { requestTimeoutMs: 5 });

    await expect(client.request("account/read")).rejects.toThrow(
      "Runtime request timed out: account/read"
    );
    expect(client.isClosed()).toBe(false);

    client.close();
    expect(client.isClosed()).toBe(true);
    await expect(client.request("account/read")).rejects.toThrow(
      "Runtime process is not running."
    );
  });

  test("notifies close listeners once when the runtime exits", () => {
    const child = new FakeProcess();
    const client = new JsonRpcStdioClient(child);
    const errors: string[] = [];
    client.onClose((error) => {
      errors.push(error.message);
    });

    child.emit("exit", 1);
    child.emit("error", new Error("second failure"));

    expect(errors).toEqual(["Runtime process exited."]);
    expect(client.isClosed()).toBe(true);

    const lateErrors: string[] = [];
    client.onClose((error) => lateErrors.push(error.message));
    expect(lateErrors).toEqual(["Runtime process is not running."]);
  });
});

function recordResponses(child: FakeProcess): Record<string, unknown>[] {
  const responses: Record<string, unknown>[] = [];
  child.stdin.on("data", (chunk) => {
    for (const line of String(chunk).trim().split("\n")) {
      responses.push(JSON.parse(line));
    }
  });
  return responses;
}

function serverRequest(
  child: FakeProcess,
  id: unknown,
  params: unknown = {}
): void {
  child.stdout.write(
    `${JSON.stringify({ id, method: "item/tool/call", params })}\n`
  );
}

describe("JSON-RPC server requests", () => {
  test("responds to string and integer ids and unregisters handlers", async () => {
    const child = new FakeProcess();
    const client = new JsonRpcStdioClient(child);
    const responses = recordResponses(child);
    const unregister = client.onRequest(
      "item/tool/call",
      async (params) => params
    );

    serverRequest(child, "server-1", { answer: 42 });
    serverRequest(child, -4, { answer: 43 });
    await nextTick();
    expect(responses).toEqual([
      { id: "server-1", result: { answer: 42 } },
      { id: -4, result: { answer: 43 } },
    ]);
    unregister();
    serverRequest(child, "server-2");
    expect(responses.at(-1)).toMatchObject({
      error: { code: -32_601 },
      id: "server-2",
    });
    client.close();
  });

  test("rejects invalid ids before invoking handlers", () => {
    const child = new FakeProcess();
    const client = new JsonRpcStdioClient(child);
    const responses = recordResponses(child);
    let called = 0;
    client.onRequest("item/tool/call", async () => {
      called += 1;
    });
    for (const id of [null, {}, [], true, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      serverRequest(child, id);
    }
    expect(called).toBe(0);
    expect(responses).toHaveLength(6);
    for (const response of responses) {
      expect(response).toMatchObject({ error: { code: -32_600 }, id: null });
    }
    client.close();
  });

  test("deduplicates pending requests and replays their completed result", async () => {
    const child = new FakeProcess();
    const client = new JsonRpcStdioClient(child);
    const responses = recordResponses(child);
    let finish: (value: unknown) => void = () => undefined;
    const result = new Promise((resolve) => {
      finish = resolve;
    });
    let calls = 0;
    client.onRequest("item/tool/call", async () => {
      calls += 1;
      return await result;
    });
    serverRequest(child, 9, { path: "one" });
    serverRequest(child, 9, { path: "one" });
    expect(calls).toBe(1);
    expect(responses).toHaveLength(0);
    finish({ written: true });
    await nextTick();
    serverRequest(child, 9, { path: "one" });
    expect(calls).toBe(1);
    expect(responses).toEqual([
      { id: 9, result: { written: true } },
      { id: 9, result: { written: true } },
    ]);
    client.close();
  });

  test("closes on conflicting duplicate ids and aborts the pending action", async () => {
    const child = new FakeProcess();
    const client = new JsonRpcStdioClient(child);
    const responses = recordResponses(child);
    let signal: AbortSignal | undefined;
    let finish: () => void = () => undefined;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    client.onRequest("item/tool/call", async (_params, requestSignal) => {
      signal = requestSignal;
      await wait;
      return { written: true };
    });
    serverRequest(child, "duplicate", { path: "one" });
    serverRequest(child, "duplicate", { path: "two" });
    expect(client.isClosed()).toBe(true);
    expect(signal?.aborted).toBe(true);
    finish();
    await nextTick();
    expect(responses).toHaveLength(0);
  });

  test("contains async handler failures without returning sensitive errors", async () => {
    const child = new FakeProcess();
    const client = new JsonRpcStdioClient(child);
    const responses = recordResponses(child);
    client.onRequest("item/tool/call", async () => {
      await nextTick();
      throw new Error("secret-token");
    });
    serverRequest(child, "failure");
    await nextTick();
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      error: { code: -32_603 },
      id: "failure",
    });
    expect(JSON.stringify(responses)).not.toContain("secret-token");
    client.close();
  });

  test("unregistering aborts pending handlers and suppresses late responses", async () => {
    const child = new FakeProcess();
    const client = new JsonRpcStdioClient(child);
    const responses = recordResponses(child);
    let signal: AbortSignal | undefined;
    let finish: () => void = () => undefined;
    const wait = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const unregister = client.onRequest(
      "item/tool/call",
      async (_params, requestSignal) => {
        signal = requestSignal;
        await wait;
      }
    );
    serverRequest(child, "pending");
    unregister();
    expect(signal?.aborted).toBe(true);
    finish();
    await nextTick();
    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({
      error: { code: -32_000 },
      id: "pending",
    });
    client.close();
  });
});

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { JsonRpcStdioClient, type JsonRpcStdioProcess } from "./jsonrpc-stdio";

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

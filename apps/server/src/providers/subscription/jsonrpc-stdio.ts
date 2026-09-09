import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface JsonRpcNotification {
  method: string;
  params: unknown;
}

export interface JsonRpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcStdioClientOptions {
  requestTimeoutMs?: number;
}

export type JsonRpcRequestId = number | string;
export type JsonRpcRequestHandler = (
  params: unknown,
  signal: AbortSignal
) => Promise<unknown>;

interface ServerRequestState {
  controller: AbortController;
  fingerprint: string;
  method: string;
  response?: unknown;
}

const MAX_COMPLETED_SERVER_REQUESTS = 256;

export type JsonRpcMessage =
  | { id: number; result: unknown }
  | {
      error: { code?: number; data?: unknown; message?: string };
      id: number | null;
    }
  | JsonRpcNotification;

export class JsonRpcResponseError extends Error {
  readonly code: number | undefined;
  readonly data: unknown;
  readonly method: string;

  constructor(
    method: string,
    error: { code?: unknown; data?: unknown; message?: unknown }
  ) {
    super(
      typeof error.message === "string"
        ? error.message
        : "Runtime request failed."
    );
    this.name = "JsonRpcResponseError";
    this.method = method;
    this.code = typeof error.code === "number" ? error.code : undefined;
    this.data = error.data;
  }
}

export interface JsonRpcStdioProcess {
  kill(signal?: NodeJS.Signals): void;
  on(event: "exit", listener: (code: number | null) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  pid?: number;
  stderr: NodeJS.ReadableStream | null;
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
}

export class JsonRpcStdioClient {
  private closed = false;
  private nextId = 1;
  private processExited = false;
  private readonly pending = new Map<
    number,
    {
      method: string;
      reject: (error: Error) => void;
      resolve: (value: unknown) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly notificationListeners = new Set<
    (notification: JsonRpcNotification) => void
  >();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private readonly requestHandlers = new Map<string, JsonRpcRequestHandler>();
  private readonly serverRequests = new Map<
    JsonRpcRequestId,
    ServerRequestState
  >();

  private readonly requestTimeoutMs: number;

  constructor(
    private readonly child: JsonRpcStdioProcess,
    options: JsonRpcStdioClientOptions = {}
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    const reader = createInterface({ input: child.stdout });
    reader.on("line", (line) => {
      this.handleLine(line);
    });
    child.stderr?.on("data", () => {
      // Intentionally unused: never log runtime stderr (may contain secrets).
    });
    child.on("exit", () => {
      this.processExited = true;
      this.failAll(new Error("Runtime process exited."));
    });
    child.on("error", (error) => {
      this.failAll(error);
    });
    child.stdin.on("error", (error: Error) => {
      this.failAll(error);
    });
  }

  onNotification(
    listener: (notification: JsonRpcNotification) => void
  ): () => void {
    this.notificationListeners.add(listener);
    return () => {
      this.notificationListeners.delete(listener);
    };
  }

  onClose(listener: (error: Error) => void): () => void {
    if (this.closed) {
      listener(new Error("Runtime process is not running."));
      return () => undefined;
    }
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  isClosed(): boolean {
    return this.closed;
  }

  onRequest(method: string, handler: JsonRpcRequestHandler): () => void {
    if (this.closed || this.requestHandlers.has(method)) {
      throw new Error(`Cannot register runtime request handler: ${method}`);
    }
    this.requestHandlers.set(method, handler);
    return () => {
      if (this.requestHandlers.get(method) !== handler) {
        return;
      }
      this.requestHandlers.delete(method);
      for (const [id, state] of this.serverRequests) {
        if (state.method === method && state.response === undefined) {
          state.controller.abort();
          this.finishServerRequest(id, state, {
            error: {
              code: -32_000,
              message: "Runtime request handler removed.",
            },
            id,
          });
        }
      }
    };
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) {
      throw new Error("Runtime process is not running.");
    }
    const id = this.nextId;
    this.nextId += 1;
    const payload: JsonRpcRequest = { id, method };
    if (params !== undefined) {
      payload.params = params;
    }
    const result = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Runtime request timed out: ${method}`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { method, reject, resolve, timeout });
    });
    try {
      this.write(payload);
    } catch (error) {
      const waiter = this.pending.get(id);
      if (waiter) {
        clearTimeout(waiter.timeout);
        this.pending.delete(id);
        waiter.reject(
          error instanceof Error ? error : new Error(String(error))
        );
      }
    }
    return result;
  }

  notify(method: string, params?: unknown): void {
    const payload: { method: string; params?: unknown } = { method };
    if (params !== undefined) {
      payload.params = params;
    }
    this.write(payload);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.failAll(new Error("Runtime process closed."));
    this.child.kill("SIGTERM");
    const forceKillTimeout = setTimeout(() => {
      if (!this.processExited) {
        this.child.kill("SIGKILL");
      }
    }, 1000);
    forceKillTimeout.unref?.();
  }

  private write(payload: unknown): void {
    if (this.closed) {
      throw new Error("Runtime process is not running.");
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handleLine(line: string): void {
    if (this.closed) {
      return;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.method === "string" && record.id !== undefined) {
      this.handleServerRequest(record);
      return;
    }
    if (typeof record.method === "string") {
      const notification = {
        method: record.method,
        params: record.params,
      };
      for (const listener of this.notificationListeners) {
        listener(notification);
      }
      return;
    }
    if (typeof record.id !== "number") {
      return;
    }
    const waiter = this.pending.get(record.id);
    if (!waiter) {
      return;
    }
    this.pending.delete(record.id);
    clearTimeout(waiter.timeout);
    if (record.error && typeof record.error === "object") {
      waiter.reject(new JsonRpcResponseError(waiter.method, record.error));
      return;
    }
    waiter.resolve(record.result);
  }

  private handleServerRequest(record: Record<string, unknown>): void {
    const { id, method } = record;
    if (!isRequestId(id)) {
      this.respond({
        error: { code: -32_600, message: "Invalid request id." },
        id: null,
      });
      return;
    }
    const fingerprint = JSON.stringify([method, record.params]);
    const previous = this.serverRequests.get(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        // An id collision cannot safely be correlated with either operation.
        this.close();
      } else if (previous.response !== undefined) {
        this.respond(previous.response);
      }
      return;
    }
    const handler =
      typeof method === "string" ? this.requestHandlers.get(method) : undefined;
    if (!handler) {
      this.respond({
        error: {
          code: -32_601,
          message: "Server-initiated requests are not supported.",
        },
        id,
      });
      return;
    }
    const state: ServerRequestState = {
      controller: new AbortController(),
      fingerprint,
      method: String(method),
    };
    this.serverRequests.set(id, state);
    void this.executeServerRequest(id, record.params, handler, state);
  }

  private async executeServerRequest(
    id: JsonRpcRequestId,
    params: unknown,
    handler: JsonRpcRequestHandler,
    state: ServerRequestState
  ): Promise<void> {
    let response: unknown;
    try {
      const result = await handler(params, state.controller.signal);
      response = { id, result: result ?? null };
    } catch {
      // Handler errors can contain local paths or credentials. The caller's
      // lifecycle owns the original error; only a generic RPC error is sent.
      response = {
        error: { code: -32_603, message: "Runtime request failed." },
        id,
      };
    }
    this.finishServerRequest(id, state, response);
  }

  private finishServerRequest(
    id: JsonRpcRequestId,
    state: ServerRequestState,
    response: unknown
  ): void {
    if (
      this.closed ||
      state.response !== undefined ||
      this.serverRequests.get(id) !== state
    ) {
      return;
    }
    state.response = response;
    this.respond(response);
    let completed = 0;
    for (const request of this.serverRequests.values()) {
      if (request.response !== undefined) {
        completed += 1;
      }
    }
    for (const [requestId, request] of this.serverRequests) {
      if (completed <= MAX_COMPLETED_SERVER_REQUESTS) {
        break;
      }
      if (request.response !== undefined) {
        this.serverRequests.delete(requestId);
        completed -= 1;
      }
    }
  }

  private respond(response: unknown): void {
    try {
      this.write(response);
    } catch (error) {
      this.failAll(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private failAll(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.pending.clear();
    for (const request of this.serverRequests.values()) {
      request.controller.abort();
    }
    this.serverRequests.clear();
    this.requestHandlers.clear();
    for (const listener of this.closeListeners) {
      listener(error);
    }
    this.closeListeners.clear();
    this.notificationListeners.clear();
  }
}

function isRequestId(value: unknown): value is JsonRpcRequestId {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

export function spawnJsonRpcProcess(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv
): JsonRpcStdioProcess {
  const child: ChildProcessWithoutNullStreams = spawn(command, args, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  return child;
}

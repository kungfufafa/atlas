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

export type JsonRpcMessage =
  | { id: number; result: unknown }
  | { error: { code?: number; message?: string }; id: number | null }
  | JsonRpcNotification;

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
      reject: (error: Error) => void;
      resolve: (value: unknown) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly notificationListeners = new Set<
    (notification: JsonRpcNotification) => void
  >();
  private readonly closeListeners = new Set<(error: Error) => void>();

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
      this.pending.set(id, { reject, resolve, timeout });
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
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handleLine(line: string): void {
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
    if (!parsed || typeof parsed !== "object") {
      return;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.method === "string" && record.id !== undefined) {
      this.write({
        error: {
          code: -32_601,
          message: "Server-initiated requests are not supported.",
        },
        id: record.id,
      });
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
      const error = record.error as { message?: unknown };
      waiter.reject(
        new Error(
          typeof error.message === "string"
            ? error.message
            : "Runtime request failed."
        )
      );
      return;
    }
    waiter.resolve(record.result);
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
    for (const listener of this.closeListeners) {
      listener(error);
    }
    this.closeListeners.clear();
    this.notificationListeners.clear();
  }
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

import { join } from "node:path";
import { type Subprocess, spawn } from "bun";
import { ATLAS_API_VERSION } from "../../packages/core/src/contract";
import { redactStringValue } from "../../packages/core/src/secret-redaction";
import type { ProvisionedEnvironment } from "./environment-provisioner";
import { getFreePort, isPortAvailable } from "./free-port";

export interface ServerHarnessOptions {
  env: Pick<ProvisionedEnvironment, "configDir" | "databaseUrl" | "tmpDir">;
  preferredPort?: number;
  /** Optional test-process boundary setup; production server defaults stay unchanged. */
  preloadPath?: string;
}

async function isAtlasHealthy(
  baseUrl: string,
  timeoutMs: number
): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (
      response.status !== 200 ||
      !response.headers.get("content-type")?.includes("application/json")
    ) {
      await response.body?.cancel();
      return false;
    }
    const payload: unknown = await response.json();
    return (
      typeof payload === "object" &&
      payload !== null &&
      "ok" in payload &&
      payload.ok === true &&
      "apiVersion" in payload &&
      payload.apiVersion === ATLAS_API_VERSION
    );
  } catch {
    return false;
  }
}

async function waitForExit(
  process: Subprocess,
  timeoutMs: number
): Promise<boolean> {
  if (process.exitCode !== null) {
    return true;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      process.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function releaseProcess(
  process: Subprocess,
  timeoutMs: number
): Promise<void> {
  if (process.exitCode === null) {
    process.kill("SIGTERM");
  }
  if (await waitForExit(process, timeoutMs)) {
    return;
  }
  process.kill("SIGKILL");
  if (!(await waitForExit(process, timeoutMs))) {
    throw new Error("Atlas server process did not exit after SIGKILL");
  }
}

export class AtlasServerHarness {
  private process: Subprocess | null = null;
  public port = 0;
  public baseUrl = "";
  public logs: string[] = [];

  constructor(private readonly options: ServerHarnessOptions) {}

  private async captureStream(
    stream: ReadableStream<Uint8Array> | null,
    type: "stdout" | "stderr"
  ): Promise<void> {
    if (!stream) {
      return;
    }
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        this.logs.push(
          `[${type}] ${redactStringValue(decoder.decode(value)).trim()}`
        );
      }
    } catch {
      // Process shutdown can close its log streams before the reader finishes.
    } finally {
      reader.releaseLock();
    }
  }

  private async waitUntilReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.process || this.process.exitCode !== null) {
        throw new Error(
          `Atlas server exited prematurely with code ${this.process?.exitCode}. Logs:\n${this.logs.join("\n")}`
        );
      }
      const ready = await isAtlasHealthy(
        this.baseUrl,
        Math.max(1, Math.min(1000, deadline - Date.now()))
      );
      if (ready && this.process.exitCode === null) {
        return;
      }
      await Bun.sleep(Math.max(0, Math.min(200, deadline - Date.now())));
    }
    throw new Error(
      `Atlas server failed to become ready within ${timeoutMs}ms on ${this.baseUrl}`
    );
  }

  async start(timeoutMs = 30_000): Promise<{ baseUrl: string; port: number }> {
    if (this.process) {
      throw new Error("Atlas server harness already owns a process");
    }
    const port = this.options.preferredPort ?? (await getFreePort());
    if (!(await isPortAvailable(port))) {
      throw new Error(`Atlas server harness port ${port} is already occupied`);
    }
    this.port = port;
    this.baseUrl = `http://127.0.0.1:${port}`;
    const projectRoot = join(import.meta.dir, "../..");
    const serverEntry = join(projectRoot, "apps/server/src/index.ts");
    const command = this.options.preloadPath
      ? ["bun", "--preload", this.options.preloadPath, serverEntry]
      : ["bun", serverEntry];
    try {
      const child = spawn(command, {
        cwd: projectRoot,
        env: {
          ...process.env,
          ATLAS_CONFIG_DIR: this.options.env.configDir,
          ATLAS_ENV: "e2e",
          ATLAS_HOST: "127.0.0.1",
          ATLAS_PORT: String(port),
          DATABASE_URL: this.options.env.databaseUrl,
          NODE_ENV: "test",
          TMPDIR: this.options.env.tmpDir,
        },
        stderr: "pipe",
        stdout: "pipe",
      });
      this.process = child;
      this.captureStream(child.stdout, "stdout");
      this.captureStream(child.stderr, "stderr");
      await this.waitUntilReady(timeoutMs);
      return { baseUrl: this.baseUrl, port };
    } catch (error) {
      try {
        await this.stop();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Atlas server startup failed and cleanup also failed",
          { cause: error }
        );
      }
      throw error;
    }
  }

  async stop(timeoutMs = 3000): Promise<void> {
    const errors: unknown[] = [];
    if (this.process) {
      try {
        await releaseProcess(this.process, timeoutMs);
        this.process = null;
      } catch (error) {
        errors.push(error);
      }
    }
    if (this.port > 0) {
      const deadline = Date.now() + timeoutMs;
      while (!(await isPortAvailable(this.port))) {
        if (Date.now() >= deadline) {
          errors.push(
            new Error(`Atlas server harness port ${this.port} remains occupied`)
          );
          break;
        }
        await Bun.sleep(Math.max(0, Math.min(100, deadline - Date.now())));
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Atlas server harness cleanup failed");
    }
  }
}

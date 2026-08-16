import { join } from "node:path";
import { type Subprocess, spawn } from "bun";
import { redactStringValue } from "../../packages/core/src/secret-redaction";
import type { ProvisionedEnvironment } from "./environment-provisioner";
import { getFreePort, isPortAvailable } from "./free-port";

export interface ServerHarnessOptions {
  env: ProvisionedEnvironment;
  preferredPort?: number;
}

export class AtlasServerHarness {
  private process: Subprocess | null = null;
  public port = 0;
  public baseUrl = "";
  public logs: string[] = [];

  constructor(private readonly options: ServerHarnessOptions) {}

  async start(timeoutMs = 30_000): Promise<{ baseUrl: string; port: number }> {
    this.port = this.options.preferredPort ?? (await getFreePort());
    this.baseUrl = `http://127.0.0.1:${this.port}`;

    const projectRoot = join(import.meta.dir, "../..");
    const serverEntry = join(projectRoot, "apps/server/src/index.ts");

    const serverEnv = {
      ...process.env,
      ATLAS_CONFIG_DIR: this.options.env.configDir,
      ATLAS_ENV: "e2e",
      ATLAS_HOST: "127.0.0.1",
      ATLAS_PORT: String(this.port),
      DATABASE_URL: this.options.env.databaseUrl,
      NODE_ENV: "test",
      TMPDIR: this.options.env.tmpDir,
    };

    this.process = spawn(["bun", serverEntry], {
      cwd: projectRoot,
      env: serverEnv,
      stderr: "pipe",
      stdout: "pipe",
    });

    // Stream and sanitize logs
    const captureStream = async (
      stream: ReadableStream<Uint8Array> | null,
      type: "stdout" | "stderr"
    ) => {
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
          const text = decoder.decode(value);
          const sanitized = redactStringValue(text);
          this.logs.push(`[${type}] ${sanitized.trim()}`);
        }
      } catch {
        // stream closed
      }
    };

    captureStream(this.process.stdout, "stdout");
    captureStream(this.process.stderr, "stderr");

    // Wait for health endpoint
    const startTime = Date.now();
    let ready = false;

    while (Date.now() - startTime < timeoutMs) {
      if (this.process.exitCode !== null) {
        throw new Error(
          `Atlas server exited prematurely with code ${this.process.exitCode}. Logs:\n${this.logs.join("\n")}`
        );
      }

      try {
        const res = await fetch(`${this.baseUrl}/v1/health`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(1000),
        });
        if (res.status === 200 || res.status === 404 || res.status === 401) {
          ready = true;
          break;
        }
      } catch {
        // retry
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    if (!ready) {
      await this.stop();
      throw new Error(
        `Atlas server failed to become ready within ${timeoutMs}ms on ${this.baseUrl}`
      );
    }

    return { baseUrl: this.baseUrl, port: this.port };
  }

  async stop(): Promise<void> {
    if (this.process) {
      try {
        this.process.kill("SIGTERM");
        // Wait up to 3s for process to exit
        const start = Date.now();
        while (this.process.exitCode === null && Date.now() - start < 3000) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }

        if (this.process.exitCode === null) {
          this.process.kill("SIGKILL");
        }
      } catch {
        // ignore
      }
      this.process = null;
    }

    // Verify port is freed
    if (this.port > 0) {
      const start = Date.now();
      while (Date.now() - start < 3000) {
        const available = await isPortAvailable(this.port);
        if (available) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
}

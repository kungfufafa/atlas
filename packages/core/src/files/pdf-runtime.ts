import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getUserConfigDir } from "../user-config";
import { PDF_RUNTIME_SCRIPT } from "./pdf-runtime-script";

let activeWorkers = 0;
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

function pythonRuntime(): string {
  const configured = process.env.ATLAS_PYTHON_PATH?.trim();
  if (configured) {
    if (!(path.isAbsolute(configured) && existsSync(configured))) {
      throw new Error(
        "ATLAS_PYTHON_PATH must name an existing absolute Python executable."
      );
    }
    return configured;
  }
  const managed = path.join(getUserConfigDir(), "runtime/python/bin/python3");
  return existsSync(managed) ? managed : "python3";
}

async function execute(
  directory: string,
  config: Record<string, unknown>,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  signal?.throwIfAborted();
  return await new Promise((resolve, reject) => {
    const child = spawn(pythonRuntime(), ["-I", "-c", PDF_RUNTIME_SCRIPT], {
      cwd: directory,
      detached: process.platform !== "win32",
      env: { HOME: directory, PATH: process.env.PATH, TMPDIR: directory },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let failure: Error | undefined;
    const output: Buffer[] = [];
    let outputBytes = 0;
    let diagnostics = "";
    const stop = (error: Error) => {
      failure ??= error;
      try {
        if (child.pid && process.platform !== "win32") {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        /* Already exited. */
      }
    };
    const abort = () => stop(new Error("PDF runtime operation cancelled."));
    const timer = setTimeout(
      () => stop(new Error("PDF runtime exceeded its 60-second deadline.")),
      60_000
    );
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 1_500_000) {
        stop(new Error("PDF runtime response exceeds its bound."));
      } else {
        output.push(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      diagnostics += chunk
        .toString("utf8")
        .slice(0, Math.max(0, 4000 - diagnostics.length));
    });
    child.stdin.on("error", (error) => stop(error));
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      cleanup();
      if (failure) {
        reject(failure);
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `PDF runtime failed. Install scripts/setup-file-runtime.sh dependencies and configured OCR binaries when needed. ${diagnostics.trim()}`
          )
        );
        return;
      }
      try {
        resolve(
          JSON.parse(Buffer.concat(output).toString("utf8")) as Record<
            string,
            unknown
          >
        );
      } catch {
        reject(new Error("PDF runtime returned invalid output."));
      }
    });
    child.stdin.end(JSON.stringify(config));
    if (signal?.aborted) {
      abort();
    }
  });
}

/** Static parser/layout operations only; no profile code, credentials or arbitrary file paths. */
export async function runPdfRuntime(
  config: Record<string, unknown>,
  inputs: Uint8Array[],
  signal?: AbortSignal
): Promise<{ bytes?: Buffer; result: Record<string, unknown> }> {
  signal?.throwIfAborted();
  if (activeWorkers >= 2) {
    throw new Error(
      "PDF runtime capacity is busy; retry after the active operation."
    );
  }
  if (inputs.reduce((sum, value) => sum + value.length, 0) > MAX_OUTPUT_BYTES) {
    throw new Error("PDF runtime inputs exceed the 50 MiB aggregate limit.");
  }
  activeWorkers += 1;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(path.join(tmpdir(), "atlas-pdf-runtime-"));
    for (const [index, bytes] of inputs.entries()) {
      await writeFile(path.join(directory, `input-${index}`), bytes, {
        mode: 0o600,
      });
    }
    const result = await execute(
      directory,
      { ...config, count: inputs.length },
      signal
    );
    if (!result.output) {
      return { result };
    }
    const output = path.join(directory, "output.pdf");
    if ((await stat(output)).size > MAX_OUTPUT_BYTES) {
      throw new Error("PDF runtime output exceeds 50 MiB.");
    }
    return { bytes: await readFile(output), result };
  } finally {
    if (directory) {
      await rm(directory, { force: true, recursive: true });
    }
    activeWorkers -= 1;
  }
}

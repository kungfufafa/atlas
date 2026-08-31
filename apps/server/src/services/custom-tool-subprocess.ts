import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolContext } from "@atlas/core";

// A custom tool can be authored by a tenant administrator. Run it with an
// explicit environment instead of inheriting provider keys and server secrets.
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 1_000_000;
const SIGKILL_GRACE_MS = 5000;
const MACOS_SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";
const UNSAFE_SANDBOX_OPT_IN = "ATLAS_ALLOW_UNSANDBOXED_CUSTOM_TOOLS";

type JavascriptToolMode = "--inspect" | "--run";

interface PreparedSubprocess {
  args: string[];
  bin: string;
  cleanup(): Promise<void>;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

function resolveCustomToolTimeoutMs(): number {
  const configured = Number(process.env.ATLAS_CUSTOM_TOOL_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_TIMEOUT_MS;
}

export interface SpawnJsonToolOptions {
  bin: string;
  context: ToolContext;
  input: unknown;
  label: string;
  mode: JavascriptToolMode;
  modulePath: string;
  /** Optional tool-private dependency tree exposed read-only to the child. */
  moduleReadRoot?: string;
  /** Test/build probes can require the production boundary despite test opt-in. */
  requireSandbox?: boolean;
  runnerPath: string;
  workspaceRoot?: string;
}

/** Runs a JSON-in/JSON-out child with bounded output and lifetime. */
export async function spawnJsonTool(
  options: SpawnJsonToolOptions
): Promise<unknown> {
  const { context, input, label } = options;
  const payload = JSON.stringify(input ?? {}) ?? "{}";
  const timeoutMs = resolveCustomToolTimeoutMs();
  const prepared = await prepareSubprocess(options);

  try {
    const result = await new Promise<{ stderr: string; stdout: string }>(
      (resolve, reject) => {
        const child = spawn(prepared.bin, prepared.args, {
          cwd: prepared.cwd,
          env: prepared.env,
          signal: context.signal,
          stdio: ["pipe", "pipe", "pipe"],
        });

        let stderr = "";
        let stdout = "";
        let timedOut = false;
        let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

        const timeoutTimer = setTimeout(() => {
          timedOut = true;
          try {
            child.kill("SIGTERM");
          } catch {
            // The child may have exited between the timer and this callback.
          }
          sigkillTimer = setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // The child already exited.
            }
          }, SIGKILL_GRACE_MS);
          sigkillTimer.unref();
        }, timeoutMs);

        child.stdout?.on("data", (chunk: Buffer | string) => {
          stdout = appendCapped(stdout, String(chunk));
        });
        child.stderr?.on("data", (chunk: Buffer | string) => {
          stderr = appendCapped(stderr, String(chunk));
        });

        // A child that exits before reading stdin may surface EPIPE. Its close
        // event carries the actionable exit status and stderr.
        child.stdin?.on("error", () => {});

        child.once("error", (error) => {
          clearTimeout(timeoutTimer);
          if (sigkillTimer) {
            clearTimeout(sigkillTimer);
          }
          reject(error);
        });

        child.once("close", (exitCode) => {
          clearTimeout(timeoutTimer);
          if (sigkillTimer) {
            clearTimeout(sigkillTimer);
          }
          const stderrTail = stderr.trim() || "(no stderr)";

          if (timedOut) {
            reject(
              new Error(
                `${label} timed out after ${timeoutMs}ms (exit code ${exitCode ?? "null"}): ${stderrTail}`
              )
            );
            return;
          }

          if (exitCode === 0) {
            resolve({ stderr, stdout });
            return;
          }

          reject(
            new Error(`${label} exit code ${exitCode ?? "null"}: ${stderrTail}`)
          );
        });

        child.stdin?.end(payload);
      }
    );

    const output = result.stdout.trim();
    if (!output) {
      throw new Error(
        `${label} produced no output; it must return one JSON value. stderr: ${result.stderr.trim() || "(empty)"}`
      );
    }

    try {
      return JSON.parse(output);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${label} returned non-JSON output: ${message}; stderr: ${result.stderr.trim() || "(empty)"}`
      );
    }
  } finally {
    await prepared.cleanup();
  }
}

async function prepareSubprocess(
  options: SpawnJsonToolOptions
): Promise<PreparedSubprocess> {
  const createdSandboxTemp = await mkdtemp(
    path.join(os.tmpdir(), "atlas-custom-tool-")
  );
  const sandboxTemp = await realpath(createdSandboxTemp);

  try {
    const bunPath = await resolveExecutablePath(options.bin);
    const runnerPath = await resolveRequiredPath(
      options.runnerPath,
      "JavaScript tool runner asset"
    );
    const modulePath = await resolveRequiredPath(
      options.modulePath,
      "JavaScript tool module"
    );
    const moduleDirectory = path.dirname(modulePath);
    const moduleReadRoot = options.moduleReadRoot
      ? await resolveRequiredPath(
          options.moduleReadRoot,
          "JavaScript tool dependency directory"
        )
      : undefined;
    if (moduleReadRoot && !isPathInsideDirectory(modulePath, moduleReadRoot)) {
      throw new Error(
        "JavaScript tool module must stay inside its dependency directory."
      );
    }
    const workspaceRoot = options.workspaceRoot
      ? await resolveRequiredPath(
          options.workspaceRoot,
          "JavaScript tool workspace"
        )
      : undefined;
    const exposedWorkspaceRoot = options.workspaceRoot
      ? path.resolve(options.workspaceRoot)
      : undefined;
    const env = buildAllowlistedSubprocessEnv(
      exposedWorkspaceRoot,
      sandboxTemp
    );
    const runnerArgs = [
      "--no-install",
      "--no-addons",
      runnerPath,
      options.mode,
      modulePath,
    ];
    const cleanup = async (): Promise<void> => {
      await rm(sandboxTemp, { force: true, recursive: true });
    };

    if (!options.requireSandbox && process.env[UNSAFE_SANDBOX_OPT_IN] === "1") {
      return {
        args: runnerArgs,
        bin: bunPath,
        cleanup,
        cwd: moduleDirectory,
        env,
      };
    }

    if (process.platform === "darwin") {
      await access(MACOS_SANDBOX_EXECUTABLE, fsConstants.X_OK);
      return {
        args: buildMacosSandboxArgs({
          bunPath,
          moduleDirectory,
          modulePath,
          moduleReadRoot,
          runnerArgs,
          runnerDirectory: path.dirname(runnerPath),
          runnerPath,
          sandboxTemp,
          workspaceRoot,
        }),
        bin: MACOS_SANDBOX_EXECUTABLE,
        cleanup,
        cwd: moduleDirectory,
        env,
      };
    }

    if (process.platform === "linux") {
      const launcherPath = await resolveRequiredPath(
        path.join(path.dirname(runnerPath), "javascript-tool-sandbox-linux.js"),
        "Linux Landlock launcher asset"
      );
      Object.assign(env, {
        ATLAS_CUSTOM_TOOL_SANDBOX_BUN: bunPath,
        ATLAS_CUSTOM_TOOL_SANDBOX_MODE: options.mode,
        ATLAS_CUSTOM_TOOL_SANDBOX_MODULE: modulePath,
        ATLAS_CUSTOM_TOOL_SANDBOX_MODULE_DIR: moduleDirectory,
        ATLAS_CUSTOM_TOOL_SANDBOX_MODULE_ROOT: moduleReadRoot ?? "",
        ATLAS_CUSTOM_TOOL_SANDBOX_RUNNER: runnerPath,
        ATLAS_CUSTOM_TOOL_SANDBOX_RUNNER_DIR: path.dirname(runnerPath),
        ATLAS_CUSTOM_TOOL_SANDBOX_TEMP: sandboxTemp,
        ATLAS_CUSTOM_TOOL_SANDBOX_WORKSPACE: workspaceRoot ?? "",
      });
      return {
        args: ["--no-install", "--no-addons", launcherPath],
        bin: bunPath,
        cleanup,
        cwd: sandboxTemp,
        env,
      };
    }

    throw unsupportedSandboxError();
  } catch (error) {
    await rm(sandboxTemp, { force: true, recursive: true });
    if (
      process.platform === "darwin" &&
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      throw unsupportedSandboxError();
    }
    throw error;
  }
}

function buildAllowlistedSubprocessEnv(
  workspaceRoot: string | undefined,
  sandboxTemp: string
): NodeJS.ProcessEnv {
  return {
    HOME: sandboxTemp,
    TEMP: sandboxTemp,
    TMP: sandboxTemp,
    TMPDIR: sandboxTemp,
    ...(workspaceRoot ? { ATLAS_WORKSPACE_ROOT: workspaceRoot } : {}),
  };
}

interface MacosSandboxOptions {
  bunPath: string;
  moduleDirectory: string;
  modulePath: string;
  moduleReadRoot?: string;
  runnerArgs: string[];
  runnerDirectory: string;
  runnerPath: string;
  sandboxTemp: string;
  workspaceRoot?: string;
}

function buildMacosSandboxArgs(options: MacosSandboxOptions): string[] {
  const readableDirectories = collectPathAncestors([
    options.moduleDirectory,
    options.runnerDirectory,
    options.sandboxTemp,
  ]);
  const readableDirectoryRules = readableDirectories
    .map((_directory, index) => `  (literal (param "READ_DIR_${index}"))`)
    .join("\n");
  const workspaceRules = options.workspaceRoot
    ? `
(allow file-read* (subpath (param "WORKSPACE_ROOT")))
(allow file-write* (subpath (param "WORKSPACE_ROOT")))`
    : "";
  const moduleReadRootRule = options.moduleReadRoot
    ? `\n  (subpath (param "MODULE_ROOT"))`
    : "";
  const profile = `(version 1)
(deny default)
(import "system.sb")
(allow process-exec)
(allow file-read-metadata)
(allow file-test-existence)
(allow file-read-data
  (subpath "/System")
  (subpath "/usr/lib")
  (subpath "/private/etc/ssl")
  (literal "/private/etc/resolv.conf")
  (literal "/private/etc/hosts")
  (literal "/private/etc/localtime")
  (literal (param "BUN_BIN"))
  (literal (param "RUNNER_PATH"))
  (literal (param "RUNNER_DIR"))
  (literal (param "MODULE_PATH"))
  (literal (param "MODULE_DIR"))${moduleReadRootRule}
${readableDirectoryRules}
  (subpath (param "SANDBOX_TEMP")))
(allow file-write* (subpath (param "SANDBOX_TEMP")))
(allow sysctl-read)
(allow mach-lookup)
(allow network*)${workspaceRules}`;
  const args = [
    "-D",
    `BUN_BIN=${options.bunPath}`,
    "-D",
    `RUNNER_PATH=${options.runnerPath}`,
    "-D",
    `RUNNER_DIR=${options.runnerDirectory}`,
    "-D",
    `MODULE_PATH=${options.modulePath}`,
    "-D",
    `MODULE_DIR=${options.moduleDirectory}`,
    "-D",
    `SANDBOX_TEMP=${options.sandboxTemp}`,
  ];
  if (options.moduleReadRoot) {
    args.push("-D", `MODULE_ROOT=${options.moduleReadRoot}`);
  }
  if (options.workspaceRoot) {
    args.push("-D", `WORKSPACE_ROOT=${options.workspaceRoot}`);
  }
  for (const [index, directory] of readableDirectories.entries()) {
    args.push("-D", `READ_DIR_${index}=${directory}`);
  }
  args.push("-p", profile, options.bunPath, ...options.runnerArgs);
  return args;
}

function collectPathAncestors(paths: string[]): string[] {
  const ancestors = new Set<string>();
  for (const candidate of paths) {
    let current = candidate;
    while (!ancestors.has(current)) {
      ancestors.add(current);
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }
  return [...ancestors];
}

async function resolveExecutablePath(bin: string): Promise<string> {
  if (bin === "bun") {
    return realpath(process.execPath);
  }

  const hasPathSeparator = bin.includes(path.sep);
  if (path.isAbsolute(bin) || hasPathSeparator) {
    await access(bin, fsConstants.X_OK);
    return realpath(bin);
  }

  const searchPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  for (const directory of searchPath.split(path.delimiter)) {
    const candidate = path.join(directory, bin);
    try {
      await access(candidate, fsConstants.X_OK);
      return await realpath(candidate);
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error(`Custom tool runtime executable not found: ${bin}`);
}

async function resolveRequiredPath(
  candidate: string,
  label: string
): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    throw new Error(
      `${label} is missing at ${candidate}. Rebuild @atlas/server before running custom JavaScript tools.`
    );
  }
}

function unsupportedSandboxError(): Error {
  return new Error(
    "Custom JavaScript tools require macOS sandbox-exec or Linux Landlock ABI 3 (Linux kernel 6.2+). Execution was blocked because no supported filesystem sandbox is available. Only isolated deployments may explicitly opt out with ATLAS_ALLOW_UNSANDBOXED_CUSTOM_TOOLS=1."
  );
}

function isPathInsideDirectory(
  targetPath: string,
  directoryPath: string
): boolean {
  const relative = path.relative(directoryPath, targetPath);
  return (
    relative === "" || !(relative.startsWith("..") || path.isAbsolute(relative))
  );
}

function appendCapped(current: string, next: string): string {
  const combined = current + next;
  return combined.length <= MAX_OUTPUT_CHARS
    ? combined
    : combined.slice(-MAX_OUTPUT_CHARS);
}

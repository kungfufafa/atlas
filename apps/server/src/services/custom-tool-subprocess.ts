import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ToolContext } from "@atlas/core";
import {
  authorizeRestrictedProcessLaunch,
  createRestrictedProcessLaunchEvidence,
  type RestrictedProcessAdmissionPolicy,
  type RestrictedProcessAdmissionReceipt,
  type RestrictedProcessEvidenceInput,
} from "./restricted-process-admission";

// Custom JavaScript and executable skills can be authored by tenant administrators.
// The shared unsafe opt-out removes filesystem confinement for both; it never imports
// them into the server, and strict callers must set requireSandbox. Run them with an
// explicit environment instead of inheriting provider keys and server secrets.
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1_000_000;
const SIGKILL_GRACE_MS = 5000;
const MACOS_SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";
const UNSAFE_SANDBOX_OPT_IN = "ATLAS_ALLOW_UNSANDBOXED_CUSTOM_TOOLS";

type JavascriptToolMode = "--inspect" | "--run";

interface PreparedSubprocess {
  admission: Readonly<CustomToolAdmission>;
  args: readonly string[];
  bin: string;
  cleanup(): Promise<void>;
  cwd: string;
  env: NodeJS.ProcessEnv;
  evidenceInput?: RestrictedProcessEvidenceInput;
}

function resolveCustomToolTimeoutMs(): number {
  const configured = Number(process.env.ATLAS_CUSTOM_TOOL_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_TIMEOUT_MS;
}

export interface CustomToolAdmission {
  filesystemPolicy:
    | "macos-custom-tool-v1"
    | "linux-landlock-custom-tool-v1"
    | "unrestricted-host";
  /** Fixed system grants are defined by filesystemPolicy, not just these paths. */
  inheritedHostEnvironment: false;
  mode: "sandboxed" | "unsafe-host";
  modulePath: string;
  moduleReadRoot?: string;
  platform: NodeJS.Platform;
  runnerPath: string;
  runtimeExecutable: string;
  /** Prepared by the host; this is not a module-reported execution receipt. */
  stage: "prepared";
  tempRoot: string;
  workspaceRoot?: string;
}

export interface SpawnJsonToolOptions {
  bin: string;
  canonicalRootsRequired?: boolean;
  context: ToolContext;
  input: unknown;
  label: string;
  mode: JavascriptToolMode;
  modulePath: string;
  /** Optional tool-private dependency tree exposed read-only to the child. */
  moduleReadRoot?: string;
  onAdmission?: (evidence: Readonly<CustomToolAdmission>) => void;
  /** Test/build probes can require the production boundary despite test opt-in. */
  requireSandbox?: boolean;
  runnerPath: string;
  workspaceRoot?: string;
}

export interface CustomToolRuntimeAdmissionPolicy {
  /** Trusted host callback; never read from module/input/context JSON. */
  authorize?: RestrictedProcessAdmissionPolicy["authorize"];
  /** Historical prepared authorization only; never sent to the child/result. */
  onAuthorized?: (receipt: RestrictedProcessAdmissionReceipt) => void;
  requireAdmission?: boolean;
}

/** Captures trusted policy once. The legacy onAdmission option remains an observer. */
export function createJsonToolSpawner(
  policy: CustomToolRuntimeAdmissionPolicy = {}
) {
  const authorize = policy.authorize;
  const requireAdmission = policy.requireAdmission === true;
  const onAuthorized = policy.onAuthorized;
  const needsAdmission = requireAdmission || authorize !== undefined;
  return async (options: SpawnJsonToolOptions): Promise<unknown> => {
    const sourceContext = options.context;
    const signal = sourceContext.signal;
    const onAdmission = options.onAdmission;
    const captured: SpawnJsonToolOptions = {
      bin: options.bin,
      canonicalRootsRequired: options.canonicalRootsRequired,
      context: { ...sourceContext, signal },
      input: options.input,
      label: options.label,
      mode: options.mode,
      modulePath: options.modulePath,
      moduleReadRoot: options.moduleReadRoot,
      requireSandbox: options.requireSandbox,
      runnerPath: options.runnerPath,
      workspaceRoot: options.workspaceRoot,
    };
    const { label } = captured;
    signal?.throwIfAborted();
    if (requireAdmission && !authorize) {
      throw new Error("Required custom runtime authorization is unavailable.");
    }
    // Capture model input and all host selectors before the first await.
    const payload = JSON.stringify(captured.input ?? {}) ?? "{}";
    const timeoutMs = resolveCustomToolTimeoutMs();
    const unsafeRequested =
      !captured.requireSandbox && process.env[UNSAFE_SANDBOX_OPT_IN] === "1";
    if (needsAdmission && unsafeRequested) {
      throw new Error(
        "Custom runtime admission requires an enforced sandbox; set requireSandbox or remove the unsafe opt-out."
      );
    }
    if (needsAdmission && process.platform !== "darwin") {
      throw new Error(
        "Custom runtime admission evidence currently requires macOS; execution was blocked before startup."
      );
    }
    const prepared = await prepareSubprocess(captured, unsafeRequested);
    try {
      // This observer receives immutable diagnostics, not mutable launch parameters.
      onAdmission?.call(options, prepared.admission);
      signal?.throwIfAborted();
      if (needsAdmission) {
        const evidenceInput = prepared.evidenceInput;
        if (!evidenceInput) {
          throw new Error("Custom sandbox admission evidence is unavailable.");
        }
        const evidence =
          await createRestrictedProcessLaunchEvidence(evidenceInput);
        signal?.throwIfAborted();
        const receipt = await awaitAdmission(
          authorizeRestrictedProcessLaunch(evidence, authorize),
          signal
        );
        signal?.throwIfAborted();
        if (receipt) {
          onAuthorized?.(receipt);
        }
      }
      signal?.throwIfAborted();
      const result = await collectChildOutput(
        prepared,
        payload,
        label,
        timeoutMs,
        signal
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
  };
}

function awaitAdmission<T>(
  pending: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) {
    return pending;
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(
        signal.reason ??
          new DOMException("Custom runtime admission cancelled.", "AbortError")
      );
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
    }
    pending
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Default compatibility entrypoint. No trusted policy is inferred from tool options. */
export const spawnJsonTool = createJsonToolSpawner();

function killChildGroup(
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals
): void {
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // The child/group may have already exited.
  }
}

function collectChildOutput(
  prepared: PreparedSubprocess,
  payload: string,
  label: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(prepared.bin, prepared.args, {
      cwd: prepared.cwd,
      detached: process.platform !== "win32",
      env: prepared.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let failure: Error | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: Error) => {
      if (failure) {
        return;
      }
      failure = error;
      killChildGroup(child, "SIGTERM");
      killTimer = setTimeout(
        () => killChildGroup(child, "SIGKILL"),
        SIGKILL_GRACE_MS
      );
      killTimer.unref();
    };
    const onAbort = () =>
      stop(new DOMException(`${label} cancelled.`, "AbortError"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
    const timeout = setTimeout(
      () => stop(new Error(`${label} timed out after ${timeoutMs}ms.`)),
      timeoutMs
    );
    const receive = (chunk: Buffer | string, isError: boolean) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_OUTPUT_BYTES) {
        stop(new Error(`${label} exceeded its output limit.`));
        return;
      }
      if (isError) {
        stderr += String(chunk);
      } else {
        stdout += String(chunk);
      }
    };
    child.stdout?.on("data", (chunk: Buffer | string) => receive(chunk, false));
    child.stderr?.on("data", (chunk: Buffer | string) => receive(chunk, true));
    child.stdin?.on("error", () => {});
    child.once("error", (error) => {
      failure ??= error;
    });
    // Kill ordinary descendants even if their leader exits while they keep stdio open.
    child.once("exit", () => killChildGroup(child, "SIGKILL"));
    child.once("close", (exitCode, exitSignal) => {
      clearTimeout(timeout);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      signal?.removeEventListener("abort", onAbort);
      if (failure) {
        reject(failure);
        return;
      }
      if (exitCode !== 0) {
        reject(
          new Error(
            `${label} ${exitSignal ? `signal ${exitSignal}` : `exit code ${exitCode ?? "null"}`}: ${stderr.trim() || "(no stderr)"}`
          )
        );
        return;
      }
      resolve({ stderr, stdout });
    });
    child.stdin?.end(payload);
  });
}

async function prepareSubprocess(
  options: SpawnJsonToolOptions,
  unsafeRequested: boolean
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
    if (options.canonicalRootsRequired) {
      for (const [requested, actual] of [
        [options.modulePath, modulePath],
        [options.moduleReadRoot, moduleReadRoot],
        [options.workspaceRoot, workspaceRoot],
      ]) {
        if (requested && path.resolve(requested) !== actual) {
          throw new Error(
            "Custom-code root changed or became a symlink before sandbox admission; reload the tool."
          );
        }
      }
    }
    const admission = (mode: CustomToolAdmission["mode"]) =>
      Object.freeze({
        filesystemPolicy:
          mode === "unsafe-host"
            ? ("unrestricted-host" as const)
            : process.platform === "darwin"
              ? ("macos-custom-tool-v1" as const)
              : ("linux-landlock-custom-tool-v1" as const),
        inheritedHostEnvironment: false as const,
        mode,
        modulePath,
        moduleReadRoot,
        platform: process.platform,
        runnerPath,
        runtimeExecutable: bunPath,
        stage: "prepared" as const,
        tempRoot: sandboxTemp,
        workspaceRoot,
      });
    const exposedWorkspaceRoot = options.workspaceRoot
      ? path.resolve(options.workspaceRoot)
      : undefined;
    const env = buildAllowlistedSubprocessEnv(
      exposedWorkspaceRoot,
      sandboxTemp
    );
    // Explicit empty files suppress Bun's cwd bunfig preload and automatic .env.
    // Both files are created by the host, before any untrusted module can run.
    const startupConfig = path.join(sandboxTemp, "empty-bunfig.toml");
    const startupEnvironment = path.join(sandboxTemp, "empty.env");
    await Promise.all([
      writeFile(startupConfig, "", { flag: "wx", mode: 0o600 }),
      writeFile(startupEnvironment, "", { flag: "wx", mode: 0o600 }),
    ]);
    const startupArgs = [
      `--config=${startupConfig}`,
      `--env-file=${startupEnvironment}`,
    ];
    const runnerArgs = [
      ...startupArgs,
      "--no-install",
      "--no-addons",
      runnerPath,
      options.mode,
      modulePath,
    ];
    const cleanup = async (): Promise<void> => {
      await rm(sandboxTemp, { force: true, recursive: true });
    };

    if (unsafeRequested) {
      return {
        admission: admission("unsafe-host"),
        args: runnerArgs,
        bin: bunPath,
        cleanup,
        cwd: moduleDirectory,
        env,
      };
    }

    if (process.platform === "darwin") {
      await access(MACOS_SANDBOX_EXECUTABLE, fsConstants.X_OK);
      const sandbox = buildMacosSandboxPlan({
        bunPath,
        moduleDirectory,
        modulePath,
        moduleReadRoot,
        runnerArgs,
        runnerDirectory: path.dirname(runnerPath),
        runnerPath,
        sandboxTemp,
        workspaceRoot,
      });
      const args = Object.freeze(sandbox.args);
      const frozenEnv = Object.freeze(env);
      return Object.freeze({
        admission: admission("sandboxed"),
        args,
        bin: MACOS_SANDBOX_EXECUTABLE,
        cleanup,
        cwd: moduleDirectory,
        env: frozenEnv,
        evidenceInput: Object.freeze({
          args,
          bin: MACOS_SANDBOX_EXECUTABLE,
          cwd: moduleDirectory,
          env: frozenEnv,
          executable: bunPath,
          executableSpelling: bunPath,
          grants: Object.freeze(
            sandbox.grants.map((grant) => Object.freeze(grant))
          ),
          launchPolicy: "custom_json" as const,
          network: "allow" as const,
          platform: "darwin" as const,
          policySource: sandbox.policySource,
          temporaryRoot: sandboxTemp,
          // Metadata has no writable profile workspace. Explicit grants govern access.
          workspaceRoot: workspaceRoot ?? moduleDirectory,
        }),
      });
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
        admission: admission("sandboxed"),
        args: [...startupArgs, "--no-install", "--no-addons", launcherPath],
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

function buildMacosSandboxPlan(options: MacosSandboxOptions) {
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
  const grants: {
    kind: RestrictedProcessEvidenceInput["grants"][number]["kind"];
    root: string;
  }[] = [
    ...["/System", "/usr/lib", "/private/etc/ssl"].map((root) => ({
      kind: "read_subtree" as const,
      root,
    })),
    ...[
      "/private/etc/resolv.conf",
      "/private/etc/hosts",
      "/private/etc/localtime",
      options.bunPath,
      options.runnerPath,
      options.modulePath,
    ].map((root) => ({ kind: "read_literal" as const, root })),
    ...[
      options.runnerDirectory,
      options.moduleDirectory,
      ...readableDirectories,
    ].map((root) => ({ kind: "directory_entries_literal" as const, root })),
    { kind: "read_write_subtree", root: options.sandboxTemp },
    ...(options.moduleReadRoot
      ? [{ kind: "read_subtree" as const, root: options.moduleReadRoot }]
      : []),
    ...(options.workspaceRoot
      ? [{ kind: "read_write_subtree" as const, root: options.workspaceRoot }]
      : []),
  ];
  return { args, grants, policySource: profile };
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

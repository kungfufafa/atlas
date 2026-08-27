import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SubscriptionProviderKind } from "@atlas/core";
import { ensureProcessPath } from "../../lib/ensure-process-path";
import { buildSubscriptionRuntimeEnv } from "./env";

const VERSION_TIMEOUT_MS = 8000;
const FORCE_KILL_DELAY_MS = 1000;
const MAX_COMMAND_OUTPUT_CHARS = 64 * 1024;
const SERVER_PACKAGE_ROOT = join(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../.."
);

export interface RuntimeBinaryProbe {
  command: string | null;
  installed: boolean;
  prefixArgs: string[];
  version: string | null;
}

export interface RuntimeLaunch {
  command: string;
  prefixArgs: string[];
}

export interface ClaudeLoginCommandOptions {
  docker?: boolean;
  env?: Record<string, string | undefined>;
  searchPath?: string;
}

export function resolveRuntimeBinary(
  command: string,
  searchPath?: string
): string | null {
  if (searchPath === undefined) {
    ensureProcessPath();
  }
  return (
    Bun.which(
      command,
      searchPath === undefined ? undefined : { PATH: searchPath }
    ) ?? null
  );
}

export function resolveSubscriptionLaunch(
  kind: SubscriptionProviderKind,
  options: { searchPath?: string } = {}
): RuntimeLaunch | null {
  return kind === "chatgpt"
    ? resolveCodexLaunch(options.searchPath)
    : resolveClaudeLaunch(options.searchPath);
}

export async function probeRuntimeBinary(
  kind: SubscriptionProviderKind,
  command: string
): Promise<RuntimeBinaryProbe> {
  const launch = resolveSubscriptionLaunch(kind) ?? launchFromPath(command);
  if (!launch) {
    return { command: null, installed: false, prefixArgs: [], version: null };
  }

  const version = await readCommandVersion(kind, launch);
  return {
    command: launch.command,
    installed: true,
    prefixArgs: launch.prefixArgs,
    version,
  };
}

export function chatgptInstallHint(): string {
  return "Codex is bundled with Atlas. Reinstall Atlas dependencies (`bun install`) if ChatGPT cannot connect.";
}

export function claudeInstallHint(): string {
  return "Claude is bundled with Atlas. Reinstall Atlas dependencies (`bun install`) if Claude cannot connect.";
}

export function claudeLoginCommand(
  options: ClaudeLoginCommandOptions = {}
): string {
  const env = options.env ?? process.env;
  const launch = resolveSubscriptionLaunch("claude", {
    searchPath: options.searchPath,
  });
  const command = formatShellCommand([
    launch?.command ?? "claude",
    ...(launch?.prefixArgs ?? []),
    "auth",
    "login",
  ]);
  const isDocker = options.docker ?? existsSync("/.dockerenv");
  if (!isDocker) {
    return command;
  }

  const containerName = dockerContainerName(env);
  return `docker exec -it ${formatShellArgument(containerName)} ${command}`;
}

export function chatgptLoginCommand(): string {
  return "codex login";
}

export function claudePlatformPackageName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string[] {
  const binary = platform === "win32" ? "claude.exe" : "claude";
  if (platform === "darwin") {
    return [`@anthropic-ai/claude-agent-sdk-darwin-${arch}/${binary}`];
  }
  if (platform === "win32") {
    return [`@anthropic-ai/claude-agent-sdk-win32-${arch}/${binary}`];
  }
  if (platform === "linux") {
    return [
      `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl/${binary}`,
      `@anthropic-ai/claude-agent-sdk-linux-${arch}/${binary}`,
    ];
  }
  return [];
}

export function codexPlatformPackageName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string | null {
  if (platform === "darwin" && arch === "arm64") {
    return "@openai/codex-darwin-arm64";
  }
  if (platform === "darwin" && arch === "x64") {
    return "@openai/codex-darwin-x64";
  }
  if (platform === "linux" && arch === "arm64") {
    return "@openai/codex-linux-arm64";
  }
  if (platform === "linux" && arch === "x64") {
    return "@openai/codex-linux-x64";
  }
  if (platform === "win32" && arch === "arm64") {
    return "@openai/codex-win32-arm64";
  }
  if (platform === "win32" && arch === "x64") {
    return "@openai/codex-win32-x64";
  }
  return null;
}

function resolveCodexLaunch(searchPath?: string): RuntimeLaunch | null {
  const wrapper = resolveExistingPath(
    specifierPath("@openai/codex/bin/codex.js"),
    ...nodeModuleCandidates("@openai/codex/bin/codex.js")
  );
  if (wrapper) {
    const directBinary = resolveBundledCodexBinary(wrapper);
    if (directBinary) {
      return { command: directBinary, prefixArgs: [] };
    }
    return { command: process.execPath, prefixArgs: [wrapper] };
  }

  const pathBinary = resolveRuntimeBinary("codex", searchPath);
  return pathBinary ? { command: pathBinary, prefixArgs: [] } : null;
}

function resolveBundledCodexBinary(wrapper: string): string | null {
  const packageName = codexPlatformPackageName();
  const target = codexTargetTriple();
  const packageDirectoryName = packageName?.split("/")[1];
  if (!(packageDirectoryName && target)) {
    return null;
  }
  const codexPackageRoot = dirname(dirname(wrapper));
  return resolveExistingPath(
    join(
      dirname(codexPackageRoot),
      packageDirectoryName,
      "vendor",
      target,
      "bin",
      process.platform === "win32" ? "codex.exe" : "codex"
    )
  );
}

function codexTargetTriple(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string | null {
  if (platform === "darwin" && arch === "arm64") {
    return "aarch64-apple-darwin";
  }
  if (platform === "darwin" && arch === "x64") {
    return "x86_64-apple-darwin";
  }
  if (platform === "linux" && arch === "arm64") {
    return "aarch64-unknown-linux-musl";
  }
  if (platform === "linux" && arch === "x64") {
    return "x86_64-unknown-linux-musl";
  }
  if (platform === "win32" && arch === "arm64") {
    return "aarch64-pc-windows-msvc";
  }
  if (platform === "win32" && arch === "x64") {
    return "x86_64-pc-windows-msvc";
  }
  return null;
}

function resolveClaudeLaunch(searchPath?: string): RuntimeLaunch | null {
  for (const specifier of claudePlatformPackageName()) {
    const bundled = resolveExistingPath(
      specifierPath(specifier),
      ...nodeModuleCandidates(specifier)
    );
    if (bundled) {
      return { command: bundled, prefixArgs: [] };
    }
  }

  const pathBinary = resolveRuntimeBinary("claude", searchPath);
  return pathBinary ? { command: pathBinary, prefixArgs: [] } : null;
}

function nodeModuleCandidates(relPath: string): string[] {
  return [
    join(SERVER_PACKAGE_ROOT, "node_modules", relPath),
    join(SERVER_PACKAGE_ROOT, "../../node_modules", relPath),
    join(SERVER_PACKAGE_ROOT, "node_modules/.bun/node_modules", relPath),
    join(SERVER_PACKAGE_ROOT, "../../node_modules/.bun/node_modules", relPath),
  ];
}

function launchFromPath(command: string): RuntimeLaunch | null {
  const pathBinary = resolveRuntimeBinary(command);
  return pathBinary ? { command: pathBinary, prefixArgs: [] } : null;
}

function specifierPath(specifier: string): string | null {
  try {
    const resolved = import.meta.resolve(specifier);
    return resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved;
  } catch {
    return null;
  }
}

function resolveExistingPath(
  ...candidates: Array<string | null>
): string | null {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function formatShellCommand(args: string[]): string {
  return args.map(formatShellArgument).join(" ");
}

function formatShellArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@%+,=-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function dockerContainerName(env: Record<string, string | undefined>): string {
  const candidate =
    env.ATLAS_CONTAINER_NAME?.trim() || env.HOSTNAME?.trim() || "atlas";
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(candidate) ? candidate : "atlas";
}

async function readCommandVersion(
  kind: SubscriptionProviderKind,
  launch: RuntimeLaunch
): Promise<string | null> {
  return await new Promise((resolve) => {
    const child = spawn(launch.command, [...launch.prefixArgs, "--version"], {
      env: buildSubscriptionRuntimeEnv(kind),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let timedOut = false;
    const finish = (value: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
      }
      resolve(value);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimeout = setTimeout(() => {
        child.kill("SIGKILL");
        finish(null);
      }, FORCE_KILL_DELAY_MS);
    }, VERSION_TIMEOUT_MS);

    child.stdout?.on("data", (chunk) => {
      stdout = appendBoundedOutput(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendBoundedOutput(stderr, chunk);
    });
    child.once("error", () => {
      finish(null);
    });
    child.once("close", () => {
      if (timedOut) {
        finish(null);
        return;
      }
      const line = `${stdout}\n${stderr}`.trim().split(/\r?\n/, 1)[0]?.trim();
      finish(line || null);
    });
  });
}

function appendBoundedOutput(current: string, chunk: unknown): string {
  if (current.length >= MAX_COMMAND_OUTPUT_CHARS) {
    return current;
  }
  return `${current}${String(chunk).slice(
    0,
    MAX_COMMAND_OUTPUT_CHARS - current.length
  )}`;
}

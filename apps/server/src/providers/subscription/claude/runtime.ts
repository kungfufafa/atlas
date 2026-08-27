import { spawn } from "node:child_process";
import type {
  ChatCompletionResult,
  GenerateChatInput,
  ProviderModelOption,
  StreamChatHandlers,
  SubscriptionAuthState,
  SubscriptionLoginStartResponse,
  SubscriptionLoginStatusResponse,
} from "@atlas/core";
import { ensureDir } from "@atlas/core";
import { buildTokenUsage } from "../../shared";
import {
  claudeInstallHint,
  claudeLoginCommand,
  probeRuntimeBinary,
  resolveSubscriptionLaunch,
} from "../binary";
import { buildSubscriptionRuntimeEnv } from "../env";
import { SubscriptionRuntimeError, throwSubscriptionError } from "../errors";
import {
  appendDelta,
  formatSubscriptionPrompt,
  parseSubscriptionResponse,
} from "../prompt";
import {
  clearSubscriptionSession,
  deleteSubscriptionProviderSessions,
  deleteUnpersistedSubscriptionSession,
  readSubscriptionSession,
  subscriptionWorkspaceDir,
  withSubscriptionProviderLease,
  withSubscriptionSessionLease,
  writeSubscriptionSession,
} from "../session-store";

const FALLBACK_CLAUDE_MODELS: ProviderModelOption[] = [
  {
    default: true,
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    provider: "claude",
  },
  {
    id: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    provider: "claude",
  },
];

const LOGIN_TTL_MS = 15 * 60 * 1000;
const LOGIN_POLL_INTERVAL_MS = 2000;
const DEFAULT_TURN_TIMEOUT_MS = 15 * 60 * 1000;
const FORCE_KILL_DELAY_MS = 1000;
const MAX_COMMAND_OUTPUT_CHARS = 64 * 1024;
const MAX_PENDING_LOGINS = 128;
const CLAUDE_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

interface PendingLogin {
  expiresAt: number;
  loginId: string;
  status: SubscriptionLoginStatusResponse;
}

export interface ClaudeQueryHandle {
  close?: () => void;
  interrupt?: () => Promise<void>;
  supportedModels?: () => Promise<
    Array<{ displayName?: string; value?: string }>
  >;
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
}

export interface ClaudeAgentSdk {
  deleteSession?: (
    sessionId: string,
    options?: { dir?: string }
  ) => Promise<void>;
  query(input: {
    options?: Record<string, unknown>;
    prompt: string;
  }): ClaudeQueryHandle;
}

export interface ClaudeSubscriptionRuntimeOptions {
  sdk?: ClaudeAgentSdk;
  turnTimeoutMs?: number;
}

export class ClaudeSubscriptionRuntime {
  private loginStarting = false;
  private readonly pendingLogins = new Map<string, PendingLogin>();
  private sdk: ClaudeAgentSdk | null | undefined;
  private readonly turnTimeoutMs: number;

  constructor(options: ClaudeSubscriptionRuntimeOptions = {}) {
    this.sdk = options.sdk;
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
  }

  async getAuthState(): Promise<SubscriptionAuthState> {
    const probe = await probeRuntimeBinary("claude", "claude");
    const sdk = await this.loadSdk();
    if (!(probe.installed || sdk)) {
      return {
        authenticated: false,
        installHint: claudeInstallHint(),
        loginCommand: claudeLoginCommand(),
        message:
          "Claude runtime is not available. Reinstall Atlas dependencies to restore the bundled Claude binary.",
        provider: "claude",
        runtimeVersion: probe.version,
        status: "not_installed",
      };
    }

    const auth = await readClaudeAuthStatus();
    if (auth.authenticated) {
      return {
        authenticated: true,
        loginCommand: claudeLoginCommand(),
        provider: "claude",
        runtimeVersion: probe.version,
        status: "authenticated",
        ...(auth.email ? { email: auth.email } : {}),
        ...(auth.plan ? { plan: auth.plan } : {}),
      };
    }

    return {
      authenticated: false,
      loginCommand: claudeLoginCommand(),
      message:
        auth.message ??
        "Claude is not authenticated. Run the provided login command and try again.",
      provider: "claude",
      runtimeVersion: probe.version,
      status: "not_authenticated",
    };
  }

  async startLogin(_options?: {
    method?: "browser" | "device";
  }): Promise<SubscriptionLoginStartResponse> {
    this.prunePendingLogins();
    if (this.loginStarting) {
      throw new SubscriptionRuntimeError(
        "claude",
        "runtime_error",
        "A Claude login is already being started."
      );
    }
    this.loginStarting = true;
    try {
      const state = await this.getAuthState();
      if (state.status === "not_installed") {
        throw new SubscriptionRuntimeError(
          "claude",
          "provider_unavailable",
          state.message ?? claudeInstallHint()
        );
      }
      const loginId = crypto.randomUUID();
      if (state.authenticated) {
        this.pendingLogins.set(loginId, {
          expiresAt: Date.now() + LOGIN_TTL_MS,
          loginId,
          status: { account: state, loginId, status: "completed" },
        });
        return {
          instructions: "Claude is already authenticated on this host.",
          loginCommand: claudeLoginCommand(),
          loginId,
          method: "cli",
        };
      }
      if (
        [...this.pendingLogins.values()].some(
          (login) => login.status.status === "pending"
        )
      ) {
        throw new SubscriptionRuntimeError(
          "claude",
          "runtime_error",
          "A Claude login is already in progress. Cancel it before starting another."
        );
      }

      this.pendingLogins.set(loginId, {
        expiresAt: Date.now() + LOGIN_TTL_MS,
        loginId,
        status: { loginId, status: "pending" },
      });
      return {
        instructions:
          "On the Atlas host, run the provided Claude login command and finish the official login. Atlas will reuse that session.",
        loginCommand: claudeLoginCommand(),
        loginId,
        method: "cli",
      };
    } finally {
      this.loginStarting = false;
    }
  }

  async getLoginStatus(
    loginId: string
  ): Promise<SubscriptionLoginStatusResponse> {
    this.prunePendingLogins();
    const pending = this.pendingLogins.get(loginId);
    if (pending) {
      if (pending.status.status !== "pending") {
        return pending.status;
      }
      if (Date.now() >= pending.expiresAt) {
        pending.status = {
          error: "Timed out waiting for Claude login.",
          loginId,
          status: "failed",
        };
        return pending.status;
      }
      const account = await this.getAuthState();
      if (account.authenticated) {
        pending.status = { account, loginId, status: "completed" };
      }
      return pending.status;
    }
    const account = await this.getAuthState();
    return {
      ...(account.authenticated ? { account } : {}),
      ...(account.authenticated
        ? {}
        : { error: "Login session not found or expired." }),
      loginId,
      status: account.authenticated ? "completed" : "failed",
    };
  }

  async waitForLogin(
    loginId: string,
    signal?: AbortSignal
  ): Promise<SubscriptionLoginStatusResponse> {
    const started = Date.now();
    while (Date.now() - started < LOGIN_TTL_MS) {
      if (signal?.aborted) {
        return { loginId, status: "cancelled" };
      }
      const status = await this.getLoginStatus(loginId);
      if (status.status !== "pending") {
        return status;
      }
      await abortableDelay(LOGIN_POLL_INTERVAL_MS, signal);
    }
    return {
      error: "Timed out waiting for Claude login.",
      loginId,
      status: "failed",
    };
  }

  async cancelLogin(loginId: string): Promise<void> {
    this.prunePendingLogins();
    const pending = this.pendingLogins.get(loginId);
    this.pendingLogins.set(loginId, {
      expiresAt: pending?.expiresAt ?? Date.now() + LOGIN_TTL_MS,
      loginId,
      status: { loginId, status: "cancelled" },
    });
  }

  async logout(): Promise<SubscriptionAuthState> {
    await deleteSubscriptionProviderSessions(
      "claude",
      (candidate) => this.deleteConversationSession(candidate.runtimeSessionId),
      async () => {
        await this.logoutNativeAccount();
        this.pendingLogins.clear();
      }
    );
    return this.getAuthState();
  }

  async listModels(): Promise<ProviderModelOption[]> {
    return await withSubscriptionProviderLease("claude", () =>
      this.listModelsWithinLease()
    );
  }

  private async listModelsWithinLease(): Promise<ProviderModelOption[]> {
    await this.requireAuthenticated();
    // Agent SDK model listing requires an active query. Avoid starting a billed
    // turn just to discover ids; execution reports the model that actually ran.
    return FALLBACK_CLAUDE_MODELS;
  }

  async generateChat(
    input: GenerateChatInput,
    model?: string
  ): Promise<ChatCompletionResult> {
    return await withSubscriptionSessionLease(
      "claude",
      input.conversationId,
      () => this.runQuery(input, undefined, model),
      (candidate) => this.deleteConversationSession(candidate.runtimeSessionId)
    );
  }

  async streamChat(
    input: GenerateChatInput,
    handlers: StreamChatHandlers,
    model?: string
  ): Promise<ChatCompletionResult> {
    return await withSubscriptionSessionLease(
      "claude",
      input.conversationId,
      () => this.runQuery(input, handlers, model),
      (candidate) => this.deleteConversationSession(candidate.runtimeSessionId)
    );
  }

  protected async logoutNativeAccount(): Promise<void> {
    const launch = resolveSubscriptionLaunch("claude");
    if (!launch) {
      return;
    }
    const output = await runClaudeCommand(launch.command, [
      ...launch.prefixArgs,
      "auth",
      "logout",
    ]);
    assertClaudeLogoutCommandSucceeded(output);
  }

  async deleteConversationSession(runtimeSessionId: string): Promise<void> {
    const sdk = await this.loadSdk();
    if (!sdk?.deleteSession) {
      throw new SubscriptionRuntimeError(
        "claude",
        "provider_unavailable",
        "Claude Agent SDK session deletion is unavailable. Reinstall Atlas dependencies before retrying."
      );
    }
    await sdk.deleteSession(runtimeSessionId, {
      dir: subscriptionWorkspaceDir("claude"),
    });
  }

  private async runQuery(
    input: GenerateChatInput,
    handlers?: StreamChatHandlers,
    model?: string
  ): Promise<ChatCompletionResult> {
    if (input.signal?.aborted) {
      throw new SubscriptionRuntimeError(
        "claude",
        "runtime_error",
        "Claude turn cancelled."
      );
    }
    await this.requireAuthenticated();
    const sdk = await this.loadSdk();
    if (!sdk) {
      throw new SubscriptionRuntimeError(
        "claude",
        "provider_unavailable",
        "Claude Agent SDK is not available. Install it before using the Claude subscription."
      );
    }

    const cwd = subscriptionWorkspaceDir("claude");
    await ensureDir(cwd);
    const conversationId = input.conversationId?.trim();
    const binding = conversationId
      ? await readSubscriptionSession("claude", conversationId)
      : null;
    const prompt = await formatSubscriptionPrompt(
      input,
      "claude",
      binding?.lastMessageCount
    );
    let resumeId: string | undefined;
    if (
      binding?.historyFingerprint &&
      binding.historyFingerprint === prompt.previousHistoryFingerprint &&
      prompt.continuation
    ) {
      resumeId = binding.runtimeSessionId;
    }
    if (conversationId && binding && !resumeId) {
      await clearSubscriptionSession("claude", conversationId);
    }

    if (input.signal?.aborted) {
      throw new SubscriptionRuntimeError(
        "claude",
        "runtime_error",
        "Claude turn cancelled."
      );
    }

    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    input.signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      abortController.abort();
    }, this.turnTimeoutMs);

    const claudeLaunch = resolveSubscriptionLaunch("claude");
    const thinkingOptions = claudeThinkingOptions(
      input.providerOptions?.thinking
    );

    let text = "";
    let thinking = "";
    let sessionId = resumeId;
    let actualModel: string | undefined;
    let usage: ChatCompletionResult["usage"];
    const bufferText = Boolean(input.tools?.length);
    let handle: ClaudeQueryHandle | undefined;
    try {
      handle = sdk.query({
        options: {
          abortController,
          allowedTools: [],
          cwd,
          env: buildSubscriptionRuntimeEnv("claude"),
          includePartialMessages: Boolean(handlers),
          maxTurns: 1,
          mcpServers: {},
          permissionMode: "dontAsk",
          persistSession: Boolean(conversationId),
          settingSources: [],
          skills: [],
          systemPrompt: prompt.developerInstructions,
          tools: [],
          ...thinkingOptions,
          ...(claudeLaunch && claudeLaunch.prefixArgs.length === 0
            ? { pathToClaudeCodeExecutable: claudeLaunch.command }
            : {}),
          ...(model ? { model } : {}),
          ...(resumeId ? { resume: resumeId } : {}),
        },
        prompt: resumeId ? prompt.continuation : prompt.transcript,
      });
      const iterator = handle[Symbol.asyncIterator]();
      while (true) {
        const next = await waitForIteratorResult(
          iterator.next(),
          abortController.signal,
          () => (timedOut ? "Claude turn timed out." : "Claude turn cancelled.")
        );
        if (next.done) {
          break;
        }
        const message = next.value;
        const parsed = readClaudeMessage(message);
        if (parsed.sessionId) {
          sessionId = parsed.sessionId;
        }
        if (parsed.model) {
          actualModel = parsed.model;
        }
        if (parsed.usage) {
          usage = parsed.usage;
        }
        if (parsed.thinkingDelta && handlers?.onThinking) {
          const next = appendDelta(thinking, parsed.thinkingDelta);
          thinking = next.text;
          if (next.delta) {
            handlers.onThinking(next.delta);
          }
        }
        if (parsed.textDelta) {
          const next = appendDelta(text, parsed.textDelta);
          text = next.text;
          if (next.delta && !bufferText) {
            handlers?.onChunk(next.delta);
          }
        } else if (parsed.text) {
          text = parsed.text;
        }
        if (parsed.error) {
          throwSubscriptionError("claude", parsed.error);
        }
      }
    } catch (error) {
      if (conversationId && sessionId) {
        await clearSubscriptionSession("claude", conversationId);
        if (!resumeId || sessionId !== resumeId) {
          await deleteUnpersistedSubscriptionSession(
            "claude",
            conversationId,
            sessionId,
            (candidate) =>
              this.deleteConversationSession(candidate.runtimeSessionId)
          ).catch(() => undefined);
        }
      }
      if (error instanceof SubscriptionRuntimeError) {
        throw error;
      }
      if (timedOut) {
        throw new SubscriptionRuntimeError(
          "claude",
          "runtime_error",
          "Claude turn timed out."
        );
      }
      if (input.signal?.aborted) {
        throw new SubscriptionRuntimeError(
          "claude",
          "runtime_error",
          "Claude turn cancelled."
        );
      }
      throwSubscriptionError(
        "claude",
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onAbort);
      if (abortController.signal.aborted) {
        const interruption = handle?.interrupt?.();
        void interruption?.catch(() => undefined);
      }
      try {
        handle?.close?.();
      } catch {
        // The result or runtime error has already been captured.
      }
    }

    if (actualModel && model && actualModel !== model) {
      // Surface substitution instead of pretending the requested model ran.
      text = text.trim()
        ? `${text.trim()}\n\n[Model used: ${actualModel}]`
        : `[Model used: ${actualModel}]`;
    }

    if (conversationId && sessionId) {
      try {
        await writeSubscriptionSession("claude", conversationId, {
          historyFingerprint: prompt.historyFingerprint,
          lastMessageCount: input.messages.length,
          runtimeSessionId: sessionId,
        });
      } catch {
        try {
          await deleteUnpersistedSubscriptionSession(
            "claude",
            conversationId,
            sessionId,
            (candidate) =>
              this.deleteConversationSession(candidate.runtimeSessionId)
          );
        } catch {
          throw new SubscriptionRuntimeError(
            "claude",
            "runtime_error",
            "Claude completed the turn, but Atlas could not persist or delete its native session. Retry after checking host storage and the Claude runtime."
          );
        }
      }
    } else if (conversationId && !sessionId) {
      await clearSubscriptionSession("claude", conversationId);
    }

    const result = parseSubscriptionResponse(text, thinking, usage);
    if (bufferText && result.content) {
      handlers?.onChunk(result.content);
    }
    return result;
  }

  private async requireAuthenticated(): Promise<void> {
    const state = await this.getAuthState();
    if (state.status === "not_installed") {
      throw new SubscriptionRuntimeError(
        "claude",
        "provider_unavailable",
        state.message ?? claudeInstallHint()
      );
    }
    if (!state.authenticated) {
      throw new SubscriptionRuntimeError(
        "claude",
        "authentication_expired",
        state.message ??
          "Claude is not authenticated. Run the provided login command and try again."
      );
    }
  }

  private async loadSdk(): Promise<ClaudeAgentSdk | null> {
    if (this.sdk !== undefined) {
      return this.sdk;
    }
    try {
      this.sdk = (await import(
        "@anthropic-ai/claude-agent-sdk"
      )) as ClaudeAgentSdk;
      return this.sdk;
    } catch {
      this.sdk = null;
      return null;
    }
  }

  private prunePendingLogins(): void {
    const now = Date.now();
    for (const [loginId, pending] of this.pendingLogins) {
      if (pending.expiresAt <= now) {
        this.pendingLogins.delete(loginId);
      }
    }
    while (this.pendingLogins.size >= MAX_PENDING_LOGINS) {
      const oldestTerminalLogin = [...this.pendingLogins.entries()].find(
        ([, pending]) => pending.status.status !== "pending"
      );
      if (!oldestTerminalLogin) {
        break;
      }
      this.pendingLogins.delete(oldestTerminalLogin[0]);
    }
  }
}

function claudeThinkingOptions(
  thinking: NonNullable<GenerateChatInput["providerOptions"]>["thinking"]
): Record<string, unknown> {
  if (!thinking) {
    return {};
  }
  if (!thinking.enabled) {
    return { thinking: { type: "disabled" } };
  }
  const effort = thinking.effort?.trim().toLowerCase();
  return {
    ...(effort && CLAUDE_EFFORTS.has(effort) ? { effort } : {}),
    thinking: { display: "summarized", type: "adaptive" },
  };
}

function readClaudeMessage(message: unknown): {
  error?: string;
  model?: string;
  sessionId?: string;
  text?: string;
  textDelta?: string;
  thinkingDelta?: string;
  usage?: ChatCompletionResult["usage"];
} {
  const record = asRecord(message);
  const sessionId =
    readString(record.session_id) ?? readString(record.sessionId);
  const type = readString(record.type);
  if (type === "assistant") {
    const assistantMessage = asRecord(record.message);
    return {
      model: readString(assistantMessage.model),
      sessionId,
      text: extractAssistantText(record),
      thinkingDelta: extractThinking(record),
    };
  }
  if (type === "stream_event" || type === "partial") {
    const event = asRecord(record.event ?? record.message);
    const delta = asRecord(event.delta);
    return {
      sessionId,
      textDelta:
        readText(delta.text) ?? readText(event.text) ?? readText(record.text),
      thinkingDelta: readText(delta.thinking) ?? readText(event.thinking),
    };
  }
  if (type === "result") {
    const usage = asRecord(record.usage);
    const subtype = readString(record.subtype);
    const errors = readStringArray(record.errors);
    const isError = record.is_error === true || subtype !== "success";
    return {
      error: isError
        ? errors.join("; ") || readText(record.result) || "Claude query failed."
        : undefined,
      model: readString(record.model),
      sessionId,
      text: isError
        ? undefined
        : (readText(record.result) ?? extractAssistantText(record)),
      usage: buildTokenUsage({
        inputTokens: usage.input_tokens ?? usage.inputTokens,
        outputTokens: usage.output_tokens ?? usage.outputTokens,
      }),
    };
  }
  return { sessionId };
}

function extractAssistantText(record: Record<string, unknown>): string {
  const message = asRecord(record.message);
  const content = message.content ?? record.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      const item = asRecord(block);
      return item.type === "text" ? (readText(item.text) ?? "") : "";
    })
    .join("");
}

function extractThinking(record: Record<string, unknown>): string | undefined {
  const message = asRecord(record.message);
  const content = message.content ?? record.content;
  if (!Array.isArray(content)) {
    return;
  }
  const thinking = content
    .map((block) => {
      const item = asRecord(block);
      return item.type === "thinking" ? (readText(item.thinking) ?? "") : "";
    })
    .join("");
  return thinking || undefined;
}

interface ClaudeAuthStatus {
  authenticated: boolean;
  email?: string;
  message?: string;
  plan?: string;
}

async function readClaudeAuthStatus(): Promise<ClaudeAuthStatus> {
  const launch = resolveSubscriptionLaunch("claude");
  if (!launch) {
    return { authenticated: false };
  }
  const output = await runClaudeCommand(launch.command, [
    ...launch.prefixArgs,
    "auth",
    "status",
    "--json",
  ]);
  return parseClaudeAuthStatusOutput(output);
}

export function parseClaudeAuthStatusOutput(output: {
  exitCode: number | null;
  stderr: string;
  stdout: string;
}): ClaudeAuthStatus {
  const combined = `${output.stdout}\n${output.stderr}`.trim();
  const json = parseJsonRecord(output.stdout);
  if (typeof json?.loggedIn === "boolean") {
    const authMethod = readString(json.authMethod)?.toLowerCase();
    if (!json.loggedIn || authMethod !== "oauth") {
      return {
        authenticated: false,
        message: json.loggedIn
          ? "Claude is authenticated without an OAuth subscription. Sign out first, then run the provided login command."
          : "Claude is not authenticated. Run the provided login command and try again.",
      };
    }
    return {
      authenticated: true,
      ...(readString(json.email) ? { email: readString(json.email) } : {}),
      ...(readString(json.subscriptionType) || readString(json.plan)
        ? { plan: readString(json.subscriptionType) ?? readString(json.plan) }
        : {}),
    };
  }
  const lower = combined.toLowerCase();
  if (
    output.exitCode !== 0 &&
    (lower.includes("not logged") ||
      lower.includes("not authenticated") ||
      lower.includes("unauthenticated"))
  ) {
    return { authenticated: false, message: combined };
  }
  if (
    lower.includes("not logged") ||
    lower.includes("not authenticated") ||
    lower.includes("logged out")
  ) {
    return { authenticated: false, message: combined };
  }
  if (lower.includes("api key") || lower.includes("apikey")) {
    return {
      authenticated: false,
      message:
        "Claude is authenticated without an OAuth subscription. Sign out first, then run the provided login command.",
    };
  }
  if (/\b(?:logged in|authenticated)\s*[:=]\s*(?:false|no)\b/.test(lower)) {
    return { authenticated: false, message: combined || undefined };
  }
  if (lower.includes("logged in") || lower.includes("authenticated")) {
    return {
      authenticated: true,
      ...(extractField(combined, /email[:\s]+([^\s]+)/i)
        ? { email: extractField(combined, /email[:\s]+([^\s]+)/i) }
        : {}),
      ...(extractField(combined, /plan[:\s]+([A-Za-z0-9_-]+)/i)
        ? { plan: extractField(combined, /plan[:\s]+([A-Za-z0-9_-]+)/i) }
        : {}),
    };
  }
  return { authenticated: false, message: combined || undefined };
}

export function assertClaudeLogoutCommandSucceeded(output: {
  exitCode: number | null;
}): void {
  if (output.exitCode !== 0) {
    throw new SubscriptionRuntimeError(
      "claude",
      "runtime_error",
      "Claude logout failed on the Atlas host. Retry after checking the Claude runtime."
    );
  }
}

function extractField(text: string, pattern: RegExp): string | undefined {
  const match = text.match(pattern);
  return match?.[1]?.trim() || undefined;
}

async function runClaudeCommand(
  command: string,
  args: string[]
): Promise<{ exitCode: number | null; stderr: string; stdout: string }> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      env: buildSubscriptionRuntimeEnv("claude") as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let timedOut = false;
    const finish = (exitCode: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
      }
      resolve({ exitCode, stderr, stdout });
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      forceKillTimeout = setTimeout(() => {
        child.kill("SIGKILL");
        finish(null);
      }, FORCE_KILL_DELAY_MS);
    }, 10_000);
    child.stdout?.on("data", (chunk) => {
      stdout = appendBoundedCommandOutput(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = appendBoundedCommandOutput(stderr, chunk);
    });
    child.once("error", () => {
      finish(null);
    });
    child.once("close", (code) => {
      finish(timedOut ? null : code);
    });
  });
}

function appendBoundedCommandOutput(current: string, chunk: unknown): string {
  if (current.length >= MAX_COMMAND_OUTPUT_CHARS) {
    return current;
  }
  return `${current}${String(chunk).slice(
    0,
    MAX_COMMAND_OUTPUT_CHARS - current.length
  )}`;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForIteratorResult<T>(
  operation: PromiseLike<IteratorResult<T>>,
  signal: AbortSignal,
  abortMessage: () => string
): Promise<IteratorResult<T>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (
      result:
        | { error: Error; ok: false }
        | { ok: true; value: IteratorResult<T> }
    ) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (result.ok) {
        resolve(result.value);
      } else {
        reject(result.error);
      }
    };
    const onAbort = () => {
      finish({ error: new Error(abortMessage()), ok: false });
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => finish({ ok: true, value }),
      (error: unknown) =>
        finish({
          error: error instanceof Error ? error : new Error(String(error)),
          ok: false,
        })
    );
  });
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => readString(entry))
    .filter((entry): entry is string => Boolean(entry));
}

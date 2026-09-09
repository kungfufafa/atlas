import { spawn } from "node:child_process";
import type {
  createSdkMcpServer,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ChatCompletionResult,
  GenerateChatInput,
  ProviderModelIdentity,
  ProviderModelOption,
  StreamChatHandlers,
  SubscriptionAuthState,
  SubscriptionLoginStartResponse,
  SubscriptionLoginStatusResponse,
} from "@atlas/core";
import { ensureDir } from "@atlas/core";
import { captureProviderFailureEvidence } from "../../failure-evidence";
import { buildChatCompletionResult } from "../../shared";
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
import {
  type ClaudeInferenceClock,
  createClaudeInferenceDeadline,
} from "./inference-deadline";
import {
  type ClaudeRuntimeModel,
  claudeModelOptions,
  claudeThinkingOptions,
  readClaudeContextUsage,
  readClaudeTokenUsage,
} from "./metadata";
import { createClaudeToolBridge } from "./structured-tool-bridge";

const FALLBACK_CLAUDE_MODELS: ProviderModelOption[] = [
  {
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
const MODEL_DISCOVERY_TIMEOUT_MS = 20_000;
const CONTEXT_USAGE_TIMEOUT_MS = 3000;
const MODEL_METADATA_TTL_MS = 60_000;

interface PendingLogin {
  expiresAt: number;
  loginId: string;
  status: SubscriptionLoginStatusResponse;
}

export interface ClaudeQueryHandle {
  close?: () => void;
  getContextUsage?: () => Promise<unknown>;
  interrupt?: () => Promise<void>;
  supportedModels?: () => Promise<ClaudeRuntimeModel[]>;
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
}

export interface ClaudeAgentSdk {
  createSdkMcpServer?: typeof createSdkMcpServer;
  deleteSession?: (
    sessionId: string,
    options?: { dir?: string }
  ) => Promise<void>;
  query(input: {
    options?: Record<string, unknown>;
    prompt: string | AsyncIterable<SDKUserMessage>;
  }): ClaudeQueryHandle;
}

export interface ClaudeSubscriptionRuntimeOptions {
  /** Test clock for deterministic inference-budget verification. */
  inferenceClock?: ClaudeInferenceClock;
  sdk?: ClaudeAgentSdk;
  /** Cumulative native inference time; caller signals still bound the whole turn. */
  turnTimeoutMs?: number;
}

export class ClaudeSubscriptionRuntime {
  private loginStarting = false;
  private readonly pendingLogins = new Map<string, PendingLogin>();
  private sdk: ClaudeAgentSdk | null | undefined;
  private modelMetadata?: { models: ClaudeRuntimeModel[]; readAt: number };
  private readonly turnTimeoutMs: number;
  private readonly inferenceClock?: ClaudeInferenceClock;

  constructor(options: ClaudeSubscriptionRuntimeOptions = {}) {
    this.sdk = options.sdk;
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.inferenceClock = options.inferenceClock;
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
        this.modelMetadata = undefined;
        this.pendingLogins.clear();
      }
    );
    return this.getAuthState();
  }

  async listModels(
    options: { requireRuntimeMetadata?: boolean } = {}
  ): Promise<ProviderModelOption[]> {
    return await withSubscriptionProviderLease("claude", () =>
      this.listModelsWithinLease(options.requireRuntimeMetadata === true)
    );
  }

  private async listModelsWithinLease(
    requireRuntimeMetadata: boolean
  ): Promise<ProviderModelOption[]> {
    await this.requireAuthenticated();
    const sdk = await this.loadSdk();
    const models = sdk ? await this.readModelMetadata(sdk) : undefined;
    if (requireRuntimeMetadata && !models?.length) {
      throw new SubscriptionRuntimeError(
        "claude",
        "model_unavailable",
        "The Claude runtime did not advertise an available model. Retry runtime model discovery before running the live gate."
      );
    }
    return models === undefined
      ? FALLBACK_CLAUDE_MODELS.map((model) => ({ ...model }))
      : claudeModelOptions(models);
  }

  private async readModelMetadata(
    sdk: ClaudeAgentSdk,
    signal?: AbortSignal
  ): Promise<ClaudeRuntimeModel[] | undefined> {
    if (
      this.modelMetadata &&
      Date.now() - this.modelMetadata.readAt < MODEL_METADATA_TTL_MS
    ) {
      return this.modelMetadata.models;
    }
    const cwd = subscriptionWorkspaceDir("claude");
    await ensureDir(cwd);
    const input = createClaudePromptStream();
    const abortController = new AbortController();
    const discoverySignal = AbortSignal.any([
      abortController.signal,
      AbortSignal.timeout(MODEL_DISCOVERY_TIMEOUT_MS),
      ...(signal ? [signal] : []),
    ]);
    let handle: ClaudeQueryHandle | undefined;
    try {
      // supportedModels reads the initialization response. Keeping streaming
      // input open without yielding a user message starts no inference turn.
      handle = sdk.query({
        options: {
          ...claudeRuntimeOptions(cwd, abortController),
          persistSession: false,
        },
        prompt: input.stream,
      });
      if (!handle.supportedModels) {
        return;
      }
      const models = await waitForClaudeOperation(
        handle.supportedModels(),
        discoverySignal,
        () => "Claude model discovery timed out or was cancelled."
      );
      this.modelMetadata = { models, readAt: Date.now() };
      return models;
    } finally {
      input.close();
      abortController.abort();
      handle?.close?.();
    }
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
    const abortController = new AbortController();
    let timedOut = false;
    const inferenceDeadline = createClaudeInferenceDeadline(
      this.turnTimeoutMs,
      abortController.signal,
      () => {
        timedOut = true;
        abortController.abort();
      },
      this.inferenceClock
    );
    const executeToolCall = input.executeToolCall;
    const toolBridge = createClaudeToolBridge(
      executeToolCall
        ? {
            ...input,
            executeToolCall: (call, signal) =>
              inferenceDeadline.duringHostExecution(() =>
                executeToolCall(call, signal)
              ),
          }
        : input,
      sdk,
      abortController
    );
    const promptInput = toolBridge ? { ...input, tools: undefined } : input;
    const prompt = await formatSubscriptionPrompt(
      promptInput,
      "claude",
      binding?.lastMessageCount
    );
    let resumeId: string | undefined;
    if (
      binding?.historyFingerprint &&
      binding.historyFingerprint === prompt.previousHistoryFingerprint &&
      binding.toolCatalogFingerprint === toolBridge?.fingerprint &&
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

    const onAbort = () => abortController.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    inferenceDeadline.start();

    let text = "";
    let thinking = "";
    let sessionId = resumeId;
    let modelIdentified = !model;
    const modelIdentity: ProviderModelIdentity | undefined = model
      ? {
          basis: "not-reported",
          reportedModels: [],
          requestedModel: model,
          verification: "unverifiable",
        }
      : undefined;
    const pendingDeltas: Array<{ kind: "text" | "thinking"; text: string }> =
      [];
    const emitDelta = (kind: "text" | "thinking", delta: string) => {
      if (!modelIdentified) {
        pendingDeltas.push({ kind, text: delta });
      } else if (kind === "text") {
        handlers?.onChunk(delta);
      } else {
        handlers?.onThinking?.(delta);
      }
    };
    const flushDeltas = () => {
      modelIdentified = true;
      for (const delta of pendingDeltas) {
        emitDelta(delta.kind, delta.text);
      }
      pendingDeltas.length = 0;
    };
    let usage: ChatCompletionResult["usage"];
    let contextUsage: ChatCompletionResult["contextUsage"];
    let result: ChatCompletionResult;
    let completed = false;
    const bufferText = !toolBridge && Boolean(input.tools?.length);
    let handle: ClaudeQueryHandle | undefined;
    const turnInput = createClaudePromptStream(
      resumeId ? prompt.continuation : prompt.transcript
    );
    try {
      const requestedThinking = input.providerOptions?.thinking;
      const models =
        model || requestedThinking?.enabled
          ? await this.readModelMetadata(sdk, abortController.signal)
          : undefined;
      const runtimeModel = model
        ? (models?.find((candidate) => candidate.value === model) ??
          models?.find((candidate) => candidate.resolvedModel === model))
        : undefined;
      if (model && models !== undefined && !runtimeModel) {
        throw new SubscriptionRuntimeError(
          "claude",
          "model_unavailable",
          "The selected Claude model was not advertised by the native runtime. Refresh model discovery and select an available model."
        );
      }
      const thinkingOptions = claudeThinkingOptions(
        requestedThinking,
        runtimeModel
      );
      handle = sdk.query({
        options: {
          ...claudeRuntimeOptions(cwd, abortController),
          includePartialMessages: Boolean(handlers),
          ...(toolBridge
            ? {
                allowedTools: toolBridge.allowedTools,
                canUseTool: async (
                  name: string,
                  args: Record<string, unknown>
                ) =>
                  toolBridge.allowedTools.includes(name)
                    ? { behavior: "allow", updatedInput: args }
                    : {
                        behavior: "deny",
                        message: "Only registered Atlas tools are available.",
                      },
                mcpServers: { atlas: toolBridge.server },
                strictMcpConfig: true,
              }
            : { maxTurns: 1 }),
          persistSession: Boolean(conversationId),
          systemPrompt: prompt.developerInstructions,
          ...thinkingOptions,
          ...(model ? { model } : {}),
          ...(resumeId ? { resume: resumeId } : {}),
        },
        prompt: turnInput.stream,
      });
      const iterator = handle[Symbol.asyncIterator]();
      while (true) {
        toolBridge?.assertHealthy();
        const next = await waitForClaudeOperation(
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
        if (parsed.usage) {
          usage = parsed.usage;
        }
        if (parsed.model) {
          recordClaudeModelIdentity(modelIdentity, parsed.model, runtimeModel);
          flushDeltas();
        }
        if (parsed.thinkingDelta) {
          thinking += parsed.thinkingDelta;
          emitDelta("thinking", parsed.thinkingDelta);
        } else if (parsed.thinking) {
          const next = appendDelta(thinking, parsed.thinking);
          thinking = next.text;
          if (next.delta) {
            emitDelta("thinking", next.delta);
          }
        }
        if (parsed.textDelta) {
          text += parsed.textDelta;
          if (!bufferText) {
            emitDelta("text", parsed.textDelta);
          }
        } else if (parsed.text) {
          const previousText = text;
          text = parsed.text;
          if (!bufferText && text.startsWith(previousText)) {
            const delta = text.slice(previousText.length);
            if (delta) {
              emitDelta("text", delta);
            }
          }
        }
        if (parsed.error) {
          throwSubscriptionError("claude", parsed.error);
        }
        if (parsed.completed) {
          completed = true;
          contextUsage = await captureClaudeContext(
            handle,
            abortController.signal
          );
          break;
        }
      }
      toolBridge?.assertComplete();
      if (!completed) {
        throw new SubscriptionRuntimeError(
          "claude",
          "runtime_error",
          "Claude ended the stream before completing the turn. Retry the request."
        );
      }
      // Missing native identity remains unknown. Never put runtime metadata in
      // the user's answer or guess alias equivalence from model names.
      flushDeltas();
      result = toolBridge
        ? buildChatCompletionResult({
            content: text.trim(),
            thinking,
            toolCalls: [],
            usage,
          })
        : parseSubscriptionResponse(text, thinking, usage);
      if (modelIdentity) {
        result.modelIdentity = modelIdentity;
      }
    } catch (error) {
      const evidence = {
        content: text,
        contextUsage,
        thinking,
        toolInputFragments: [],
        usage,
      };
      const runtimeError = captureProviderFailureEvidence(
        toolBridge?.failed ? toolBridge.failure : error,
        evidence
      );
      if (conversationId && sessionId) {
        try {
          await clearSubscriptionSession("claude", conversationId);
        } catch (cleanupError) {
          if (
            !toolBridge?.failed ||
            (await readSubscriptionSession("claude", conversationId))
          ) {
            // Cleanup keeps its existing precedence, identity, and cause.
            throw captureProviderFailureEvidence(cleanupError, evidence);
          }
        }
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
      if (
        runtimeError instanceof SubscriptionRuntimeError ||
        (toolBridge?.failed &&
          runtimeError !== null &&
          (typeof runtimeError === "object" ||
            typeof runtimeError === "function"))
      ) {
        throw runtimeError;
      }
      if (timedOut) {
        throw captureProviderFailureEvidence(
          new SubscriptionRuntimeError(
            "claude",
            "runtime_error",
            "Claude turn timed out.",
            { cause: runtimeError }
          ),
          evidence
        );
      }
      if (input.signal?.aborted) {
        throw captureProviderFailureEvidence(
          new SubscriptionRuntimeError(
            "claude",
            "runtime_error",
            "Claude turn cancelled.",
            { cause: runtimeError }
          ),
          evidence
        );
      }
      throwSubscriptionError(
        "claude",
        error instanceof Error ? error.message : String(error),
        undefined,
        runtimeError,
        evidence
      );
    } finally {
      turnInput.close();
      inferenceDeadline.stop();
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
      await toolBridge?.close().catch(() => undefined);
    }

    if (conversationId && sessionId) {
      try {
        const completedPrompt = toolBridge
          ? await formatSubscriptionPrompt(
              { ...promptInput, messages: toolBridge.history },
              "claude"
            )
          : prompt;
        await writeSubscriptionSession("claude", conversationId, {
          historyFingerprint: completedPrompt.historyFingerprint,
          lastMessageCount: toolBridge?.history.length ?? input.messages.length,
          runtimeSessionId: sessionId,
          ...(toolBridge
            ? { toolCatalogFingerprint: toolBridge.fingerprint }
            : {}),
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

    if (contextUsage) {
      result.contextUsage = contextUsage;
    }
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

function claudeRuntimeOptions(
  cwd: string,
  abortController: AbortController
): Record<string, unknown> {
  const launch = resolveSubscriptionLaunch("claude");
  return {
    abortController,
    allowedTools: [],
    cwd,
    env: buildSubscriptionRuntimeEnv("claude"),
    mcpServers: {},
    permissionMode: "dontAsk",
    settingSources: [],
    skills: [],
    tools: [],
    ...(launch && launch.prefixArgs.length === 0
      ? { pathToClaudeCodeExecutable: launch.command }
      : {}),
  };
}

function createClaudePromptStream(prompt?: string): {
  close: () => void;
  stream: AsyncIterable<SDKUserMessage>;
} {
  let close: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    close = resolve;
  });
  return {
    close,
    stream: {
      async *[Symbol.asyncIterator]() {
        if (prompt !== undefined) {
          yield {
            message: { content: prompt, role: "user" },
            parent_tool_use_id: null,
            session_id: "",
            type: "user",
          };
        }
        await closed;
      },
    },
  };
}

async function captureClaudeContext(
  handle: ClaudeQueryHandle,
  signal: AbortSignal
): Promise<ChatCompletionResult["contextUsage"]> {
  if (!handle.getContextUsage) {
    return;
  }
  try {
    const usage = await waitForClaudeOperation(
      handle.getContextUsage(),
      AbortSignal.any([signal, AbortSignal.timeout(CONTEXT_USAGE_TIMEOUT_MS)]),
      () => "Claude context accounting timed out."
    );
    return readClaudeContextUsage(usage);
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    // Older runtimes may not implement this control request. Cumulative
    // modelUsage is not a substitute for unknown native context occupancy.
  }
}

function readClaudeMessage(message: unknown): {
  completed?: boolean;
  error?: string;
  model?: string;
  sessionId?: string;
  text?: string;
  textDelta?: string;
  thinking?: string;
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
      thinking: extractThinking(record),
    };
  }
  if (type === "stream_event" || type === "partial") {
    const event = asRecord(record.event ?? record.message);
    const delta = asRecord(event.delta);
    return {
      model: readString(asRecord(event.message).model),
      sessionId,
      textDelta:
        readText(delta.text) ?? readText(event.text) ?? readText(record.text),
      thinkingDelta: readText(delta.thinking) ?? readText(event.thinking),
    };
  }
  if (type === "result") {
    const subtype = readString(record.subtype);
    const errors = readStringArray(record.errors);
    const isError = record.is_error === true || subtype !== "success";
    return {
      completed: true,
      error: isError
        ? errors.join("; ") || readText(record.result) || "Claude query failed."
        : undefined,
      model: readString(record.model),
      sessionId,
      text: isError
        ? undefined
        : (readText(record.result) ?? extractAssistantText(record)),
      usage: readClaudeTokenUsage(record),
    };
  }
  return { sessionId };
}

function recordClaudeModelIdentity(
  identity: ProviderModelIdentity | undefined,
  actual: string,
  advertised: ClaudeRuntimeModel | undefined
): void {
  if (!identity) {
    return;
  }
  if (!identity.reportedModels.includes(actual)) {
    identity.reportedModels.push(actual);
  }
  const exact = actual === identity.requestedModel;
  const resolved =
    Boolean(advertised?.resolvedModel) &&
    (actual === advertised?.value || actual === advertised?.resolvedModel);
  if (exact || resolved) {
    if (identity.basis !== "unresolved-alias") {
      identity.verification = "verified";
      identity.basis = exact ? "exact" : "advertised-resolution";
    }
    return;
  }
  if (
    advertised?.value === identity.requestedModel &&
    !advertised.resolvedModel
  ) {
    identity.verification = "unverifiable";
    identity.basis = "unresolved-alias";
    return;
  }
  throw new SubscriptionRuntimeError(
    "claude",
    "model_unavailable",
    advertised?.resolvedModel
      ? "The Claude runtime returned a different model from its advertised resolution. Refresh model discovery and retry with an available model."
      : "Atlas cannot verify the returned Claude model against the explicit selection. Refresh native model discovery or select the exact reported model before retrying."
  );
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

function waitForClaudeOperation<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal,
  abortMessage: () => string
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (
      result: { error: Error; ok: false } | { ok: true; value: T }
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

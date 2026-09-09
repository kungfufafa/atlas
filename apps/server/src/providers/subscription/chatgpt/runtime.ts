import { createHash } from "node:crypto";
import type {
  ChatCompletionResult,
  ChatMessage,
  GenerateChatInput,
  ProviderCapabilityClaim,
  ProviderCapabilityClaims,
  ProviderModelOption,
  StreamChatHandlers,
  SubscriptionAuthState,
  SubscriptionLoginStartResponse,
  SubscriptionLoginStatusResponse,
} from "@atlas/core";
import {
  computeActionHash,
  ensureDir,
  PROVIDER_CAPABILITY_IDS,
  toDataUrl,
} from "@atlas/core";
import { validateGeneratedImageOutput } from "../../../services/image-decoder-validation";
import {
  captureProviderFailureEvidence,
  getProviderFailureEvidence,
  type ProviderFailureEvidence,
} from "../../failure-evidence";
import { buildChatCompletionResult, buildTokenUsage } from "../../shared";
import {
  chatgptInstallHint,
  chatgptLoginCommand,
  probeRuntimeBinary,
} from "../binary";
import { shouldUseDeviceCodeLogin } from "../env";
import { SubscriptionRuntimeError, throwSubscriptionError } from "../errors";
import { formatSubscriptionPrompt, parseSubscriptionResponse } from "../prompt";
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
  type CodexAccount,
  CodexAppServer,
  type CodexDynamicTool,
  type CodexDynamicToolCall,
  type CodexDynamicToolResult,
  type CodexGeneratedImage,
  type CodexModel,
  type CodexTurnInput,
} from "./app-server";

interface PendingLogin {
  loginId: string;
  method: "browser" | "device";
  startedAt: number;
  status: SubscriptionLoginStatusResponse;
}

const LOGIN_TTL_MS = 15 * 60 * 1000;
const MAX_PENDING_LOGINS = 128;
const IMAGE_GENERATION_DEVELOPER_INSTRUCTIONS =
  "Use the image generation tool exactly once for the user's request. Do not use any other tool and do not create more than one image.";
const CHATGPT_IMAGE_INPUT_DETAIL = "high" as const;
const CHATGPT_NATIVE_IMAGE_SIZE_CONSTRAINTS: NonNullable<
  ProviderCapabilityClaim["constraints"]
> = {
  supportedValues: { size: ["auto"] },
};

export class ChatgptSubscriptionRuntime {
  private loginStarting = false;
  private readonly pendingLogins = new Map<string, PendingLogin>();
  private server: CodexAppServer;

  constructor(server?: CodexAppServer) {
    this.server = server ?? new CodexAppServer();
  }

  async getAuthState(): Promise<SubscriptionAuthState> {
    const probe = this.server.isConnected()
      ? { command: "codex", installed: true, version: null }
      : await probeRuntimeBinary("chatgpt", "codex");
    if (!probe.installed) {
      return {
        authenticated: false,
        installHint: chatgptInstallHint(),
        loginCommand: chatgptLoginCommand(),
        message:
          "Codex runtime is not available. Reinstall Atlas dependencies to restore the bundled Codex binary.",
        provider: "chatgpt",
        runtimeVersion: probe.version,
        status: "not_installed",
      };
    }

    try {
      const account = await this.server.account();
      return accountState(account, probe.version);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        authenticated: false,
        installHint: chatgptInstallHint(),
        loginCommand: chatgptLoginCommand(),
        message,
        provider: "chatgpt",
        runtimeVersion: probe.version,
        status: "error",
      };
    }
  }

  async startLogin(options?: {
    method?: "browser" | "device";
  }): Promise<SubscriptionLoginStartResponse> {
    this.prunePendingLogins();
    if (this.loginStarting) {
      throw new SubscriptionRuntimeError(
        "chatgpt",
        "runtime_error",
        "A ChatGPT login is already being started."
      );
    }
    this.loginStarting = true;
    try {
      const state = await this.getAuthState();
      if (state.status === "not_installed") {
        throw new SubscriptionRuntimeError(
          "chatgpt",
          "provider_unavailable",
          state.message ?? chatgptInstallHint()
        );
      }
      if (state.authenticated) {
        const loginId = crypto.randomUUID();
        this.pendingLogins.set(loginId, {
          loginId,
          method: "browser",
          startedAt: Date.now(),
          status: { account: state, loginId, status: "completed" },
        });
        return {
          instructions: "ChatGPT is already authenticated through Codex.",
          loginId,
          method: "browser",
        };
      }
      if (
        [...this.pendingLogins.values()].some(
          (login) => login.status.status === "pending"
        )
      ) {
        throw new SubscriptionRuntimeError(
          "chatgpt",
          "runtime_error",
          "A ChatGPT login is already in progress. Cancel it before starting another."
        );
      }

      const method =
        options?.method ?? (shouldUseDeviceCodeLogin() ? "device" : "browser");
      const started = await this.server.startLogin(
        method === "device" ? "chatgptDeviceCode" : "chatgpt"
      );
      this.pendingLogins.set(started.loginId, {
        loginId: started.loginId,
        method,
        startedAt: Date.now(),
        status: { loginId: started.loginId, status: "pending" },
      });
      void this.watchLogin(started.loginId);

      if (method === "device") {
        return {
          instructions:
            "Open the verification URL, sign in with ChatGPT, and enter the device code.",
          loginId: started.loginId,
          method,
          ...(started.verificationUrl
            ? { verificationUrl: started.verificationUrl }
            : {}),
          ...(started.userCode ? { userCode: started.userCode } : {}),
        };
      }

      return {
        instructions:
          "Open the ChatGPT login URL and finish sign-in in the browser.",
        loginId: started.loginId,
        method,
        ...(started.authUrl ? { authUrl: started.authUrl } : {}),
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
    const pending = this.pendingLogins.get(loginId);
    if (!pending) {
      return this.getLoginStatus(loginId);
    }
    if (pending.status.status !== "pending") {
      return pending.status;
    }
    try {
      await this.server.waitForLogin(loginId, signal);
      const terminalStatus = this.readTerminalLoginStatus(loginId);
      if (terminalStatus) {
        return terminalStatus;
      }
      const account = await this.getAuthState();
      const statusAfterAuth = this.readTerminalLoginStatus(loginId);
      if (statusAfterAuth) {
        return statusAfterAuth;
      }
      const status: SubscriptionLoginStatusResponse = {
        account,
        loginId,
        status: account.authenticated ? "completed" : "failed",
        ...(account.authenticated
          ? {}
          : { error: "Codex login finished without a ChatGPT account." }),
      };
      this.pendingLogins.set(loginId, {
        loginId,
        method: pending?.method ?? "browser",
        startedAt: pending?.startedAt ?? Date.now(),
        status,
      });
      return status;
    } catch (error) {
      const terminalStatus = this.readTerminalLoginStatus(loginId);
      if (terminalStatus) {
        return terminalStatus;
      }
      if (signal?.aborted) {
        return { loginId, status: "cancelled" };
      }
      const message = error instanceof Error ? error.message : String(error);
      const status: SubscriptionLoginStatusResponse = {
        error: message,
        loginId,
        status: "failed",
      };
      this.pendingLogins.set(loginId, {
        loginId,
        method: pending?.method ?? "browser",
        startedAt: pending?.startedAt ?? Date.now(),
        status,
      });
      return status;
    }
  }

  async cancelLogin(loginId: string): Promise<void> {
    const pending = this.pendingLogins.get(loginId);
    this.pendingLogins.set(loginId, {
      loginId,
      method: pending?.method ?? "browser",
      startedAt: pending?.startedAt ?? Date.now(),
      status: { loginId, status: "cancelled" },
    });
    try {
      await this.server.cancelLogin(loginId);
    } catch {
      // Login may already have finished.
    }
  }

  async logout(): Promise<SubscriptionAuthState> {
    await deleteSubscriptionProviderSessions(
      "chatgpt",
      (candidate) => this.deleteConversationSession(candidate.runtimeSessionId),
      async () => {
        await this.server.logout();
        this.pendingLogins.clear();
      }
    );
    return this.getAuthState();
  }

  async listModels(): Promise<ProviderModelOption[]> {
    return await withSubscriptionProviderLease("chatgpt", () =>
      this.listModelsWithinLease()
    );
  }

  private async listModelsWithinLease(): Promise<ProviderModelOption[]> {
    await this.requireChatgptAccount();
    try {
      const [models, providerCapabilities] = await Promise.all([
        this.server.listModels(),
        this.server.readModelProviderCapabilities(),
      ]);
      const hasDeclaredDefault = models.some((model) => model.isDefault);
      return models.map((model, index) => {
        const capabilities = runtimeModelCapabilities(
          model,
          providerCapabilities?.imageGeneration
        );
        const reasoningEffortValues = model.reasoningEffortValues;
        const hasReasoningMetadata = reasoningEffortValues !== undefined;
        const hasModalityMetadata = model.inputModalities !== undefined;
        return {
          ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
          default: model.isDefault ?? (!hasDeclaredDefault && index === 0),
          ...(model.defaultReasoningEffort
            ? { defaultReasoningEffort: model.defaultReasoningEffort }
            : {}),
          id: model.id,
          name: model.displayName ?? model.id,
          provider: "chatgpt",
          ...(reasoningEffortValues?.length
            ? {
                reasoningEffortValues,
              }
            : {}),
          ...(hasReasoningMetadata
            ? { supportsThinking: reasoningEffortValues.length > 0 }
            : {}),
          ...(hasModalityMetadata
            ? {
                supportsVision:
                  model.inputModalities?.includes("image") === true,
              }
            : {}),
        };
      });
    } catch (error) {
      throwSubscriptionError(
        "chatgpt",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  async generateChat(
    input: GenerateChatInput,
    model?: string
  ): Promise<ChatCompletionResult> {
    return await withSubscriptionSessionLease(
      "chatgpt",
      input.conversationId,
      () => this.runTurn(input, undefined, model),
      (candidate) => this.server.deleteThread(candidate.runtimeSessionId)
    );
  }

  async streamChat(
    input: GenerateChatInput,
    handlers: StreamChatHandlers,
    model?: string
  ): Promise<ChatCompletionResult> {
    return await withSubscriptionSessionLease(
      "chatgpt",
      input.conversationId,
      () => this.runTurn(input, handlers, model),
      (candidate) => this.server.deleteThread(candidate.runtimeSessionId)
    );
  }

  close(): void {
    this.server.close();
  }

  async deleteConversationSession(runtimeSessionId: string): Promise<void> {
    await this.server.deleteThread(runtimeSessionId);
  }

  async generateImage(
    input: { prompt: string; size: string },
    model: string
  ): Promise<CodexGeneratedImage> {
    return await withSubscriptionProviderLease("chatgpt", () =>
      this.generateImageWithinLease(input, model)
    );
  }

  private async generateImageWithinLease(
    input: { prompt: string; size: string },
    model: string
  ): Promise<CodexGeneratedImage> {
    await this.requireChatgptAccount();
    const selectedModel = await this.requireRuntimeModel(model);
    const providerCapabilities =
      await this.server.readModelProviderCapabilities();
    if (!providerCapabilities.imageGeneration) {
      throw new SubscriptionRuntimeError(
        "chatgpt",
        "provider_unavailable",
        "The connected ChatGPT Codex runtime does not advertise native image generation."
      );
    }

    const cwd = subscriptionWorkspaceDir("chatgpt");
    await ensureDir(cwd);
    const cleanupConversationId =
      createOneShotCleanupConversationId("image-generation");
    const threadId = await this.server.startThread({
      cwd,
      developerInstructions: IMAGE_GENERATION_DEVELOPER_INSTRUCTIONS,
      // Codex rejects thread/delete for ephemeral threads. Persist this
      // isolated tool-only thread just long enough to delete it in finally.
      ephemeral: false,
      imageGeneration: true,
      model: selectedModel.id,
    });

    try {
      const turn = await this.server.startTurn({
        input: [
          textCodexInput(imageGenerationPrompt(input.prompt, input.size)),
        ],
        model: selectedModel.id,
        summary: "none",
        threadId,
      });
      const generatedImages = turn.generatedImages ?? [];
      if (generatedImages.length !== 1) {
        throw new SubscriptionRuntimeError(
          "chatgpt",
          "runtime_error",
          generatedImages.length === 0
            ? "ChatGPT completed without returning a generated image."
            : "ChatGPT returned more than one generated image for a single-image request."
        );
      }

      const image = generatedImages[0];
      if (!image) {
        throw new SubscriptionRuntimeError(
          "chatgpt",
          "runtime_error",
          "ChatGPT completed without returning a generated image."
        );
      }
      if (image.failure?.type === "usageLimitExceeded") {
        const reset = image.failure.resetsAt
          ? ` Reset: ${new Date(image.failure.resetsAt * 1000).toISOString()}.`
          : "";
        throw new SubscriptionRuntimeError(
          "chatgpt",
          "subscription_limit_reached",
          `ChatGPT image generation limit reached.${reset} Atlas will not fall back to an API key.`
        );
      }
      if (image.status !== "completed" || !image.data || !image.mediaType) {
        throw new SubscriptionRuntimeError(
          "chatgpt",
          "runtime_error",
          "ChatGPT image generation did not complete successfully."
        );
      }
      const dimensions = await validateGeneratedImageOutput(
        image.data,
        image.mediaType
      );
      return { ...image, ...dimensions };
    } finally {
      await deleteUnpersistedSubscriptionSession(
        "chatgpt",
        cleanupConversationId,
        threadId,
        (candidate) => this.server.deleteThread(candidate.runtimeSessionId)
      ).catch(() => undefined);
    }
  }

  private async runTurn(
    input: GenerateChatInput,
    handlers?: StreamChatHandlers,
    model?: string
  ): Promise<ChatCompletionResult> {
    input.signal?.throwIfAborted();
    await this.requireChatgptAccount(input.signal);
    input.signal?.throwIfAborted();
    const cwd = subscriptionWorkspaceDir("chatgpt");
    await ensureDir(cwd);

    const conversationId = input.conversationId?.trim();
    const oneShotCleanupConversationId = conversationId
      ? null
      : createOneShotCleanupConversationId("chat");
    const binding = conversationId
      ? await readSubscriptionSession("chatgpt", conversationId)
      : null;
    const toolBridge = createCodexToolBridge(input);
    const promptInput = toolBridge ? { ...input, tools: undefined } : input;
    const prompt = await formatSubscriptionPrompt(
      promptInput,
      "chatgpt",
      binding?.lastMessageCount
    );
    input.signal?.throwIfAborted();
    const selectedRuntimeModel = await this.requireRuntimeModel(
      model,
      input.signal
    );
    input.signal?.throwIfAborted();
    let threadId: string | null = null;
    let resume = false;
    let startedNewThread = false;
    let sessionPersisted = false;
    let persistenceCleanupAttempted = false;
    let completedTurnEvidence: ProviderFailureEvidence | undefined;
    let deliveryFailed = false;
    let deliveryFailure: unknown;
    if (conversationId && binding) {
      const historyMatches =
        Boolean(binding.historyFingerprint) &&
        binding.historyFingerprint === prompt.previousHistoryFingerprint;
      const toolCatalogMatches =
        binding.toolCatalogFingerprint === toolBridge?.fingerprint;
      if (historyMatches && toolCatalogMatches && prompt.continuation) {
        try {
          input.signal?.throwIfAborted();
          threadId = await this.server.resumeThread(binding.runtimeSessionId, {
            cwd,
            developerInstructions: prompt.developerInstructions,
            model: selectedRuntimeModel.id,
          });
          resume = true;
        } catch {
          // The stale binding is cleared and deleted below.
        }
      }
      if (!resume) {
        await clearSubscriptionSession("chatgpt", conversationId);
      }
    }

    const turnInput = resume
      ? toCodexTurnInput(prompt.continuationInput)
      : toCodexTurnInput(prompt.transcriptInput);
    if (turnInput.some((part) => part.type === "image")) {
      this.requireImageInputModel(selectedRuntimeModel);
    }
    const thinkingOptions = resolveThinkingTurnOptions(
      input.providerOptions?.thinking,
      selectedRuntimeModel
    );

    try {
      input.signal?.throwIfAborted();
      if (!threadId) {
        threadId = await this.server.startThread({
          cwd,
          developerInstructions: prompt.developerInstructions,
          ephemeral: false,
          ...(toolBridge ? { dynamicTools: toolBridge.tools } : {}),
          model: selectedRuntimeModel.id,
        });
        startedNewThread = true;
      }
      input.signal?.throwIfAborted();
      const bufferText = !toolBridge && Boolean(input.tools?.length);
      const turn = await this.server.startTurn({
        ...thinkingOptions,
        input: turnInput,
        model: selectedRuntimeModel.id,
        onDelta: bufferText ? undefined : handlers?.onChunk,
        onThinking: handlers?.onThinking,
        ...(toolBridge ? { onToolCall: toolBridge.execute } : {}),
        signal: input.signal,
        threadId,
      });
      completedTurnEvidence = {
        content: turn.text,
        contextUsage: turn.contextUsage,
        thinking: turn.thinking,
        toolInputFragments: [],
        usage: turn.usage,
      };
      if (conversationId) {
        const completedPrompt = toolBridge
          ? await formatSubscriptionPrompt(
              { ...promptInput, messages: toolBridge.history },
              "chatgpt"
            )
          : prompt;
        try {
          await writeSubscriptionSession("chatgpt", conversationId, {
            historyFingerprint: completedPrompt.historyFingerprint,
            lastMessageCount:
              toolBridge?.history.length ?? input.messages.length,
            runtimeSessionId: threadId,
            ...(toolBridge
              ? { toolCatalogFingerprint: toolBridge.fingerprint }
              : {}),
          });
          sessionPersisted = true;
        } catch {
          persistenceCleanupAttempted = true;
          try {
            await deleteUnpersistedSubscriptionSession(
              "chatgpt",
              conversationId,
              threadId,
              (candidate) =>
                this.server.deleteThread(candidate.runtimeSessionId)
            );
          } catch {
            throw new SubscriptionRuntimeError(
              "chatgpt",
              "runtime_error",
              "ChatGPT completed the turn, but Atlas could not persist or delete its native session. Retry after checking host storage and the Codex runtime."
            );
          }
        }
      }
      // Missing explicit input/output counters remain unknown. Do not derive a
      // missing counter from a total, context occupancy, or a prior snapshot.
      const inputTokens = turn.usage?.inputTokens;
      const outputTokens = turn.usage?.outputTokens;
      const completeUsage =
        typeof inputTokens === "number" &&
        Number.isSafeInteger(inputTokens) &&
        inputTokens >= 0 &&
        typeof outputTokens === "number" &&
        Number.isSafeInteger(outputTokens) &&
        outputTokens >= 0;
      const usage = completeUsage
        ? buildTokenUsage({
            inputTokens,
            outputTokens,
            totalTokens: turn.usage?.totalTokens,
          })
        : undefined;
      const result = toolBridge
        ? buildChatCompletionResult({
            content: turn.text,
            thinking: turn.thinking,
            toolCalls: [],
            usage,
          })
        : parseSubscriptionResponse(turn.text, turn.thinking, usage);
      if (turn.contextUsage) {
        result.contextUsage = turn.contextUsage;
      }
      completedTurnEvidence.toolInputFragments = result.toolCalls.map(
        (call) => ({
          arguments: JSON.stringify(call.arguments),
          id: call.id,
          name: call.name,
        })
      );
      if (bufferText && result.content) {
        try {
          handlers?.onChunk(result.content);
        } catch (error) {
          deliveryFailed = true;
          deliveryFailure = error;
          throw error;
        }
      }
      return result;
    } catch (error) {
      // A reused callback error or its cause may still carry an earlier turn's
      // counters. Once this turn completed, its snapshot is authoritative.
      const evidence =
        completedTurnEvidence ?? getProviderFailureEvidence(error);
      if (evidence) {
        captureProviderFailureEvidence(error, evidence);
      }
      if (conversationId && (resume || sessionPersisted)) {
        try {
          await clearSubscriptionSession("chatgpt", conversationId);
        } catch (cleanupError) {
          // Once invalidation is durable, native deletion can retry from the
          // cleanup queue without converting an Atlas approval into a failure.
          if (
            !toolBridge?.failedWith(error) ||
            (await readSubscriptionSession("chatgpt", conversationId))
          ) {
            // Cleanup still supersedes the original error; copying diagnostics
            // does not change the cleanup/approval object's identity or cause.
            throw evidence
              ? captureProviderFailureEvidence(cleanupError, evidence)
              : cleanupError;
          }
        }
      }
      if (
        conversationId &&
        startedNewThread &&
        threadId &&
        !sessionPersisted &&
        !persistenceCleanupAttempted
      ) {
        await deleteUnpersistedSubscriptionSession(
          "chatgpt",
          conversationId,
          threadId,
          (candidate) => this.server.deleteThread(candidate.runtimeSessionId)
        ).catch(() => undefined);
      }
      if (
        error instanceof SubscriptionRuntimeError ||
        toolBridge?.failedWith(error) ||
        (deliveryFailed &&
          error === deliveryFailure &&
          error !== null &&
          (typeof error === "object" || typeof error === "function"))
      ) {
        throw error;
      }
      return throwSubscriptionError(
        "chatgpt",
        error instanceof Error ? error.message : String(error),
        undefined,
        error,
        evidence
      );
    } finally {
      if (oneShotCleanupConversationId && threadId) {
        await deleteUnpersistedSubscriptionSession(
          "chatgpt",
          oneShotCleanupConversationId,
          threadId,
          (candidate) => this.server.deleteThread(candidate.runtimeSessionId)
        ).catch(() => undefined);
      }
    }
  }

  private async requireChatgptAccount(
    signal?: AbortSignal
  ): Promise<CodexAccount> {
    signal?.throwIfAborted();
    const state = await waitForChatgptPreflight(this.getAuthState(), signal);
    signal?.throwIfAborted();
    if (state.status === "not_installed") {
      throw new SubscriptionRuntimeError(
        "chatgpt",
        "provider_unavailable",
        state.message ?? chatgptInstallHint()
      );
    }
    const account = await waitForChatgptPreflight(
      this.server.account(),
      signal
    );
    if (!account) {
      throw new SubscriptionRuntimeError(
        "chatgpt",
        "authentication_expired",
        "ChatGPT is not authenticated. Connect ChatGPT through Codex and try again."
      );
    }
    if (account.type !== "chatgpt") {
      throw new SubscriptionRuntimeError(
        "chatgpt",
        "authentication_expired",
        "Codex is signed in with an API key. Log out of Codex and sign in with ChatGPT to use the subscription."
      );
    }
    return account;
  }

  private requireImageInputModel(model: CodexModel): void {
    if (model.inputModalities?.includes("image") !== true) {
      throw new SubscriptionRuntimeError(
        "chatgpt",
        "model_unavailable",
        `The selected ChatGPT model "${model.id}" does not advertise image input.`
      );
    }
  }

  private async requireRuntimeModel(
    model?: string,
    signal?: AbortSignal
  ): Promise<CodexModel> {
    signal?.throwIfAborted();
    const models = await waitForChatgptPreflight(
      this.server.listModels(),
      signal
    );
    const selected = model
      ? models.find((candidate) => candidate.id === model)
      : (models.find((candidate) => candidate.isDefault) ?? models[0]);
    if (!selected) {
      throw new SubscriptionRuntimeError(
        "chatgpt",
        "model_unavailable",
        "Codex did not advertise the selected ChatGPT model."
      );
    }
    return selected;
  }

  private async watchLogin(loginId: string): Promise<void> {
    try {
      await this.waitForLogin(loginId);
    } catch {
      // Status is stored on the pending login.
    }
  }

  private readTerminalLoginStatus(
    loginId: string
  ): SubscriptionLoginStatusResponse | null {
    const status = this.pendingLogins.get(loginId)?.status;
    return status && status.status !== "pending" ? status : null;
  }

  private prunePendingLogins(): void {
    const oldestAllowed = Date.now() - LOGIN_TTL_MS;
    for (const [loginId, pending] of this.pendingLogins) {
      if (pending.startedAt < oldestAllowed) {
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

function createOneShotCleanupConversationId(purpose: string): string {
  return `atlas-internal:${purpose}:${crypto.randomUUID()}`;
}

interface CodexAtlasToolBridge {
  execute: (
    call: CodexDynamicToolCall,
    signal: AbortSignal
  ) => Promise<CodexDynamicToolResult>;
  failedWith: (error: unknown) => boolean;
  fingerprint: string;
  history: ChatMessage[];
  tools: CodexDynamicTool[];
}

function createCodexToolBridge(
  input: GenerateChatInput
): CodexAtlasToolBridge | undefined {
  const executeToolCall = input.executeToolCall;
  if (!(executeToolCall && input.tools?.length)) {
    return;
  }
  const tools: CodexDynamicTool[] = input.tools.map((tool) => ({
    description: tool.description,
    inputSchema: structuredClone(tool.parameters),
    name: tool.name,
    type: "function",
  }));
  const toolNames = new Set(tools.map((tool) => tool.name));
  if (toolNames.size !== tools.length) {
    throw new Error("Atlas tool names must be unique for Codex registration.");
  }
  const history = [...input.messages];
  const executions = new Map<
    string,
    { fingerprint: string; result: Promise<CodexDynamicToolResult> }
  >();
  let callbackFailed = false;
  let callbackError: unknown;

  const execute = async (
    nativeCall: CodexDynamicToolCall,
    signal: AbortSignal
  ): Promise<CodexDynamicToolResult> => {
    signal.throwIfAborted();
    input.signal?.throwIfAborted();
    if (callbackFailed) {
      throw callbackError;
    }
    if (
      !(
        nativeCall.callId.trim() &&
        toolNames.has(nativeCall.tool) &&
        isToolArguments(nativeCall.arguments)
      )
    ) {
      throw new Error("Codex requested an invalid or unregistered Atlas tool.");
    }
    const call = {
      arguments: structuredClone(nativeCall.arguments),
      id: nativeCall.callId,
      name: nativeCall.tool,
    };
    const fingerprint = computeActionHash({
      args: call.arguments,
      tool: call.name,
    });
    const previous = executions.get(call.id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new Error("Codex reused a tool call id for another action.");
      }
      return await previous.result;
    }
    const result = (async (): Promise<CodexDynamicToolResult> => {
      try {
        const canonicalCall = structuredClone(call);
        const completed = await executeToolCall(call, signal);
        // Match the canonical Atlas callback receipt before acknowledging the
        // native request. The final assistant reply is appended by Atlas later.
        history.push(
          { content: "", role: "assistant", toolCalls: [canonicalCall] },
          {
            content: completed.content,
            name: canonicalCall.name,
            role: "tool",
            toolCallId: canonicalCall.id,
          }
        );
        return {
          contentItems: [{ text: completed.content, type: "inputText" }],
          success: completed.success,
        };
      } catch (error) {
        callbackFailed = true;
        callbackError = error;
        throw error;
      }
    })();
    executions.set(call.id, { fingerprint, result });
    return await result;
  };

  return {
    execute,
    failedWith: (error) => callbackFailed && error === callbackError,
    fingerprint: createHash("sha256")
      .update(JSON.stringify({ mode: "codex-dynamic-tools-v1", tools }))
      .digest("base64url"),
    history,
    tools,
  };
}

function isToolArguments(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runtimeModelCapabilities(
  model: CodexModel,
  imageGeneration: boolean | undefined
): ProviderCapabilityClaims {
  const capabilities: ProviderCapabilityClaims = {};
  if (model.reasoningEffortValues !== undefined) {
    capabilities[PROVIDER_CAPABILITY_IDS.chatReasoning] = runtimeClaim(
      model.reasoningEffortValues.length > 0
    );
  }
  if (model.inputModalities !== undefined) {
    const supportsImage = model.inputModalities.includes("image");
    capabilities[PROVIDER_CAPABILITY_IDS.chatInputImage] =
      runtimeClaim(supportsImage);
    capabilities[PROVIDER_CAPABILITY_IDS.imageUnderstanding] =
      runtimeClaim(supportsImage);
  }
  if (imageGeneration !== undefined) {
    capabilities[PROVIDER_CAPABILITY_IDS.imageGeneration] = runtimeClaim(
      imageGeneration,
      imageGeneration ? CHATGPT_NATIVE_IMAGE_SIZE_CONSTRAINTS : undefined
    );
  }
  return capabilities;
}

function resolveThinkingTurnOptions(
  thinking: NonNullable<GenerateChatInput["providerOptions"]>["thinking"],
  model: CodexModel
): { effort?: string; summary?: "auto" | "none" } {
  if (!(thinking && model.reasoningEffortValues?.length)) {
    return {};
  }

  if (!thinking.enabled) {
    return {
      ...(model.reasoningEffortValues.includes("none")
        ? { effort: "none" }
        : {}),
      summary: "none",
    };
  }

  const requestedEffort = thinking.effort?.trim();
  const runtimeDefault = model.defaultReasoningEffort?.trim();
  const effort =
    requestedEffort && model.reasoningEffortValues.includes(requestedEffort)
      ? requestedEffort
      : runtimeDefault && model.reasoningEffortValues.includes(runtimeDefault)
        ? runtimeDefault
        : undefined;

  return {
    ...(effort ? { effort } : {}),
    summary: "auto",
  };
}

function runtimeClaim(
  supported: boolean,
  constraints?: ProviderCapabilityClaim["constraints"]
): ProviderCapabilityClaim {
  return {
    ...(constraints ? { constraints } : {}),
    source: "runtime-probe",
    status: supported ? "supported" : "unsupported",
    verified: true,
  };
}

function toCodexTurnInput(
  input: Array<
    | { data: string; mediaType: string; type: "image" }
    | { text: string; type: "text" }
  >
): CodexTurnInput[] {
  return input.map((part) =>
    part.type === "image"
      ? {
          detail: CHATGPT_IMAGE_INPUT_DETAIL,
          type: "image",
          url: toDataUrl(part.mediaType, part.data),
        }
      : textCodexInput(part.text)
  );
}

function textCodexInput(text: string): CodexTurnInput {
  return { text, text_elements: [], type: "text" };
}

function imageGenerationPrompt(prompt: string, size: string): string {
  const requestedCanvas =
    size === "auto"
      ? "Choose the best canvas and aspect ratio for the prompt."
      : `Aim for a ${size} canvas while preserving the requested composition.`;
  return [
    "Generate exactly one image with the native image generation tool.",
    requestedCanvas,
    "Image prompt:",
    prompt.trim(),
  ].join("\n");
}

function accountState(
  account: CodexAccount | null,
  runtimeVersion: string | null
): SubscriptionAuthState {
  if (!account) {
    return {
      authenticated: false,
      loginCommand: chatgptLoginCommand(),
      message: "ChatGPT is not authenticated. Connect ChatGPT and try again.",
      provider: "chatgpt",
      runtimeVersion,
      status: "not_authenticated",
    };
  }
  if (account.type !== "chatgpt") {
    return {
      authenticated: false,
      loginCommand: chatgptLoginCommand(),
      message:
        "Codex is using API-key authentication. Log out and sign in with ChatGPT to use the subscription.",
      provider: "chatgpt",
      runtimeVersion,
      status: "not_authenticated",
    };
  }
  return {
    authenticated: true,
    provider: "chatgpt",
    runtimeVersion,
    status: "authenticated",
    ...(account.email ? { email: account.email } : {}),
    ...(account.planType ? { plan: account.planType } : {}),
  };
}

/** Stop waiting for read-only preflight; the underlying shared RPC may still settle. */
function waitForChatgptPreflight<T>(
  operation: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) {
    return operation;
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
    operation.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          reject(signal.reason);
        } else {
          resolve(result);
        }
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

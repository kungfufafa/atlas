import {
  ATLAS_API_VERSION,
  type ChatCompletionResult,
  computeActionHash,
  ensureDir,
  MAX_GENERATED_IMAGE_BYTES,
} from "@atlas/core";
import { captureProviderFailureEvidence } from "../../failure-evidence";
import { resolveSubscriptionLaunch } from "../binary";
import { buildSubscriptionRuntimeEnv, subscriptionRuntimeHome } from "../env";
import {
  type JsonRpcNotification,
  JsonRpcStdioClient,
  spawnJsonRpcProcess,
} from "../jsonrpc-stdio";

const DEFAULT_TURN_TIMEOUT_MS = 15 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const ISOLATED_CODEX_FEATURES = {
  apps: false,
  browser_use: false,
  computer_use: false,
  image_generation: false,
  in_app_browser: false,
  multi_agent: false,
  plugins: false,
  shell_tool: false,
  skill_search: false,
  unified_exec: false,
  view_image: false,
  workspace_dependencies: false,
} as const;
const ISOLATED_CODEX_CONFIG = {
  features: {
    ...ISOLATED_CODEX_FEATURES,
  },
  mcp_servers: {},
  web_search: "disabled",
} as const;
const DEFAULT_CODEX_IMAGE_MODEL = "gpt-image-2";
const SUPPORTED_DYNAMIC_TOOLS_VERSION = "0.150.1";
const CODEX_USER_AGENT_VERSION_RE = /^atlas\/([^\s]+)(?:\s|$)/;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const STRICT_BASE64_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface CodexAccount {
  email?: string;
  planType?: string;
  type: string;
}

export interface CodexLoginStart {
  authUrl?: string;
  loginId: string;
  userCode?: string;
  verificationUrl?: string;
}

export interface CodexModel {
  defaultReasoningEffort?: string;
  displayName?: string;
  id: string;
  inputModalities?: CodexInputModality[];
  isDefault?: boolean;
  reasoningEffortValues?: string[];
}

export type CodexInputModality = "audio" | "image" | "text";

export type CodexTurnInput =
  | { text: string; text_elements: []; type: "text" }
  | {
      detail?: "auto" | "high" | "low" | "original";
      type: "image";
      url: string;
    }
  | { type: "audio"; url: string };

export interface CodexModelProviderCapabilities {
  imageGeneration: boolean;
  namespaceTools: boolean;
  webSearch: boolean;
}

export interface CodexGeneratedImage {
  data?: Uint8Array;
  failure?: {
    limitId?: string;
    resetsAt?: number;
    type: string;
  };
  height?: number;
  id: string;
  mediaType?: "image/png";
  model?: string;
  revisedPrompt?: string;
  status: string;
  width?: number;
}

export interface CodexTurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface CodexTurnResult {
  contextUsage?: ChatCompletionResult["contextUsage"];
  generatedImages?: CodexGeneratedImage[];
  text: string;
  thinking: string;
  usage?: CodexTurnUsage;
}

// Matches the experimental app-server protocol shipped in @openai/codex 0.150.1.
// Atlas registers only function tools; native shell, MCP, and other builtins
// remain controlled by the isolated thread configuration below.
export interface CodexDynamicTool {
  description: string;
  inputSchema: unknown;
  name: string;
  type: "function";
}

export interface CodexDynamicToolCall {
  arguments: Record<string, unknown>;
  callId: string;
  threadId: string;
  tool: string;
  turnId: string;
}

export interface CodexDynamicToolResult {
  contentItems: (
    | { text: string; type: "inputText" }
    | { imageUrl: string; type: "inputImage" }
    | { audioUrl: string; type: "inputAudio" }
  )[];
  success: boolean;
}

type CodexToolCallHandler = (
  call: CodexDynamicToolCall,
  signal: AbortSignal
) => Promise<CodexDynamicToolResult>;

export interface CodexAppServerOptions {
  client?: JsonRpcStdioClient;
  command?: string;
  /** Protocol version of an injected, already initialized test transport. */
  runtimeVersion?: string;
  turnTimeoutMs?: number;
}

interface CodexThreadOptions {
  cwd: string;
  developerInstructions?: string;
  imageGeneration?: boolean;
  model?: string;
}

export class CodexAppServer {
  private client: JsonRpcStdioClient | null;
  private readonly commandOverride?: string;
  private connecting: Promise<JsonRpcStdioClient> | null = null;
  private readonly turnTimeoutMs: number;
  private toolRequestClient: JsonRpcStdioClient | null = null;
  private readonly toolCallHandlers = new Map<string, CodexToolCallHandler>();
  private readonly runtimeVersions = new WeakMap<JsonRpcStdioClient, string>();

  constructor(options: CodexAppServerOptions = {}) {
    this.client = options.client ?? null;
    this.commandOverride = options.command;
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    if (options.client && options.runtimeVersion) {
      this.runtimeVersions.set(options.client, options.runtimeVersion);
    }
  }

  isConnected(): boolean {
    return this.client !== null && !this.client.isClosed();
  }

  async account(): Promise<CodexAccount | null> {
    const result = await this.request("account/read", { refreshToken: false });
    const record = asRecord(result);
    const account = asRecord(record.account);
    if (!account) {
      return null;
    }
    const type = readString(account.type) ?? readString(account.authMode);
    if (!type) {
      return null;
    }
    return {
      type,
      ...(readString(account.email)
        ? { email: readString(account.email) }
        : {}),
      ...(readString(account.planType)
        ? { planType: readString(account.planType) }
        : {}),
    };
  }

  async startLogin(
    type: "chatgpt" | "chatgptDeviceCode"
  ): Promise<CodexLoginStart> {
    const result = await this.request("account/login/start", { type });
    const record = asRecord(result);
    const loginId =
      readString(record.loginId) ??
      readString(record.login_id) ??
      crypto.randomUUID();
    return {
      loginId,
      ...(readString(record.authUrl) || readString(record.auth_url)
        ? { authUrl: readString(record.authUrl) ?? readString(record.auth_url) }
        : {}),
      ...(readString(record.verificationUrl) ||
      readString(record.verification_url)
        ? {
            verificationUrl:
              readString(record.verificationUrl) ??
              readString(record.verification_url),
          }
        : {}),
      ...(readString(record.userCode) || readString(record.user_code)
        ? {
            userCode:
              readString(record.userCode) ?? readString(record.user_code),
          }
        : {}),
    };
  }

  async cancelLogin(loginId: string): Promise<void> {
    await this.request("account/login/cancel", { loginId });
  }

  async logout(): Promise<void> {
    await this.request("account/logout");
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.request("thread/delete", { threadId });
  }

  async listModels(): Promise<CodexModel[]> {
    const models: CodexModel[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const result = await this.request("model/list", {
        ...(cursor ? { cursor } : {}),
        includeHidden: false,
      });
      const record = asRecord(result);
      const data = Array.isArray(record.data) ? record.data : [];
      for (const entry of data) {
        const model = asRecord(entry);
        const id =
          readString(model.id) ??
          readString(model.model) ??
          readString(model.slug);
        if (!id) {
          continue;
        }
        const reasoningEffortValues = readReasoningEffortValues(model);
        const inputModalities = readInputModalities(model);
        models.push({
          id,
          ...(readString(model.defaultReasoningEffort) ||
          readString(model.default_reasoning_effort)
            ? {
                defaultReasoningEffort:
                  readString(model.defaultReasoningEffort) ??
                  readString(model.default_reasoning_effort),
              }
            : {}),
          ...(readString(model.displayName)
            ? { displayName: readString(model.displayName) }
            : {}),
          ...(inputModalities === undefined ? {} : { inputModalities }),
          ...(typeof model.isDefault === "boolean"
            ? { isDefault: model.isDefault }
            : {}),
          ...(reasoningEffortValues === undefined
            ? {}
            : { reasoningEffortValues }),
        });
      }
      const next = readString(record.nextCursor);
      if (!next) {
        break;
      }
      cursor = next;
    }
    return models;
  }

  async readModelProviderCapabilities(): Promise<CodexModelProviderCapabilities> {
    const result = await this.request("modelProvider/capabilities/read", {});
    const record = asRecord(result);
    return {
      imageGeneration: readRequiredBoolean(
        record.imageGeneration,
        "imageGeneration"
      ),
      namespaceTools: readRequiredBoolean(
        record.namespaceTools,
        "namespaceTools"
      ),
      webSearch: readRequiredBoolean(record.webSearch, "webSearch"),
    };
  }

  async startThread(
    options: CodexThreadOptions & {
      dynamicTools?: CodexDynamicTool[];
      ephemeral?: boolean;
    }
  ): Promise<string> {
    const client = await this.ensureClient();
    if (options.dynamicTools !== undefined) {
      this.assertStructuredToolsSupported(client);
    }
    const result = await client.request("thread/start", {
      approvalPolicy: "never",
      config: isolatedCodexConfig(options.imageGeneration === true),
      cwd: options.cwd,
      sandbox: "read-only",
      ...(options.dynamicTools ? { dynamicTools: options.dynamicTools } : {}),
      ...(options.developerInstructions
        ? { developerInstructions: options.developerInstructions }
        : {}),
      ...(options.ephemeral ? { ephemeral: true } : {}),
      ...(options.model ? { model: options.model } : {}),
    });
    return requireThreadId(result);
  }

  async resumeThread(
    threadId: string,
    options: CodexThreadOptions
  ): Promise<string> {
    const result = await this.request("thread/resume", {
      approvalPolicy: "never",
      config: ISOLATED_CODEX_CONFIG,
      cwd: options.cwd,
      developerInstructions: options.developerInstructions,
      model: options.model,
      sandbox: "read-only",
      threadId,
    });
    return requireThreadId(result) || threadId;
  }

  async startTurn(options: {
    effort?: string;
    input: CodexTurnInput[] | string;
    model?: string;
    onDelta?: (delta: string) => void;
    onThinking?: (delta: string) => void;
    onToolCall?: CodexToolCallHandler;
    signal?: AbortSignal;
    summary?: "auto" | "concise" | "detailed" | "none";
    threadId: string;
  }): Promise<CodexTurnResult> {
    if (options.signal?.aborted) {
      throw new Error("Turn cancelled.");
    }
    const client = await waitForTurnClient(this.ensureClient(), options.signal);
    if (options.signal?.aborted) {
      throw new Error("Turn cancelled.");
    }
    if (options.onToolCall) {
      this.assertStructuredToolsSupported(client);
    }
    this.registerToolRequests(client);
    if (this.toolCallHandlers.has(options.threadId)) {
      throw new Error("A Codex turn is already active for this thread.");
    }
    let text = "";
    let thinking = "";
    const generatedImages: CodexGeneratedImage[] = [];
    const generatedImageIds = new Set<string>();
    let explicitTurnUsage: CodexTurnUsage | undefined;
    let contextUsage: CodexTurnResult["contextUsage"];
    let turnId: string | null = null;
    let settled = false;
    let interruptRequired = false;
    let interruptSent = false;
    const queuedNotifications: JsonRpcNotification[] = [];
    let unsubscribe: () => void = () => undefined;
    let unsubscribeClose: () => void = () => undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let remainingMs = this.turnTimeoutMs;
    let deadlineStartedAt = Date.now();
    let resolveCompletion: (value: CodexTurnResult) => void = () => undefined;
    let rejectCompletion: (error: Error) => void = () => undefined;
    const toolController = new AbortController();
    const toolCalls = new Map<
      string,
      { fingerprint: string; result: Promise<CodexDynamicToolResult> }
    >();
    let toolTail: Promise<unknown> = Promise.resolve();
    let pendingToolCalls = 0;
    let resolveTurnReady: (id: string | null) => void = () => undefined;
    const turnReady = new Promise<string | null>((resolve) => {
      resolveTurnReady = resolve;
    });

    const waitForCompletion = new Promise<CodexTurnResult>(
      (resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
      }
    );

    const cleanup = () => {
      toolController.abort();
      resolveTurnReady(null);
      this.toolCallHandlers.delete(options.threadId);
      unsubscribe();
      unsubscribeClose();
      options.signal?.removeEventListener("abort", onAbort);
      if (timeout) {
        clearTimeout(timeout);
      }
    };
    const interruptTurnOnce = () => {
      if (!(interruptRequired && turnId) || interruptSent) {
        return;
      }
      interruptSent = true;
      void client
        .request("turn/interrupt", { threadId: options.threadId, turnId })
        .catch(() => undefined);
    };
    const rejectTurn = (error: Error, shouldInterrupt = false) => {
      if (settled) {
        return;
      }
      settled = true;
      interruptRequired = shouldInterrupt;
      cleanup();
      rejectCompletion(
        captureProviderFailureEvidence(error, {
          content: text,
          contextUsage,
          thinking,
          toolInputFragments: [],
          usage: explicitTurnUsage,
        })
      );
      interruptTurnOnce();
    };
    const resolveTurn = () => {
      if (settled) {
        return;
      }
      if (pendingToolCalls > 0) {
        rejectTurn(
          new Error("Codex completed a turn with unfinished Atlas tools."),
          true
        );
        return;
      }
      settled = true;
      cleanup();
      resolveCompletion({
        ...(contextUsage ? { contextUsage } : {}),
        ...(generatedImages.length > 0 ? { generatedImages } : {}),
        text,
        thinking,
        usage: explicitTurnUsage,
      });
    };
    const executeTool = async (
      call: CodexDynamicToolCall,
      signal: AbortSignal,
      previous: Promise<unknown>
    ): Promise<CodexDynamicToolResult> => {
      await previous;
      const combinedSignal = AbortSignal.any([signal, toolController.signal]);
      if (settled || combinedSignal.aborted || !options.onToolCall) {
        throw new Error("Codex tool call has no active Atlas handler.");
      }
      try {
        const result = await options.onToolCall(call, combinedSignal);
        if (settled || combinedSignal.aborted) {
          throw new Error("Codex tool call was cancelled.");
        }
        return result;
      } catch (error) {
        rejectTurn(
          error instanceof Error ? error : new Error(String(error)),
          true
        );
        throw error;
      }
    };
    this.toolCallHandlers.set(options.threadId, async (call, signal) => {
      const activeTurnId = await turnReady;
      if (settled || !activeTurnId || call.turnId !== activeTurnId) {
        throw new Error("Codex tool call does not belong to the active turn.");
      }
      const fingerprint = computeActionHash({
        args: call.arguments,
        tool: call.tool,
      });
      const previous = toolCalls.get(call.callId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) {
          const error = new Error(
            "Codex reused a tool call id for another action."
          );
          rejectTurn(error, true);
          throw error;
        }
        return previous.result;
      }
      if (pendingToolCalls === 0 && timeout !== undefined) {
        clearTimeout(timeout);
        timeout = undefined;
        remainingMs = Math.max(
          0,
          remainingMs - (Date.now() - deadlineStartedAt)
        );
      }
      pendingToolCalls += 1;
      const result = executeTool(call, signal, toolTail).finally(() => {
        pendingToolCalls -= 1;
        if (!settled && pendingToolCalls === 0) {
          armDeadline();
        }
      });
      toolCalls.set(call.callId, { fingerprint, result });
      // Keep mutating actions sequential. A failed callback settles the turn;
      // queued callbacks check that state before dispatching another action.
      toolTail = result.catch(() => undefined);
      return result;
    });
    const processNotification = (notification: JsonRpcNotification) => {
      const record = asRecord(notification.params);
      if (readString(record.threadId) !== options.threadId) {
        return;
      }
      const notificationTurn = asRecord(record.turn);
      const notificationTurnId =
        readString(record.turnId) ?? readString(notificationTurn.id);
      if (!turnId) {
        queuedNotifications.push(notification);
        return;
      }
      if (notificationTurnId !== turnId) {
        return;
      }

      if (notification.method === "item/agentMessage/delta") {
        const delta = readDelta(notification.params);
        if (delta) {
          text += delta;
          options.onDelta?.(delta);
        }
      } else if (
        notification.method === "item/reasoning/summaryTextDelta" ||
        notification.method === "item/reasoning/textDelta"
      ) {
        const delta = readDelta(notification.params);
        if (delta) {
          thinking += delta;
          options.onThinking?.(delta);
        }
      } else if (notification.method === "item/completed") {
        const completedItem = readCompletedText(notification.params);
        if (completedItem.kind === "agentMessage" && completedItem.text) {
          text = completedItem.text;
        }
        if (completedItem.kind === "reasoning" && completedItem.text) {
          thinking = completedItem.text;
        }
        const generatedImage = readCompletedImage(notification.params);
        if (generatedImage && !generatedImageIds.has(generatedImage.id)) {
          generatedImageIds.add(generatedImage.id);
          generatedImages.push(generatedImage);
        }
      } else if (notification.method === "thread/tokenUsage/updated") {
        contextUsage = readContextUsage(notification.params);
      } else if (notification.method === "turn/completed") {
        // tokenUsage.last is context occupancy; only explicit completion counters
        // describe this turn's native-reported counters.
        explicitTurnUsage = readUsage({
          usage: notificationTurn.usage ?? record.usage,
        });
        const status = readString(notificationTurn.status);
        if (status === "failed") {
          const error = asRecord(notificationTurn.error);
          rejectTurn(
            new Error(readString(error.message) ?? "Codex turn failed.")
          );
          return;
        }
        if (status === "interrupted") {
          rejectTurn(new Error("Codex turn was interrupted."));
          return;
        }
        if (status === "completed") {
          resolveTurn();
          return;
        }
        rejectTurn(
          new Error(
            `Codex turn completed with unexpected status "${status ?? "missing"}".`
          ),
          true
        );
      }
    };
    const onAbort = () => {
      rejectTurn(new Error("Turn cancelled."), true);
    };
    unsubscribe = client.onNotification((notification) => {
      try {
        processNotification(notification);
      } catch (error) {
        rejectTurn(
          error instanceof Error ? error : new Error(String(error)),
          true
        );
      }
    });
    unsubscribeClose = client.onClose((error) => {
      rejectTurn(error);
    });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const armDeadline = () => {
      deadlineStartedAt = Date.now();
      timeout = setTimeout(() => {
        rejectTurn(new Error("Codex turn timed out."), true);
      }, remainingMs);
    };
    armDeadline();

    void client
      .request("turn/start", {
        ...(options.effort ? { effort: options.effort } : {}),
        input:
          typeof options.input === "string"
            ? [textTurnInput(options.input)]
            : options.input,
        ...(options.summary ? { summary: options.summary } : {}),
        threadId: options.threadId,
        ...(options.model ? { model: options.model } : {}),
      })
      .then((started) => {
        const startedRecord = asRecord(started);
        const turn = asRecord(startedRecord.turn);
        turnId =
          readString(turn.id) ?? readString(startedRecord.turnId) ?? null;
        if (!turnId) {
          rejectTurn(new Error("Codex did not return a turn id."));
          return;
        }
        resolveTurnReady(turnId);
        interruptTurnOnce();
        if (settled) {
          return;
        }
        for (const notification of queuedNotifications) {
          if (settled) {
            break;
          }
          try {
            processNotification(notification);
          } catch (error) {
            rejectTurn(
              error instanceof Error ? error : new Error(String(error)),
              true
            );
          }
        }
      })
      .catch((error: unknown) => {
        rejectTurn(error instanceof Error ? error : new Error(String(error)));
      });

    return waitForCompletion;
  }

  waitForLogin(loginId: string, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) {
      return Promise.reject(new Error("Login cancelled."));
    }
    return new Promise((resolve, reject) => {
      let unsubscribe: (() => void) | undefined;
      let unsubscribeClose: (() => void) | undefined;
      let settled = false;
      const timeout = setTimeout(() => {
        finish(new Error("ChatGPT login timed out."));
      }, LOGIN_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timeout);
        unsubscribe?.();
        unsubscribeClose?.();
        signal?.removeEventListener("abort", onAbort);
      };
      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        if (error) {
          reject(error);
        } else {
          resolve(true);
        }
      };
      const onAbort = () => {
        finish(new Error("Login cancelled."));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      void this.ensureClient()
        .then((client) => {
          unsubscribe = client.onNotification((notification) => {
            if (notification.method !== "account/login/completed") {
              return;
            }
            const record = asRecord(notification.params);
            const completedId =
              readString(record.loginId) ?? readString(record.login_id);
            if (completedId && completedId !== loginId) {
              return;
            }
            if (record.success === false) {
              finish(
                new Error(
                  readString(record.error) || "ChatGPT login did not complete."
                )
              );
              return;
            }
            finish();
          });
          unsubscribeClose = client.onClose((error) => {
            finish(error);
          });
          return this.account();
        })
        .then((account) => {
          if (account?.type === "chatgpt") {
            finish();
          }
        })
        .catch((error: unknown) => {
          finish(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  close(): void {
    this.client?.close();
    this.client = null;
    this.connecting = null;
  }

  private registerToolRequests(client: JsonRpcStdioClient): void {
    if (this.toolRequestClient === client) {
      return;
    }
    this.toolRequestClient = client;
    client.onRequest("item/tool/call", async (params, signal) => {
      const call = readDynamicToolCall(params);
      const handler = this.toolCallHandlers.get(call.threadId);
      if (!handler) {
        throw new Error("Codex tool call does not belong to an active thread.");
      }
      return await handler(call, signal);
    });
  }

  private assertStructuredToolsSupported(client: JsonRpcStdioClient): void {
    const version = this.runtimeVersions.get(client);
    if (version !== SUPPORTED_DYNAMIC_TOOLS_VERSION) {
      throw new Error(
        `Atlas structured tools require the tested Codex ${SUPPORTED_DYNAMIC_TOOLS_VERSION} runtime; the connected runtime reported ${version ?? "an unknown version"}. Restore the bundled Codex dependency before retrying.`
      );
    }
  }

  private async request(method: string, params?: unknown): Promise<unknown> {
    const client = await this.ensureClient();
    return client.request(method, params);
  }

  private async ensureClient(): Promise<JsonRpcStdioClient> {
    if (this.client && !this.client.isClosed()) {
      return this.client;
    }
    this.client = null;
    if (this.connecting) {
      return this.connecting;
    }
    this.connecting = this.connect();
    try {
      this.client = await this.connecting;
      return this.client;
    } finally {
      this.connecting = null;
    }
  }

  private async connect(): Promise<JsonRpcStdioClient> {
    const launch = this.commandOverride
      ? { command: this.commandOverride, prefixArgs: [] }
      : resolveSubscriptionLaunch("chatgpt");
    if (!launch) {
      throw new Error(
        "Codex runtime is not available. Reinstall Atlas dependencies to restore the bundled Codex binary."
      );
    }
    await ensureDir(subscriptionRuntimeHome("chatgpt"));
    const child = spawnJsonRpcProcess(
      launch.command,
      [...launch.prefixArgs, "app-server"],
      buildSubscriptionRuntimeEnv("chatgpt") as NodeJS.ProcessEnv
    );
    const client = new JsonRpcStdioClient(child);
    try {
      const runtimeVersion = await initializeCodexClient(client);
      if (runtimeVersion) {
        this.runtimeVersions.set(client, runtimeVersion);
      }
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }
}

export async function initializeCodexClient(
  client: JsonRpcStdioClient
): Promise<string | undefined> {
  const result = await client.request("initialize", {
    // Opt into the dynamicTools protocol, without enabling runtime native tools.
    capabilities: { experimentalApi: true },
    clientInfo: {
      name: "atlas",
      title: "Atlas",
      version: String(ATLAS_API_VERSION),
    },
  });
  client.notify("initialized");
  // The userAgent prefix contains the actual app-server build, not Atlas's
  // clientInfo.version. Bind compatibility to this connection, including PATH
  // fallbacks and reconnects; the installed package version alone is not proof.
  const userAgent = readString(asRecord(result).userAgent);
  return userAgent?.match(CODEX_USER_AGENT_VERSION_RE)?.[1];
}

function readDynamicToolCall(params: unknown): CodexDynamicToolCall {
  const record = asRecord(params);
  const callId = readString(record.callId);
  const threadId = readString(record.threadId);
  const tool = readString(record.tool);
  const turnId = readString(record.turnId);
  if (
    !(callId && threadId && tool && turnId && record.arguments) ||
    typeof record.arguments !== "object" ||
    Array.isArray(record.arguments) ||
    (record.namespace !== undefined && record.namespace !== null)
  ) {
    throw new Error("Codex returned an invalid Atlas tool call.");
  }
  return {
    arguments: record.arguments as Record<string, unknown>,
    callId,
    threadId,
    tool,
    turnId,
  };
}

function waitForTurnClient(
  clientPromise: Promise<JsonRpcStdioClient>,
  signal?: AbortSignal
): Promise<JsonRpcStdioClient> {
  if (!signal) {
    return clientPromise;
  }
  if (signal.aborted) {
    return Promise.reject(new Error("Turn cancelled."));
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error("Turn cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void clientPromise.then(
      (client) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) {
          reject(new Error("Turn cancelled."));
          return;
        }
        resolve(client);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

function readReasoningEffortValues(
  model: Record<string, unknown>
): string[] | undefined {
  const rawValues =
    model.supportedReasoningEfforts ??
    model.supported_reasoning_efforts ??
    model.reasoningEffortValues;
  if (!Array.isArray(rawValues)) {
    return;
  }

  const values: string[] = [];
  const seen = new Set<string>();
  for (const entry of rawValues) {
    const record = asRecord(entry);
    const value = (
      readString(entry) ??
      readString(record?.reasoningEffort) ??
      readString(record?.reasoning_effort) ??
      readString(record?.effort)
    )
      ?.trim()
      .toLowerCase();
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    values.push(value);
  }

  return values;
}

function readInputModalities(
  model: Record<string, unknown>
): CodexInputModality[] | undefined {
  const rawValues = model.inputModalities ?? model.input_modalities;
  if (!Array.isArray(rawValues)) {
    return;
  }

  const values: CodexInputModality[] = [];
  const seen = new Set<CodexInputModality>();
  for (const entry of rawValues) {
    const normalized = readString(entry)?.toLowerCase();
    if (
      !(
        normalized === "audio" ||
        normalized === "image" ||
        normalized === "text"
      ) ||
      seen.has(normalized)
    ) {
      continue;
    }
    seen.add(normalized);
    values.push(normalized);
  }

  return values;
}

function isolatedCodexConfig(imageGeneration: boolean) {
  return {
    features: {
      ...ISOLATED_CODEX_FEATURES,
      image_generation: imageGeneration,
    },
    mcp_servers: {},
    web_search: "disabled",
  };
}

function textTurnInput(text: string): CodexTurnInput {
  return { text, text_elements: [], type: "text" };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readRequiredBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(
      `Codex model-provider capability "${field}" is missing or invalid.`
    );
  }
  return value;
}

function requireThreadId(result: unknown): string {
  const record = asRecord(result);
  const thread = asRecord(record.thread);
  const id =
    readString(thread.id) ??
    readString(record.threadId) ??
    readString(record.id);
  if (!id) {
    throw new Error("Codex did not return a thread id.");
  }
  return id;
}

function readDelta(params: unknown): string {
  const record = asRecord(params);
  const delta = asRecord(record.delta);
  return (
    readText(record.delta) ??
    readText(record.text) ??
    readText(delta.text) ??
    ""
  );
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readCompletedText(params: unknown): { kind: string; text: string } {
  const record = asRecord(params);
  const item = asRecord(record.item);
  const kind =
    readString(item.type) ??
    readString(item.itemType) ??
    readString(record.type) ??
    "";
  const reasoningParts = [
    ...(Array.isArray(item.summary) ? item.summary : []),
    ...(Array.isArray(item.content) ? item.content : []),
  ]
    .map((part) => readString(part))
    .filter((part): part is string => Boolean(part));
  const text =
    readString(item.text) ??
    readString(asRecord(item.content).text) ??
    (reasoningParts.length > 0 ? reasoningParts.join("\n") : undefined) ??
    readString(record.text) ??
    "";
  return { kind, text };
}

function readCompletedImage(params: unknown): CodexGeneratedImage | undefined {
  const record = asRecord(params);
  const item = asRecord(record.item);
  const kind =
    readString(item.type) ??
    readString(item.itemType) ??
    readString(record.type) ??
    "";
  if (kind !== "imageGeneration") {
    return;
  }

  const id = readString(item.id);
  const status = readString(item.status);
  if (!(id && status)) {
    throw new Error("Codex returned an invalid image-generation item.");
  }

  const failure = readImageGenerationFailure(item.failure);
  const model = readString(item.model) ?? DEFAULT_CODEX_IMAGE_MODEL;
  if (status !== "completed") {
    return {
      ...(failure ? { failure } : {}),
      id,
      model,
      ...(readString(item.revisedPrompt)
        ? { revisedPrompt: readString(item.revisedPrompt) }
        : {}),
      status,
    };
  }

  const result = readString(item.result);
  if (!result) {
    throw new Error("Codex image generation returned empty image data.");
  }
  const data = decodeGeneratedPng(result);
  const dimensions = readPngDimensions(data);
  return {
    data,
    height: dimensions.height,
    id,
    mediaType: "image/png",
    model,
    ...(readString(item.revisedPrompt)
      ? { revisedPrompt: readString(item.revisedPrompt) }
      : {}),
    status,
    width: dimensions.width,
  };
}

function readImageGenerationFailure(
  value: unknown
): CodexGeneratedImage["failure"] | undefined {
  const failure = asRecord(value);
  const type = readString(failure.type);
  if (!type) {
    return;
  }
  return {
    ...(readString(failure.limitId)
      ? { limitId: readString(failure.limitId) }
      : {}),
    ...(readNumber(failure.resetsAt) === undefined
      ? {}
      : { resetsAt: readNumber(failure.resetsAt) }),
    type,
  };
}

function decodeGeneratedPng(value: string): Uint8Array {
  const base64 = value.trim();
  const maximumBase64Length = Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4;
  if (base64.length > maximumBase64Length) {
    throw new Error(
      `Codex generated image exceeds the ${MAX_GENERATED_IMAGE_BYTES / (1024 * 1024)} MB Atlas limit.`
    );
  }
  if (!STRICT_BASE64_RE.test(base64)) {
    throw new Error("Codex generated image contains invalid base64 data.");
  }

  const data = Buffer.from(base64, "base64");
  if (data.byteLength === 0 || data.byteLength > MAX_GENERATED_IMAGE_BYTES) {
    throw new Error("Codex generated image has an invalid size.");
  }
  if (data.toString("base64") !== base64) {
    throw new Error(
      "Codex generated image contains non-canonical base64 data."
    );
  }
  if (!data.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
    throw new Error("Codex generated image is not a valid PNG.");
  }
  return Uint8Array.from(data);
}

function readPngDimensions(data: Uint8Array): {
  height: number;
  width: number;
} {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (
    buffer.byteLength < 24 ||
    buffer.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    throw new Error("Codex generated image has an invalid PNG header.");
  }
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!(width > 0 && height > 0)) {
    throw new Error("Codex generated image has invalid dimensions.");
  }
  return { height, width };
}

function readContextUsage(params: unknown): CodexTurnResult["contextUsage"] {
  const tokenUsage = asRecord(asRecord(params).tokenUsage);
  const contextWindow = readTokenCount(tokenUsage.modelContextWindow);
  const last = asRecord(tokenUsage.last);
  const inputTokens = readTokenCount(last.inputTokens);
  const outputTokens = readTokenCount(last.outputTokens);
  const usedTokens =
    readTokenCount(last.totalTokens) ??
    (inputTokens !== undefined && outputTokens !== undefined
      ? readTokenCount(inputTokens + outputTokens)
      : undefined);
  if (!contextWindow || usedTokens === undefined) {
    return;
  }
  // Codex already applies its effective context budget. Use the latest model
  // request, including its output; thread-wide totals accumulate across turns.
  return { contextWindow, usedTokens };
}

function readTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function readUsage(params: unknown): CodexTurnUsage | undefined {
  const record = asRecord(params);
  const turn = asRecord(record.turn);
  const usage = asRecord(turn.usage ?? record.usage);
  const inputTokens = readTokenCount(
    usage.inputTokens ?? usage.input_tokens ?? usage.promptTokens
  );
  const outputTokens = readTokenCount(
    usage.outputTokens ?? usage.output_tokens ?? usage.completionTokens
  );
  const totalTokens = readTokenCount(usage.totalTokens ?? usage.total_tokens);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined
  ) {
    return;
  }
  return { inputTokens, outputTokens, totalTokens };
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

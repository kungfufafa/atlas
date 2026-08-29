import type {
  AgentChannel,
  AutomationDefinition,
  CapabilitySupportStatus,
  ChatContextUsage,
  ChatMessage,
  CompactionResponse,
  MessageContentPart,
  ProviderCapabilityConstraints,
  ProviderCapabilityId,
  ProviderChatOptions,
  ProviderClient,
  SendMessageInput,
  ToolCall,
  ToolContext,
  ToolDefinition,
} from "@atlas/core";

export interface AgentRequest {
  channel: AgentChannel;
  prompt: string;
}

export interface AgentDependencies {
  chatCapabilityPolicy?: ChatCapabilityPolicy;
  chatOptions?: ProviderChatOptions;
  provider?: ProviderClient;
  tools?: ToolDefinition[];
}

export interface ChatCapabilityPolicyEntry {
  constraints?: ProviderCapabilityConstraints;
  reasons?: readonly string[];
  selectable: boolean;
  status: CapabilitySupportStatus;
}

export interface ChatCapabilityPolicy {
  capabilities: Partial<
    Record<ProviderCapabilityId, ChatCapabilityPolicyEntry>
  >;
}

export type ChatCapabilityErrorCode =
  | "CHAT_CAPABILITY_UNAVAILABLE"
  | "CHAT_CAPABILITY_UNKNOWN"
  | "CHAT_CAPABILITY_UNSUPPORTED";

export class ChatCapabilityError extends Error {
  readonly capabilityId: ProviderCapabilityId;
  readonly code: ChatCapabilityErrorCode;
  readonly reasons: readonly string[];
  readonly status: CapabilitySupportStatus;

  constructor(
    capabilityId: ProviderCapabilityId,
    entry: ChatCapabilityPolicyEntry | undefined
  ) {
    const status = entry?.status ?? "unknown";
    const code =
      status === "unknown"
        ? "CHAT_CAPABILITY_UNKNOWN"
        : status === "unsupported"
          ? "CHAT_CAPABILITY_UNSUPPORTED"
          : "CHAT_CAPABILITY_UNAVAILABLE";
    const message =
      status === "unknown"
        ? `Atlas cannot verify required capability "${capabilityId}" for the selected model.`
        : status === "unsupported"
          ? `The selected model does not support required capability "${capabilityId}".`
          : `Required capability "${capabilityId}" is unavailable for the selected model.`;
    super(message);
    this.name = "ChatCapabilityError";
    this.capabilityId = capabilityId;
    this.code = code;
    this.reasons = entry?.reasons ?? [];
    this.status = status;
  }
}

import {
  getUserMessageText,
  messageContentHasDocuments,
  messageContentHasImages,
  messagesIncludeUserDocuments,
  messagesIncludeUserImages,
  normalizeUserContent,
  PROVIDER_CAPABILITY_IDS,
  partitionTools,
  resolveMessagesForNonVisionProvider,
  resolveUserContentForNonVisionProvider,
  sourceItemsFromSearchToolResult,
  toLlmToolDefinitions,
  WEB_SEARCH_TOOL_NAME,
} from "@atlas/core";
import {
  buildChatSystemPrompt,
  UNTRUSTED_DOCUMENT_GUIDANCE,
} from "./chat-prompt";
import {
  type CompactionConfig,
  compactHistory,
  estimateHistoryTokens,
  usableContextTokens,
} from "./history-compaction";
import {
  canRunToolCallsInParallel,
  executeToolCall,
  serializeToolResult,
} from "./tool-loop";

const MAX_TOOL_ITERATIONS = 100;

import type {
  ActivityEvent,
  ApprovalRequest,
  Artifact,
  Citation,
  ExecutionPolicy,
  SourceItem,
} from "@atlas/core";
import {
  AwaitingApprovalError,
  classifyFailure,
  evaluateActionRisk,
  inferArtifactType,
  mapToolCallToActivity,
  metrics,
  nanoid,
  resolveExecutionPolicy,
  summarizeActionConsequence,
  updateActivityCompletion,
} from "@atlas/core";

export interface StreamHandlers {
  onActivityComplete?: (activity: ActivityEvent) => void;
  onActivityStart?: (activity: ActivityEvent) => void;
  onActivityUpdate?: (activity: ActivityEvent) => void;
  onApprovalRequested?: (approval: ApprovalRequest) => void;
  onArtifactCreated?: (artifact: Artifact) => void;
  onChunk: (delta: string) => void;
  onCitationCreated?: (citation: Citation, source?: SourceItem) => void;
  onMemorySaved?: (summary: string) => void;
  onPolicyResolved?: (policy: ExecutionPolicy) => void;
  onRelatedQuestions?: (questions: string[]) => void;
  onSourcesUpdated?: (event: {
    sources: SourceItem[];
    citedCount: number;
    reviewedCount: number;
  }) => void;
  onSubAgentActivity?: (event: {
    parentToolCallId: string;
    label: string;
  }) => void;
  onThinking?: (delta: string) => void;
  onToolEnd?: (event: {
    toolCallId: string;
    tool: string;
    result: unknown;
  }) => void;
  onToolInputDelta?: (event: {
    toolCallId: string;
    tool: string;
    delta: string;
    accumulatedArguments?: string;
  }) => void;
  onToolStart?: (event: {
    toolCallId: string;
    tool: string;
    input: Record<string, unknown>;
  }) => void;
}

export type SendMessageArg = string | SendMessageInput;

export interface AgentChatSession {
  clear(): void;
  compact(options?: { force?: boolean }): Promise<CompactionResponse>;
  createAutomation(prompt: string): Promise<AutomationDefinition>;
  getContextUsage(): ChatContextUsage | null;
  getHistory(): readonly ChatMessage[];
  getHistoryRevision(): number;
  send(input: SendMessageArg, options?: SendStreamOptions): Promise<string>;
  sendStream(
    input: SendMessageArg,
    handlers: StreamHandlers,
    options?: SendStreamOptions
  ): Promise<string>;
}

export interface SendStreamOptions {
  /** Cancels the turn: stops the tool loop and asks running tools to abort. */
  signal?: AbortSignal;
}

export interface ResolvePromptContextInput {
  userMessage?: string;
}

export interface AgentChatSessionOptions {
  channel?: AgentRequest["channel"];
  compaction?: CompactionConfig;
  enableToolLoop?: boolean;
  initialHistory?: ChatMessage[];
  preprocessHistoryForTurn?: (
    messages: readonly ChatMessage[]
  ) => Promise<readonly ChatMessage[]>;
  preprocessUserContent?: (
    content: string | MessageContentPart[]
  ) => Promise<string | MessageContentPart[]>;
  rehydrateMessagesForProvider?: (
    messages: readonly ChatMessage[]
  ) => Promise<ChatMessage[]>;
  resolvePromptContext?: (
    context?: ResolvePromptContextInput
  ) => string | Promise<string>;
  soul?: boolean;
  systemPrompt?: string;
  toolContext?: ToolContext;
  tools?: ToolDefinition[];
  userContext?: string;
  userTimezone?: string;
}

export function createAgentChatSession(
  dependencies: AgentDependencies,
  harness: {
    createAutomationFromPrompt(
      request: AgentRequest,
      options?: { tools?: ToolDefinition[] }
    ): Promise<AutomationDefinition>;
  },
  options: AgentChatSessionOptions = {}
): AgentChatSession {
  const channel = options.channel ?? "cli";
  const tools = options.tools ?? dependencies.tools ?? [];
  const enableToolLoop = options.enableToolLoop ?? tools.length > 0;
  const systemPrompt = buildChatSystemPrompt(tools, {
    basePrompt: options.systemPrompt,
    channel,
    enableToolLoop,
    hasDocumentAttachments: messagesIncludeUserDocuments(
      options.initialHistory ?? []
    ),
    soul: options.soul,
    userContext: options.userContext,
    userTimezone: options.userTimezone,
  });
  // Bytes this session's optimiser kept out of the context. Session scope on
  // purpose: the chip beside it reports this conversation, not the org, and
  // showing an org total there would be read as this chat's saving.
  let bytesKeptOut = 0;
  // The denominator is every byte the handled tools produced this session,
  // including calls where nothing was removed. Dividing only by the optimised
  // calls would report a percentage of a set chosen after the fact.
  let bytesProduced = 0;
  const callerRecord = options.toolContext?.recordToolOutputSavings;
  const callerTurnUsage = options.toolContext?.recordTurnUsage;
  const toolContext: ToolContext = {
    ...options.toolContext,
    recordToolOutputSavings: (saving) => {
      bytesKeptOut += Math.max(0, saving.bytesIn - saving.bytesOut);
      bytesProduced += saving.bytesIn;
      callerRecord?.(saving);
    },
    // The arm is session state, and the conversation loop is a module-level
    // function that cannot see it, so it is filled in here and the loop's own
    // value is ignored.
    recordTurnUsage: (turn) =>
      callerTurnUsage?.({ ...turn, optimized: bytesKeptOut > 0 }),
  };
  const history: ChatMessage[] = options.initialHistory
    ? [...options.initialHistory]
    : [];
  let historyRevision = 0;
  let lastContextUsage: ChatContextUsage | null = null;

  function bumpHistoryRevision(): void {
    historyRevision += 1;
  }

  async function preprocessHistoryForTurn(): Promise<void> {
    if (!options.preprocessHistoryForTurn) {
      return;
    }

    const prepared = await options.preprocessHistoryForTurn(history);
    if (prepared === history) {
      return;
    }

    history.splice(0, history.length, ...prepared);
    bumpHistoryRevision();
  }

  function llmToolsForEstimate() {
    const { localTools } = partitionTools(tools);
    return enableToolLoop && localTools.length > 0
      ? toLlmToolDefinitions(localTools)
      : undefined;
  }

  function buildContextUsage(
    usedTokens: number,
    source: ChatContextUsage["source"]
  ): ChatContextUsage | null {
    if (!options.compaction) {
      return null;
    }

    return {
      // Reported only once an optimiser has actually removed something in this
      // session, so the chip stays silent rather than announcing a feature.
      bytesKeptOut: bytesKeptOut > 0 ? bytesKeptOut : undefined,
      bytesProduced: bytesKeptOut > 0 ? bytesProduced : undefined,
      contextWindow: options.compaction.contextWindow,
      source,
      usableContextTokens: usableContextTokens(options.compaction),
      usedTokens,
    };
  }

  function rememberContextUsage(
    usedTokens: number,
    source: ChatContextUsage["source"]
  ): void {
    lastContextUsage = buildContextUsage(usedTokens, source);
  }

  function estimateCurrentContextUsage(): ChatContextUsage | null {
    if (!options.compaction) {
      return null;
    }

    const dateLine = currentTurnClockLine(options.userTimezone);
    const usedTokens = estimateHistoryTokens(
      history,
      `${systemPrompt}\n\n${dateLine}`,
      llmToolsForEstimate()
    );

    return buildContextUsage(usedTokens, "estimate");
  }

  async function runCompaction(force: boolean): Promise<CompactionResponse> {
    if (!(dependencies.provider && options.compaction)) {
      return {
        action: "none",
        messagesAfter: history.length,
        messagesBefore: history.length,
      };
    }

    const { localTools } = partitionTools(tools);
    const llmTools =
      options.enableToolLoop !== false && localTools.length > 0
        ? toLlmToolDefinitions(localTools)
        : undefined;
    const result = await compactHistory({
      compaction: options.compaction,
      force,
      history,
      provider: dependencies.provider,
      systemPrompt,
      tools: llmTools,
    });

    if (result.action !== "none") {
      bumpHistoryRevision();
    }

    return result;
  }

  return {
    clear() {
      history.length = 0;
      lastContextUsage = null;
      bumpHistoryRevision();
    },
    compact(options) {
      return runCompaction(options?.force ?? false);
    },
    createAutomation(prompt) {
      return harness.createAutomationFromPrompt({ channel, prompt }, { tools });
    },
    getContextUsage() {
      return lastContextUsage ?? estimateCurrentContextUsage();
    },
    getHistory() {
      return history;
    },
    getHistoryRevision() {
      return historyRevision;
    },
    async send(input, sendOptions) {
      await preprocessHistoryForTurn();
      return sendMessage(
        dependencies,
        tools,
        systemPrompt,
        history,
        resolveSendInput(input),
        "send",
        {
          enableToolLoop,
          onContextUsage: rememberContextUsage,
          preprocessUserContent: options.preprocessUserContent,
          rehydrateMessagesForProvider: options.rehydrateMessagesForProvider,
          resolvePromptContext: options.resolvePromptContext,
          runCompaction,
          signal: sendOptions?.signal,
          toolContext,
          userTimezone: options.userTimezone,
        }
      );
    },
    async sendStream(input, handlers, streamOptions) {
      await preprocessHistoryForTurn();
      return sendMessage(
        dependencies,
        tools,
        systemPrompt,
        history,
        resolveSendInput(input),
        "stream",
        {
          enableToolLoop,
          handlers,
          onContextUsage: rememberContextUsage,
          preprocessUserContent: options.preprocessUserContent,
          rehydrateMessagesForProvider: options.rehydrateMessagesForProvider,
          resolvePromptContext: options.resolvePromptContext,
          runCompaction,
          signal: streamOptions?.signal,
          toolContext,
          userTimezone: options.userTimezone,
        }
      );
    },
  };
}

function resolveSendInput(input: SendMessageArg): SendMessageInput {
  return typeof input === "string" ? { message: input } : input;
}

async function sendMessage(
  dependencies: AgentDependencies,
  tools: ToolDefinition[],
  systemPrompt: string,
  history: ChatMessage[],
  input: SendMessageInput,
  mode: "send" | "stream",
  options: {
    enableToolLoop: boolean;
    handlers?: StreamHandlers;
    toolContext?: ToolContext;
    runCompaction?: (force: boolean) => Promise<CompactionResponse>;
    onContextUsage?: (
      usedTokens: number,
      source: ChatContextUsage["source"]
    ) => void;
    resolvePromptContext?: (
      context?: ResolvePromptContextInput
    ) => string | Promise<string>;
    preprocessUserContent?: (
      content: string | MessageContentPart[]
    ) => Promise<string | MessageContentPart[]>;
    rehydrateMessagesForProvider?: (
      messages: readonly ChatMessage[]
    ) => Promise<ChatMessage[]>;
    signal?: AbortSignal;
    userTimezone?: string;
  }
): Promise<string> {
  options.signal?.throwIfAborted();
  let userContent = normalizeUserContent(
    input.message,
    input.images,
    input.documents
  );

  if (options.preprocessUserContent) {
    userContent = await options.preprocessUserContent(userContent);
  }

  const userMessage = getUserMessageText(userContent);
  const resolvedPolicy = resolveExecutionPolicy({
    documents: input.documents,
    images: input.images,
    prompt: userMessage,
    userPolicy: input.policy,
  });

  if (mode === "stream" && options.handlers) {
    options.handlers.onPolicyResolved?.(resolvedPolicy);
  }

  const multimodalTurn =
    messageContentHasImages(userContent) ||
    messageContentHasDocuments(userContent) ||
    messagesIncludeUserImages(history) ||
    messagesIncludeUserDocuments(history);

  if (!dependencies.provider) {
    options.signal?.throwIfAborted();
    const hasAttachments = multimodalTurn;
    const reply = hasAttachments
      ? "Attachments require a configured provider. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY, or GEMINI_API_KEY in Settings."
      : "I'm running in offline mode. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY, or GEMINI_API_KEY to chat with me. You can still use /create to draft automations locally.";

    if (mode === "stream" && options.handlers) {
      options.handlers.onChunk(reply);
    }

    history.push({ content: userContent, role: "user" });
    history.push({ content: reply, role: "assistant" });
    return reply;
  }

  const partitionedTools = partitionTools(tools);
  const hasWebSearch = partitionedTools.hasWebSearch;
  const enableTools =
    options.enableToolLoop &&
    (partitionedTools.localTools.length > 0 || hasWebSearch);
  const nativeWebSearch =
    enableTools &&
    hasWebSearch &&
    chatCapabilitySupportsRequest(
      dependencies.chatCapabilityPolicy,
      PROVIDER_CAPABILITY_IDS.chatNativeWebSearch,
      {
        "request.local-tools": partitionedTools.localTools.length > 0,
        "request.multimodal": multimodalTurn,
      }
    );
  const localTools =
    enableTools && hasWebSearch && !nativeWebSearch
      ? tools
      : partitionedTools.localTools;
  const llmTools =
    enableTools && localTools.length > 0
      ? toLlmToolDefinitions(localTools)
      : undefined;
  const usesImageInput =
    messageContentHasImages(
      resolveUserContentForNonVisionProvider(userContent)
    ) ||
    messagesIncludeUserImages(resolveMessagesForNonVisionProvider(history));
  const canUseReasoning =
    !dependencies.chatCapabilityPolicy ||
    chatCapabilitySupportsRequest(
      dependencies.chatCapabilityPolicy,
      PROVIDER_CAPABILITY_IDS.chatReasoning,
      { "request.multimodal": usesImageInput }
    );
  const providerOptions = buildProviderOptions(dependencies, {
    thinking: canUseReasoning,
    webSearch: nativeWebSearch,
  });
  const chatCapabilityRequest = resolveChatCapabilityRequest(
    dependencies.chatCapabilityPolicy,
    {
      requestsReasoning: providerOptions?.thinking?.enabled === true,
      sendsTools: Boolean(llmTools?.length),
      usesImageInput,
      usesNativeWebSearch: providerOptions?.webSearch === true,
    }
  );
  history.push({ content: userContent, role: "user" });

  if (options.runCompaction) {
    await options.runCompaction(false);
  }

  const promptContext = options.resolvePromptContext
    ? await options.resolvePromptContext({ userMessage })
    : "";
  let effectiveSystemPrompt = promptContext.trim()
    ? `${systemPrompt}\n\n${promptContext.trim()}`
    : systemPrompt;
  const hasDocumentAttachments =
    messageContentHasDocuments(userContent) ||
    messagesIncludeUserDocuments(history);
  if (
    hasDocumentAttachments &&
    !effectiveSystemPrompt.includes("untrusted document data")
  ) {
    effectiveSystemPrompt = `${effectiveSystemPrompt}\n\n${UNTRUSTED_DOCUMENT_GUIDANCE}`;
  }
  const baseToolContext =
    input.clientOrigin?.trim() && options.toolContext
      ? { ...options.toolContext, clientOrigin: input.clientOrigin.trim() }
      : input.clientOrigin?.trim()
        ? { clientOrigin: input.clientOrigin.trim() }
        : options.toolContext;
  const effectiveToolContext = {
    ...(options.signal
      ? { ...baseToolContext, signal: options.signal }
      : baseToolContext),
    runId: baseToolContext?.runId ?? nanoid(),
  };

  metrics.executionActive.inc();
  metrics.executionTotal.inc({ policy: resolvedPolicy });
  const executionStartMs = Date.now();

  try {
    const reply = await runConversation(
      dependencies.provider,
      localTools,
      effectiveSystemPrompt,
      history,
      mode,
      enableTools,
      llmTools,
      providerOptions,
      chatCapabilityRequest.streamingAvailable,
      options.handlers,
      effectiveToolContext,
      options.rehydrateMessagesForProvider,
      options.onContextUsage,
      options.signal,
      options.userTimezone
    );

    if (
      input.relatedQuestions &&
      mode === "stream" &&
      !options.signal?.aborted
    ) {
      const questions = await generateRelatedQuestions(
        dependencies.provider,
        userMessage,
        reply
      );
      if (questions) {
        const lastAssistant = [...history]
          .reverse()
          .find((message) => message.role === "assistant");
        if (lastAssistant && lastAssistant.role === "assistant") {
          lastAssistant.relatedQuestions = questions;
        }
        options.handlers?.onRelatedQuestions?.(questions);
      }
    }

    const durationMs = Date.now() - executionStartMs;
    metrics.executionDurationMs.observe(durationMs, {
      policy: resolvedPolicy,
    });
    metrics.executionSuccessTotal.inc({ policy: resolvedPolicy });

    return reply;
  } catch (error) {
    if (error instanceof AwaitingApprovalError) {
      return "Waiting for approval to continue.";
    }
    const durationMs = Date.now() - executionStartMs;
    metrics.executionDurationMs.observe(durationMs, {
      policy: resolvedPolicy,
    });
    const failure = classifyFailure(error);
    if (failure.code === "CANCELLED") {
      metrics.executionCancelledTotal.inc();
    } else {
      metrics.executionFailureTotal.inc({ failure_code: failure.code });
    }
    rollbackFailedSend(history);
    throw error;
  } finally {
    metrics.executionActive.dec();
  }
}

function rollbackFailedSend(history: ChatMessage[]): void {
  while (history.length > 0) {
    const last = history.at(-1);

    if (last?.role === "tool") {
      history.pop();
      continue;
    }

    if (last?.role === "assistant" && (last.toolCalls?.length ?? 0) > 0) {
      history.pop();
      continue;
    }

    if (last?.role === "user") {
      history.pop();
    }

    break;
  }
}

async function runConversation(
  provider: ProviderClient,
  tools: ToolDefinition[],
  systemPrompt: string,
  history: ChatMessage[],
  mode: "send" | "stream",
  enableToolLoop: boolean,
  llmTools: ReturnType<typeof toLlmToolDefinitions> | undefined,
  providerOptions: ProviderChatOptions | undefined,
  streamingAvailable: boolean,
  handlers?: StreamHandlers,
  toolContext?: ToolContext,
  rehydrateMessagesForProvider?: (
    messages: readonly ChatMessage[]
  ) => Promise<ChatMessage[]>,
  onContextUsage?: (
    usedTokens: number,
    source: ChatContextUsage["source"]
  ) => void,
  signal?: AbortSignal,
  userTimezone?: string
): Promise<string> {
  const toolCallSignatures: string[] = [];
  let totalTurns = 0;
  let totalToolCalls = 0;

  try {
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
      signal?.throwIfAborted();
      totalTurns += 1;

      const result = await generateReply(
        provider,
        systemPrompt,
        history,
        llmTools,
        providerOptions,
        mode,
        streamingAvailable,
        handlers,
        rehydrateMessagesForProvider,
        signal,
        userTimezone,
        toolContext?.sessionId
      );

      // Providers are expected to honor the signal, but a late successful
      // response from one that does not must not record usage or mutate history.
      signal?.throwIfAborted();

      const usedTokens =
        result.usage?.inputTokens ??
        estimateHistoryTokens(
          history,
          `${systemPrompt}\n\n${currentTurnClockLine(userTimezone)}`,
          llmTools
        );
      onContextUsage?.(
        usedTokens,
        result.usage && !result.usage.estimated ? "provider" : "estimate"
      );

      // The arm is what the optimiser did in this session, not what a setting
      // says: a session where nothing was ever shortened belongs in the control
      // arm even with the feature switched on, or the comparison flatters itself.
      try {
        toolContext?.recordTurnUsage?.({
          estimated: Boolean(result.usage?.estimated ?? !result.usage),
          inputTokens: result.usage?.inputTokens ?? 0,
          // Overwritten by the session wrapper, which is the only scope that
          // knows whether anything was shortened.
          optimized: false,
          outputTokens: result.usage?.outputTokens ?? 0,
        });
      } catch {
        // never let accounting break a turn
      }

      history.push(result.assistantMessage);

      if (!enableToolLoop || result.toolCalls.length === 0) {
        return result.content;
      }

      // Loop Guard: Detect identical repetitive tool calls without progress
      const signature = result.toolCalls
        .map((c) => `${c.name}:${JSON.stringify(c.arguments)}`)
        .sort()
        .join("|");

      toolCallSignatures.push(signature);
      const repeatedCount = toolCallSignatures.filter(
        (sig) => sig === signature
      ).length;

      if (repeatedCount >= 4) {
        // Break out of loop to avoid runaway token burn on hallucinated repeats
        metrics.duplicateToolCallPreventionsTotal.inc();
        break;
      }

      totalToolCalls += result.toolCalls.length;
      await executeToolCalls(
        tools,
        result.toolCalls,
        history,
        handlers,
        toolContext
      );

      if (iteration === MAX_TOOL_ITERATIONS - 1) {
        metrics.agentLoopLimitTotal.inc();
      }
    }

    const lastAssistant = [...history]
      .reverse()
      .find(
        (message): message is Extract<ChatMessage, { role: "assistant" }> =>
          message.role === "assistant"
      );

    return lastAssistant?.content ?? "";
  } finally {
    metrics.agentTurnsPerExecution.observe(totalTurns);
    metrics.toolCallsPerExecution.observe(totalToolCalls);
  }
}

function isApprovalRequiredResult(result: unknown): boolean {
  if (typeof result !== "object" || result === null) {
    return false;
  }
  const record = result as { error?: unknown };
  return (
    typeof record.error === "string" &&
    record.error.includes("APPROVAL_REQUIRED")
  );
}

function isSearchToolName(name: string): boolean {
  return (
    name === "deep_research" ||
    name === WEB_SEARCH_TOOL_NAME ||
    /web_search(?:_advanced)?_exa/.test(name)
  );
}

function emitSourcesFromToolResult(
  tool: string,
  result: unknown,
  handlers?: StreamHandlers
): void {
  if (!isSearchToolName(tool) || result == null || typeof result !== "object") {
    return;
  }

  const record = result as Record<string, unknown>;
  if (tool === "deep_research" && Array.isArray(record.sources)) {
    const sources = record.sources as SourceItem[];
    if (sources.length === 0) {
      return;
    }
    handlers?.onSourcesUpdated?.({
      citedCount: Array.isArray(record.citations)
        ? record.citations.length
        : sources.length,
      reviewedCount: sources.length,
      sources,
    });
    return;
  }

  const sources = sourceItemsFromSearchToolResult(result);
  if (sources.length === 0) {
    return;
  }

  handlers?.onSourcesUpdated?.({
    citedCount: sources.length,
    reviewedCount: sources.length,
    sources,
  });
}

function emitArtifactsFromToolResult(
  toolCallId: string,
  result: unknown,
  emittedPaths: Set<string>,
  handlers?: StreamHandlers
): void {
  if (
    !handlers?.onArtifactCreated ||
    result == null ||
    typeof result !== "object"
  ) {
    return;
  }

  const candidates = (result as Record<string, unknown>).artifacts;
  if (!Array.isArray(candidates)) {
    return;
  }

  for (const [index, candidate] of candidates.entries()) {
    if (typeof candidate !== "object" || candidate === null) {
      continue;
    }

    const record = candidate as Record<string, unknown>;
    const path = typeof record.path === "string" ? record.path.trim() : "";
    const filename =
      typeof record.filename === "string" ? record.filename.trim() : "";
    const mimeType =
      typeof record.mimeType === "string" ? record.mimeType.trim() : "";
    const size = record.sizeBytes;

    if (
      !(path && filename && mimeType) ||
      typeof size !== "number" ||
      !Number.isInteger(size) ||
      size < 0 ||
      emittedPaths.has(path)
    ) {
      continue;
    }

    emittedPaths.add(path);
    const createdAt =
      typeof record.createdAt === "string" && record.createdAt.trim()
        ? record.createdAt
        : new Date().toISOString();

    handlers.onArtifactCreated({
      createdAt,
      filename,
      id:
        typeof record.id === "string" && record.id.trim()
          ? record.id
          : `${toolCallId}:${index}`,
      mimeType,
      path,
      sessionId:
        typeof record.sessionId === "string" ? record.sessionId : undefined,
      size,
      type: inferArtifactType(filename, mimeType),
    });
  }
}

async function executeToolCalls(
  tools: ToolDefinition[],
  toolCalls: ToolCall[],
  history: ChatMessage[],
  handlers?: StreamHandlers,
  toolContext: ToolContext = {}
): Promise<void> {
  const emittedArtifactPaths = new Set<string>();
  const contextForCall = (call: ToolCall): ToolContext => {
    if (!handlers?.onSubAgentActivity || call.name !== "sub_agent") {
      return toolContext;
    }

    return {
      ...toolContext,
      emitSubAgentActivity: (label) =>
        handlers.onSubAgentActivity?.({
          label,
          parentToolCallId: call.id,
        }),
    };
  };

  if (canRunToolCallsInParallel(tools, toolCalls)) {
    const MAX_PARALLEL_CONCURRENCY = 5;
    const results: Array<{ call: ToolCall; result: unknown }> = new Array(
      toolCalls.length
    );
    let currentIndex = 0;

    const workers = Array.from(
      { length: Math.min(MAX_PARALLEL_CONCURRENCY, toolCalls.length) },
      async () => {
        while (currentIndex < toolCalls.length) {
          const idx = currentIndex;
          currentIndex += 1;
          const call = toolCalls[idx]!;

          const activity = mapToolCallToActivity(
            call.id,
            call.name,
            call.arguments
          );
          handlers?.onActivityStart?.(activity);

          const risk = evaluateActionRisk(call.name, call.arguments);
          if (risk.requiresApproval) {
            handlers?.onApprovalRequested?.({
              consequenceSummary: summarizeActionConsequence(risk.consequence),
              createdAt: new Date().toISOString(),
              details: call.arguments,
              id: `app_${call.id}`,
              status: "pending",
              title: risk.consequence.title,
              tool: call.name,
              toolCallId: call.id,
            });
          }

          handlers?.onToolStart?.({
            input: call.arguments,
            tool: call.name,
            toolCallId: call.id,
          });

          const result = await executeToolCall(
            tools,
            call,
            contextForCall(call)
          );

          handlers?.onToolEnd?.({
            result,
            tool: call.name,
            toolCallId: call.id,
          });

          emitArtifactsFromToolResult(
            call.id,
            result,
            emittedArtifactPaths,
            handlers
          );

          handlers?.onActivityComplete?.(
            updateActivityCompletion(activity, true)
          );

          emitSourcesFromToolResult(call.name, result, handlers);

          if (
            (call.name === "memory_write" ||
              call.name === "update_profile_memory") &&
            typeof result === "object" &&
            result !== null
          ) {
            handlers?.onMemorySaved?.("Remembered");
          }

          results[idx] = { call, result };
        }
      }
    );

    await Promise.all(workers);

    const resultsByCallId = new Map(
      results.map((entry) => [entry.call.id, entry.result])
    );

    for (const call of toolCalls) {
      history.push({
        content: serializeToolResult(resultsByCallId.get(call.id)),
        name: call.name,
        role: "tool",
        toolCallId: call.id,
      });
    }

    return;
  }

  for (const call of toolCalls) {
    const activity = mapToolCallToActivity(call.id, call.name, call.arguments);
    handlers?.onActivityStart?.(activity);

    const risk = evaluateActionRisk(call.name, call.arguments);
    if (risk.requiresApproval) {
      const approval: ApprovalRequest = {
        consequenceSummary: summarizeActionConsequence(risk.consequence),
        createdAt: new Date().toISOString(),
        details: structuredClone(call.arguments),
        id: `app_${call.id}`,
        status: "pending",
        title: risk.consequence.title,
        tool: call.name,
        toolCallId: call.id,
      };
      const assistantMessage = history.at(-1);
      if (assistantMessage?.role === "assistant") {
        assistantMessage.approval = approval;
      }
      handlers?.onApprovalRequested?.(approval);
    }

    handlers?.onToolStart?.({
      input: call.arguments,
      tool: call.name,
      toolCallId: call.id,
    });

    const result = await executeToolCall(tools, call, contextForCall(call));

    if (isApprovalRequiredResult(result)) {
      const approvalId = `app_${call.id}`;
      throw new AwaitingApprovalError(approvalId, {
        args: call.arguments,
        runId: toolContext.runId ?? "",
        stepIndex: 0,
        toolCallId: call.id,
        toolName: call.name,
      });
    }

    handlers?.onToolEnd?.({
      result,
      tool: call.name,
      toolCallId: call.id,
    });

    emitArtifactsFromToolResult(
      call.id,
      result,
      emittedArtifactPaths,
      handlers
    );

    handlers?.onActivityComplete?.(updateActivityCompletion(activity, true));

    emitSourcesFromToolResult(call.name, result, handlers);

    if (
      (call.name === "memory_write" || call.name === "update_profile_memory") &&
      typeof result === "object" &&
      result !== null
    ) {
      handlers?.onMemorySaved?.("Remembered");
    }

    history.push({
      content: serializeToolResult(result),
      name: call.name,
      role: "tool",
      toolCallId: call.id,
    });
  }
}

function currentTurnClockLine(timeZone?: string): string {
  return `Current local time: ${formatCurrentDate(timeZone)}.`;
}

function formatCurrentDate(timeZone?: string): string {
  const zone = timeZone?.trim();
  const options: Intl.DateTimeFormatOptions = {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "long",
    timeZoneName: "short",
    weekday: "long",
    year: "numeric",
  };

  try {
    return new Date().toLocaleString("en-US", {
      ...options,
      ...(zone ? { timeZone: zone } : {}),
    });
  } catch {
    return new Date().toLocaleString("en-US", options);
  }
}

const RELATED_QUESTIONS_TIMEOUT_MS = 12_000;
const RELATED_QUESTIONS_MIN_REPLY_CHARS = 200;
const RELATED_QUESTIONS_MAX = 3;
const RELATED_QUESTIONS_MAX_QUESTION_CHARS = 90;

const RELATED_QUESTIONS_SYSTEM_PROMPT = [
  "You suggest follow-up questions for a chat assistant reply.",
  'Return ONLY a JSON object: {"questions": ["...", "..."]}.',
  "Rules: at most 3 questions; each one short line (under 80 characters); concrete and specific to the reply; write them in the same language as the user's message; never ask something the reply already answered; no numbering, no explanations, no compound clauses.",
].join(" ");

/**
 * Follow-up suggestions shown under the finished reply. Runs after the last
 * chunk but before the turn resolves, so the stream still delivers them ahead
 * of `done`. Any failure or timeout quietly skips the feature: it must never
 * break or visibly delay a turn.
 */
export async function generateRelatedQuestions(
  provider: ProviderClient | undefined,
  userMessage: string,
  reply: string
): Promise<string[] | null> {
  if (!provider || reply.trim().length < RELATED_QUESTIONS_MIN_REPLY_CHARS) {
    return null;
  }

  try {
    const completion = await Promise.race([
      provider.generateText({
        format: "json",
        prompt: [
          `User message: ${userMessage.slice(0, 2000)}`,
          "",
          `Assistant reply: ${reply.slice(0, 6000)}`,
          "",
          "Generate follow-up question suggestions for this reply.",
        ].join("\n"),
        system: RELATED_QUESTIONS_SYSTEM_PROMPT,
      }),
      new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), RELATED_QUESTIONS_TIMEOUT_MS)
      ),
    ]);
    if (!completion) {
      return null;
    }
    return parseRelatedQuestions(completion.content);
  } catch {
    return null;
  }
}

export function parseRelatedQuestions(raw: string): string[] | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      questions?: unknown;
    };
    if (!Array.isArray(parsed.questions)) {
      return null;
    }
    const questions = parsed.questions
      .filter((q): q is string => typeof q === "string")
      .map((q) => q.trim())
      .filter(
        (q) => q.length > 0 && q.length <= RELATED_QUESTIONS_MAX_QUESTION_CHARS
      )
      .slice(0, RELATED_QUESTIONS_MAX);
    return questions.length > 0 ? questions : null;
  } catch {
    return null;
  }
}

async function generateReply(
  provider: ProviderClient,
  systemPrompt: string,
  history: ChatMessage[],
  tools: ReturnType<typeof toLlmToolDefinitions> | undefined,
  providerOptions: ProviderChatOptions | undefined,
  mode: "send" | "stream",
  streamingAvailable: boolean,
  handlers?: StreamHandlers,
  rehydrateMessagesForProvider?: (
    messages: readonly ChatMessage[]
  ) => Promise<ChatMessage[]>,
  signal?: AbortSignal,
  userTimezone?: string,
  conversationId?: string
) {
  const dateLine = currentTurnClockLine(userTimezone);
  const replaySafeHistory = history.map((message) => {
    if (
      message.role !== "assistant" ||
      !(message.approval || message.relatedQuestions)
    ) {
      return message;
    }

    return {
      ...message,
      approval: undefined,
      relatedQuestions: undefined,
    };
  });
  const messages =
    rehydrateMessagesForProvider === undefined
      ? replaySafeHistory
      : await rehydrateMessagesForProvider(replaySafeHistory);
  const input = {
    ...(conversationId ? { conversationId } : {}),
    messages,
    providerOptions,
    signal,
    system: `${systemPrompt}\n\n${dateLine}`,
    tools,
  };

  if (mode === "stream" && handlers && streamingAvailable) {
    return provider.streamChat(input, {
      onChunk: handlers.onChunk,
      onThinking: handlers.onThinking,
      onToolEnd: handlers.onToolEnd,
      onToolInputDelta: handlers.onToolInputDelta,
      onToolStart: handlers.onToolStart,
    });
  }

  const result = await provider.generateChat(input);
  if (mode === "stream" && handlers) {
    const thinking = result.assistantMessage.thinking;
    if (thinking) {
      handlers.onThinking?.(thinking);
    }
    const content = result.content || result.assistantMessage.content;
    if (content) {
      handlers.onChunk(content);
    }
  }
  return result;
}

export function resolveChatCapabilityRequest(
  policy: ChatCapabilityPolicy | undefined,
  request: {
    requestsReasoning: boolean;
    sendsTools: boolean;
    usesImageInput?: boolean;
    usesNativeWebSearch?: boolean;
  }
): { streamingAvailable: boolean } {
  if (!policy) {
    return { streamingAvailable: true };
  }

  requireChatCapability(policy, PROVIDER_CAPABILITY_IDS.chatCompletion);
  if (request.sendsTools) {
    requireChatCapability(policy, PROVIDER_CAPABILITY_IDS.chatToolUse);
  }
  if (request.requestsReasoning) {
    requireChatCapabilityForRequest(
      policy,
      PROVIDER_CAPABILITY_IDS.chatReasoning,
      { "request.multimodal": request.usesImageInput === true }
    );
  }
  if (request.usesImageInput) {
    requireChatCapability(policy, PROVIDER_CAPABILITY_IDS.chatInputImage);
  }
  if (request.usesNativeWebSearch) {
    requireChatCapability(policy, PROVIDER_CAPABILITY_IDS.chatNativeWebSearch);
  }

  return {
    streamingAvailable: isChatCapabilityAvailable(
      policy.capabilities[PROVIDER_CAPABILITY_IDS.chatStreaming]
    ),
  };
}

export function requireChatCapability(
  policy: ChatCapabilityPolicy,
  capabilityId: ProviderCapabilityId
): void {
  const entry = policy.capabilities[capabilityId];
  if (!isChatCapabilityAvailable(entry)) {
    throw new ChatCapabilityError(capabilityId, entry);
  }
}

function isChatCapabilityAvailable(
  entry: ChatCapabilityPolicyEntry | undefined
): boolean {
  return entry?.status === "supported" && entry.selectable;
}

function chatCapabilitySupportsRequest(
  policy: ChatCapabilityPolicy | undefined,
  capabilityId: ProviderCapabilityId,
  requestValues: Readonly<Record<string, boolean | number | string>>
): boolean {
  const entry = policy?.capabilities[capabilityId];
  if (!isChatCapabilityAvailable(entry)) {
    return false;
  }

  const supportedValues = entry?.constraints?.supportedValues;
  if (!supportedValues) {
    return true;
  }

  return Object.entries(requestValues).every(([key, value]) => {
    const allowed = supportedValues[key];
    return !allowed || allowed.includes(value);
  });
}

function requireChatCapabilityForRequest(
  policy: ChatCapabilityPolicy,
  capabilityId: ProviderCapabilityId,
  requestValues: Readonly<Record<string, boolean | number | string>>
): void {
  requireChatCapability(policy, capabilityId);
  if (chatCapabilitySupportsRequest(policy, capabilityId, requestValues)) {
    return;
  }

  const entry = policy.capabilities[capabilityId];
  throw new ChatCapabilityError(capabilityId, {
    constraints: entry?.constraints,
    reasons: [...(entry?.reasons ?? []), "request-constraints-unsupported"],
    selectable: false,
    status: "unsupported",
  });
}

function buildProviderOptions(
  dependencies: AgentDependencies,
  options: { thinking: boolean; webSearch: boolean }
): ProviderChatOptions | undefined {
  const base = dependencies.chatOptions;
  const thinking =
    options.thinking && base?.thinking?.enabled ? base.thinking : undefined;
  const webSearch = options.webSearch ? true : undefined;

  if (!(webSearch || thinking)) {
    return;
  }

  return {
    ...(webSearch ? { webSearch: true } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

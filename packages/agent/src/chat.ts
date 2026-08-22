import type {
  AgentChannel,
  AutomationDefinition,
  ChatContextUsage,
  ChatMessage,
  CompactionResponse,
  MessageContentPart,
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
  chatOptions?: ProviderChatOptions;
  provider?: ProviderClient;
  tools?: ToolDefinition[];
}

import {
  getUserMessageText,
  messageContentHasDocuments,
  messageContentHasImages,
  messagesIncludeUserDocuments,
  messagesIncludeUserImages,
  normalizeUserContent,
  partitionTools,
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
  classifyFailure,
  evaluateActionRisk,
  mapToolCallToActivity,
  metrics,
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
  send(input: SendMessageArg): Promise<string>;
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
    async send(input) {
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
          toolContext,
          userTimezone: options.userTimezone,
        }
      );
    },
    async sendStream(input, handlers, streamOptions) {
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

  history.push({ content: userContent, role: "user" });
  const multimodalTurn =
    messageContentHasImages(userContent) ||
    messageContentHasDocuments(userContent) ||
    messagesIncludeUserImages(history) ||
    messagesIncludeUserDocuments(history);

  if (!dependencies.provider) {
    const hasAttachments = multimodalTurn;
    const reply = hasAttachments
      ? "Attachments require a configured provider. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY, or GEMINI_API_KEY in Settings."
      : "I'm running in offline mode. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, OPENROUTER_API_KEY, or GEMINI_API_KEY to chat with me. You can still use /create to draft automations locally.";

    if (mode === "stream" && options.handlers) {
      options.handlers.onChunk(reply);
    }

    history.push({ content: reply, role: "assistant" });
    return reply;
  }

  const { localTools, hasWebSearch } = partitionTools(tools);
  const enableTools =
    options.enableToolLoop && (localTools.length > 0 || hasWebSearch);
  const llmTools =
    enableTools && localTools.length > 0
      ? toLlmToolDefinitions(localTools)
      : undefined;
  const providerOptions = buildProviderOptions(dependencies, {
    multimodalTurn,
    webSearch:
      enableTools &&
      hasWebSearch &&
      dependencies.provider.name !== "openrouter" &&
      !(dependencies.provider.name === "gemini" && localTools.length > 0) &&
      !multimodalTurn,
  });

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
  const effectiveToolContext = options.signal
    ? { ...baseToolContext, signal: options.signal }
    : baseToolContext;

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
        handlers,
        rehydrateMessagesForProvider,
        signal,
        userTimezone
      );

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

      // Backstop for providers that ignore the signal. The in-flight request is
      // aborted through GenerateChatInput.signal; this only catches the case where
      // it returned anyway, so a cancelled turn leaves no half-written assistant
      // message and never starts another tool batch.
      signal?.throwIfAborted();

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

async function executeToolCalls(
  tools: ToolDefinition[],
  toolCalls: ToolCall[],
  history: ChatMessage[],
  handlers?: StreamHandlers,
  toolContext: ToolContext = {}
): Promise<void> {
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

    const result = await executeToolCall(tools, call, contextForCall(call));

    handlers?.onToolEnd?.({
      result,
      tool: call.name,
      toolCallId: call.id,
    });

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
  handlers?: StreamHandlers,
  rehydrateMessagesForProvider?: (
    messages: readonly ChatMessage[]
  ) => Promise<ChatMessage[]>,
  signal?: AbortSignal,
  userTimezone?: string
) {
  const dateLine = currentTurnClockLine(userTimezone);
  const replaySafeHistory = history.map((message) =>
    message.role === "assistant" && message.relatedQuestions
      ? { ...message, relatedQuestions: undefined }
      : message
  );
  const messages =
    rehydrateMessagesForProvider === undefined
      ? replaySafeHistory
      : await rehydrateMessagesForProvider(replaySafeHistory);
  const input = {
    messages,
    providerOptions,
    signal,
    system: `${systemPrompt}\n\n${dateLine}`,
    tools,
  };

  if (mode === "stream" && handlers) {
    return provider.streamChat(input, {
      onChunk: handlers.onChunk,
      onThinking: handlers.onThinking,
      onToolEnd: handlers.onToolEnd,
      onToolInputDelta: handlers.onToolInputDelta,
      onToolStart: handlers.onToolStart,
    });
  }

  return provider.generateChat(input);
}

function buildProviderOptions(
  dependencies: AgentDependencies,
  options: { webSearch: boolean; multimodalTurn: boolean }
): ProviderChatOptions | undefined {
  const base = dependencies.chatOptions;
  const thinking =
    options.multimodalTurn || !base?.thinking?.enabled
      ? undefined
      : base.thinking;
  const webSearch = options.webSearch ? true : undefined;

  if (!(webSearch || thinking)) {
    return;
  }

  return {
    ...(webSearch ? { webSearch: true } : {}),
    ...(thinking ? { thinking } : {}),
  };
}

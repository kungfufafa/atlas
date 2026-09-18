import type {
  ChatCompletionResult,
  ChatMessage,
  CustomModelEntry,
  GenerateChatInput,
  LlmToolDefinition,
  ProviderName,
  StreamChatHandlers,
  ToolCall,
} from "@atlas/core";
import {
  fetchWithoutIdleTimeout,
  isMessageContentPartArray,
  toOpenAIResponsesUserContent,
  WEB_SEARCH_TOOL_NAME,
} from "@atlas/core";
import {
  buildTokenUsage,
  DEFAULT_USER_AGENT,
  formatHttpErrorBody,
  hasMatchingProviderContent,
  notifyToolInputDelta,
  parseToolArguments,
  readRecord,
  readSseEvents,
  resolveThinkingEffort,
  sanitizeToolCallHistory,
} from "../shared";
import { openAIModelSupportsThinking } from "./thinking";

type ResponseItem = Record<string, unknown>;

export async function generateOpenAIResponsesChat(options: {
  apiKey: string;
  baseUrl?: string;
  model: string;
  input: GenerateChatInput;
  label?: string;
  stream: boolean;
  handlers?: StreamChatHandlers;
  customModels?: CustomModelEntry[];
  /** Ask a Responses-compatible endpoint for a JSON object. */
  jsonOutput?: boolean;
  /** Override OpenAI model-name heuristics for compatible endpoints. */
  supportsThinking?: boolean;
  /** Provider/model-specific reasoning effort values from the configured catalog. */
  reasoningEffortValues?: string[];
  defaultReasoningEffort?: string;
  /** Provider identity used to gate opaque Responses replay. */
  providerName?: ProviderName;
  providerInstanceId?: string;
  providerReplayRevision?: string;
  fetch?: typeof fetchWithoutIdleTimeout;
}): Promise<ChatCompletionResult> {
  const label = options.label ?? "OpenAI";
  const baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(
    /\/+$/,
    ""
  );
  const body = await buildResponsesRequestBody(
    options.model,
    options.input,
    options.stream,
    options.customModels,
    options.supportsThinking,
    options.jsonOutput,
    options.reasoningEffortValues,
    options.defaultReasoningEffort,
    options.providerName,
    options.providerInstanceId,
    options.providerReplayRevision
  );
  const fetchImpl = options.fetch ?? fetchWithoutIdleTimeout;
  const response = await fetchImpl(`${baseUrl}/responses`, {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": DEFAULT_USER_AGENT,
    },
    method: "POST",
    signal: options.input.signal,
  });

  if (!response.ok) {
    throw new Error(
      formatHttpErrorBody(label, response.status, await response.text())
    );
  }

  if (options.stream) {
    if (!response.body) {
      throw new Error(`${label} returned an empty stream.`);
    }

    return readOpenAIResponsesStream(
      response.body,
      options.handlers,
      label,
      options.providerName,
      options.providerInstanceId,
      options.model,
      options.providerReplayRevision
    );
  }

  const payload = (await response.json()) as {
    error?: unknown;
    output?: ResponseItem[];
    status?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
    };
  };
  assertResponsesSucceeded(payload, label);
  return parseResponsesOutput(
    payload.output ?? [],
    options.handlers,
    payload.usage,
    label,
    options.providerName,
    options.providerInstanceId,
    options.model,
    options.providerReplayRevision
  );
}

async function buildResponsesRequestBody(
  model: string,
  input: GenerateChatInput,
  stream: boolean,
  customModels?: CustomModelEntry[],
  supportsThinking?: boolean,
  jsonOutput?: boolean,
  reasoningEffortValues?: string[],
  defaultReasoningEffort?: string,
  providerName?: ProviderName,
  providerInstanceId?: string,
  providerReplayRevision?: string
) {
  const tools = buildResponsesTools(
    input.tools,
    input.providerOptions?.webSearch ?? false
  );

  return {
    input: await toResponsesInput(
      input.messages,
      providerName,
      providerInstanceId,
      model,
      providerReplayRevision
    ),
    instructions: input.system,
    model,
    ...(tools.length > 0 ? { tools } : {}),
    ...buildOpenAIReasoningRequest(
      model,
      input,
      customModels,
      supportsThinking,
      reasoningEffortValues,
      defaultReasoningEffort
    ),
    ...(jsonOutput ? { text: { format: { type: "json_object" } } } : {}),
    ...(stream ? { stream: true } : {}),
  };
}

function buildOpenAIReasoningRequest(
  model: string,
  input: GenerateChatInput,
  customModels?: CustomModelEntry[],
  supportsThinking?: boolean,
  reasoningEffortValues?: string[],
  defaultReasoningEffort?: string
): Record<string, unknown> {
  const modelSupportsThinking =
    supportsThinking ?? openAIModelSupportsThinking(model, customModels);

  if (!(input.providerOptions?.thinking?.enabled && modelSupportsThinking)) {
    return {};
  }

  return {
    reasoning: {
      effort: resolveThinkingEffort(
        input.providerOptions.thinking.effort,
        reasoningEffortValues,
        defaultReasoningEffort
      ),
      summary: "auto",
    },
  };
}

function buildResponsesTools(
  tools: LlmToolDefinition[] | undefined,
  webSearch: boolean
) {
  const hostedTools = webSearch ? [{ type: "web_search" }] : [];
  const functionTools = (tools ?? []).map((tool) => ({
    description: tool.description,
    name: tool.name,
    parameters: tool.parameters,
    type: "function" as const,
  }));

  return [...hostedTools, ...functionTools];
}

export async function toResponsesInput(
  messages: ChatMessage[],
  provider: ProviderName = "openai",
  providerInstanceId?: string,
  modelId?: string,
  providerReplayRevision?: string
): Promise<unknown[]> {
  const input: unknown[] = [];

  for (const message of sanitizeToolCallHistory(messages)) {
    if (message.role === "user") {
      input.push(await toResponsesUserInput(message, provider));
      continue;
    }

    if (message.role === "assistant") {
      input.push(
        ...toResponsesAssistantInput(
          message,
          provider,
          providerInstanceId,
          modelId,
          providerReplayRevision
        )
      );
      continue;
    }

    input.push(toResponsesToolOutput(message));
  }

  return input;
}

async function toResponsesUserInput(
  message: Extract<ChatMessage, { role: "user" }>,
  provider: ProviderName
): Promise<unknown> {
  const content = await toOpenAIResponsesUserContent(message.content, provider);

  if (isMessageContentPartArray(message.content)) {
    return {
      content,
      role: "user",
      type: "message",
    };
  }

  return {
    content,
    role: "user",
  };
}

function toResponsesAssistantInput(
  message: Extract<ChatMessage, { role: "assistant" }>,
  provider: ProviderName,
  providerInstanceId?: string,
  modelId?: string,
  providerReplayRevision?: string
): unknown[] {
  const input: unknown[] = [];
  const canReplayOpaqueContent = hasMatchingProviderContent(
    message,
    provider,
    "openai-responses",
    providerInstanceId,
    modelId,
    providerReplayRevision
  );
  const providerContent = canReplayOpaqueContent
    ? (message.providerContent ?? [])
    : [];

  if (message.toolCalls?.length) {
    if (canReplayOpaqueContent) {
      // providerContent already carries the assistant message item; pushing
      // message.content as well would replay the same text twice.
      input.push(...providerContent.filter(isNonFunctionCallProviderItem));
    } else if (message.content.trim()) {
      input.push(toResponsesAssistantTextMessage(message.content));
    }

    input.push(
      ...message.toolCalls.map((call) => ({
        arguments: JSON.stringify(call.arguments),
        call_id: call.id,
        name: call.name,
        type: "function_call",
      }))
    );

    return input;
  }

  if (canReplayOpaqueContent) {
    input.push(...providerContent);
    return input;
  }

  if (message.content.trim()) {
    input.push(toResponsesAssistantTextMessage(message.content));
  }

  return input;
}

function toResponsesAssistantTextMessage(content: string) {
  return {
    content: [{ text: content, type: "output_text" }],
    role: "assistant",
    type: "message",
  };
}

function isNonFunctionCallProviderItem(item: unknown): item is ResponseItem {
  const record = readRecord(item);
  return "type" in record && record.type !== "function_call";
}

function toResponsesToolOutput(
  message: Extract<ChatMessage, { role: "tool" }>
) {
  return {
    call_id: message.toolCallId,
    output: message.content,
    type: "function_call_output",
  };
}

function describeResponsesError(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  const error = readRecord(value);
  const message = typeof error.message === "string" ? error.message.trim() : "";
  const code = typeof error.code === "string" ? error.code.trim() : "";
  return message || code || undefined;
}

function assertResponsesSucceeded(
  payload: { error?: unknown; status?: unknown },
  label: string
): void {
  const status =
    typeof payload.status === "string" ? payload.status.trim() : "";
  const error = describeResponsesError(payload.error);

  if (!(error || (status && status !== "completed"))) {
    return;
  }

  const detail = error ?? `response status was ${status}`;
  throw new Error(`${label} request failed: ${detail}`);
}

function parseResponsesOutput(
  output: ResponseItem[],
  handlers?: StreamChatHandlers,
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  },
  label = "OpenAI",
  provider: ProviderName = "openai",
  providerInstanceId?: string,
  modelId?: string,
  providerReplayRevision?: string
): ChatCompletionResult {
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls: ToolCall[] = [];

  for (const item of output) {
    if (item.type === "refusal" && typeof item.refusal === "string") {
      textParts.push(item.refusal);
      continue;
    }

    if (item.type === "reasoning") {
      const summaryText = extractReasoningSummaryText(item);

      if (summaryText) {
        thinkingParts.push(summaryText);
      }

      continue;
    }

    if (item.type === "message") {
      const content = item.content;

      if (Array.isArray(content)) {
        for (const block of content) {
          const contentBlock = readRecord(block);
          if (
            contentBlock.type === "output_text" &&
            typeof contentBlock.text === "string"
          ) {
            textParts.push(contentBlock.text);
          }
          if (
            contentBlock.type === "refusal" &&
            typeof contentBlock.refusal === "string"
          ) {
            textParts.push(contentBlock.refusal);
          }
        }
      }
    }

    if (item.type === "web_search_call") {
      emitWebSearchToolEvent(item, handlers);
    }

    if (item.type === "function_call") {
      const id = String(item.call_id ?? item.id ?? "");
      const name = String(item.name ?? "");
      if (!(id.trim() && name.trim())) {
        throw new Error(
          "The provider returned a tool call without an ID or name."
        );
      }
      toolCalls.push({
        arguments: parseToolArguments(item.arguments),
        id,
        name,
      });
    }
  }

  const content = textParts.join("").trim();
  const thinking = thinkingParts.join("\n\n").trim();
  const providerContent = output.length > 0 ? output : undefined;
  const normalizedUsage = buildTokenUsage({
    inputTokens: usage?.input_tokens,
    outputTokens: usage?.output_tokens,
    totalTokens: usage?.total_tokens,
  });

  if (!content && toolCalls.length === 0 && !thinking) {
    throw new Error(`${label} returned an empty response.`);
  }

  return {
    assistantMessage: {
      content,
      role: "assistant",
      ...(thinking ? { thinking } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      ...(providerContent
        ? {
            providerContent,
            providerContentProvenance: {
              ...(modelId ? { modelId } : {}),
              ...(providerReplayRevision ? { providerReplayRevision } : {}),
              ...(providerInstanceId ? { providerInstanceId } : {}),
              protocol: "openai-responses",
              provider,
            },
          }
        : {}),
    },
    content,
    toolCalls,
    ...(normalizedUsage ? { usage: normalizedUsage } : {}),
  };
}

function extractReasoningSummaryText(item: ResponseItem): string | undefined {
  const summary = item.summary;

  if (!Array.isArray(summary)) {
    return;
  }

  const parts: string[] = [];

  for (const entry of summary) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      "text" in entry &&
      typeof (entry as { text?: unknown }).text === "string"
    ) {
      const text = (entry as { text: string }).text.trim();

      if (text) {
        parts.push(text);
      }
    }
  }

  const combined = parts.join("\n\n").trim();
  return combined || undefined;
}

function emitWebSearchToolEvent(
  item: ResponseItem,
  handlers?: StreamChatHandlers
): void {
  const action = readRecord(item.action);
  const toolCallId = String(item.id ?? "");

  handlers?.onToolStart?.({
    input: action,
    tool: WEB_SEARCH_TOOL_NAME,
    toolCallId,
  });
  handlers?.onToolEnd?.({
    result: action,
    tool: WEB_SEARCH_TOOL_NAME,
    toolCallId,
  });
}

async function readOpenAIResponsesStream(
  body: ReadableStream<Uint8Array>,
  handlers?: StreamChatHandlers,
  label = "OpenAI",
  provider: ProviderName = "openai",
  providerInstanceId?: string,
  modelId?: string,
  providerReplayRevision?: string
): Promise<ChatCompletionResult> {
  let content = "";
  let thinking = "";
  let usage: ChatCompletionResult["usage"];
  let streamedRefusal = false;
  let sawTerminal = false;
  let completedOutput: ResponseItem[] | undefined;
  const output: ResponseItem[] = [];
  const outputIndex = new Map<string, ResponseItem>();

  await readSseEvents(
    body,
    ({ data }) => {
      if (data.trim() === "[DONE]") {
        sawTerminal = true;
        return;
      }

      const payload = JSON.parse(data) as Record<string, unknown>;
      const type = String(payload.type ?? "");
      const responseRecord = readRecord(payload.response);
      usage =
        buildTokenUsage({
          inputTokens:
            responseRecord.usage &&
            readRecord(responseRecord.usage).input_tokens,
          outputTokens:
            responseRecord.usage &&
            readRecord(responseRecord.usage).output_tokens,
          totalTokens:
            responseRecord.usage &&
            readRecord(responseRecord.usage).total_tokens,
        }) ?? usage;

      if (
        type === "response.failed" ||
        type === "response.incomplete" ||
        type === "error"
      ) {
        assertResponsesSucceeded(
          {
            error: responseRecord.error ?? payload.error ?? payload,
            status:
              responseRecord.status ??
              (type === "response.incomplete" ? "incomplete" : "failed"),
          },
          label
        );
      }

      if (type === "response.completed") {
        assertResponsesSucceeded(responseRecord, label);
        sawTerminal = true;
        if (Array.isArray(responseRecord.output)) {
          completedOutput = responseRecord.output.map(readRecord);
        }
      }

      if (type === "response.output_text.delta") {
        const delta = String(payload.delta ?? "");
        content += delta;
        handlers?.onChunk(delta);
      }

      if (type === "response.refusal.delta") {
        const delta = String(payload.delta ?? "");
        streamedRefusal = true;
        content += delta;
        handlers?.onChunk(delta);
      }

      if (type === "response.reasoning_summary_text.delta") {
        const delta = String(payload.delta ?? "");
        thinking += delta;
        handlers?.onThinking?.(delta);
      }

      if (type === "response.output_item.added") {
        const item = readRecord(payload.item);
        const itemId = String(item.id ?? payload.item_id ?? "");

        if (itemId) {
          outputIndex.set(itemId, item);
        }
      }

      if (type === "response.function_call_arguments.delta") {
        const itemId = String(payload.item_id ?? "");
        const item = outputIndex.get(itemId);
        const delta = String(payload.delta ?? "");

        if (item && delta) {
          const argumentsText = `${String(item.arguments ?? "")}${delta}`;
          const updatedItem: ResponseItem = {
            ...item,
            arguments: argumentsText,
          };
          outputIndex.set(itemId, updatedItem);
          notifyToolInputDelta(
            handlers,
            {
              arguments: argumentsText,
              id: String(updatedItem.call_id ?? updatedItem.id ?? ""),
              name: String(updatedItem.name ?? ""),
            },
            delta
          );
        }
      }

      if (type === "response.output_item.done") {
        const item = readRecord(payload.item);
        const itemId = String(item.id ?? "");
        output.push(item);

        if (itemId) {
          outputIndex.set(itemId, item);
        }
      }
    },
    { includeDoneSentinel: true }
  );

  if (!sawTerminal) {
    throw new Error(`${label} stream ended before response.completed.`);
  }

  let finalOutput = completedOutput ?? output;
  if (finalOutput.length === 0 && outputIndex.size > 0) {
    finalOutput = [...outputIndex.values()];
  }

  if (content.trim() && finalOutput.length === 0) {
    finalOutput = [
      {
        content: [
          streamedRefusal
            ? { refusal: content, type: "refusal" }
            : { text: content, type: "output_text" },
        ],
        role: "assistant",
        type: "message",
      },
    ];
  }

  const parsed = parseResponsesOutput(
    finalOutput,
    handlers,
    undefined,
    label,
    provider,
    providerInstanceId,
    modelId,
    providerReplayRevision
  );

  const thinkingText = parsed.assistantMessage.thinking || thinking.trim();
  const resolvedContent = parsed.content || content.trim();

  return {
    ...parsed,
    content: resolvedContent,
    ...(usage ? { usage } : {}),
    assistantMessage: {
      ...parsed.assistantMessage,
      content: resolvedContent,
      ...(thinkingText ? { thinking: thinkingText } : {}),
    },
  };
}

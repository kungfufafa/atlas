import type {
  ChatCompletionResult,
  ChatMessage,
  CustomModelEntry,
  GenerateChatInput,
  GenerateTextInput,
  GenerateTextResult,
  LlmToolDefinition,
  ProviderChatOptions,
  ProviderClient,
  ProviderName,
  StreamChatHandlers,
  ToolCall,
} from "@atlas/core";
import {
  fetchWithoutIdleTimeout,
  formatConfiguredProviderLabel,
  messagesIncludeUserDocuments,
  messagesIncludeUserImages,
  toOpenAIChatUserContent,
} from "@atlas/core";
import { toOpenCodeGoApiModelId } from "../models";
import {
  modelSupportsReasoning,
  resolveModelThinkingEffort,
} from "../reasoning-metadata";
import {
  assertChatCompletionFinishReason,
  buildChatCompletionResult,
  DEFAULT_USER_AGENT,
  extractOpenAITokenUsage,
  notifyToolInputDelta,
  parseToolArguments,
  readChatCompletionSseEvents,
  sanitizeToolCallHistory,
} from "../shared";
import { generateOpenAIResponsesChat } from "./responses";
import {
  openAIModelRejectsChatToolsWithReasoning,
  openAIModelRequiresResponsesApi,
  openAIModelSupportsThinking,
} from "./thinking";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

export function openAIEndpointSupportsNativeWebSearch(
  baseUrl?: string
): boolean {
  const configured = baseUrl?.trim();
  return (
    normalizeBaseUrl(configured || DEFAULT_OPENAI_BASE_URL) ===
    DEFAULT_OPENAI_BASE_URL
  );
}

export interface OpenAIProviderOptions {
  apiKey: string;
  baseUrl?: string;
  customModels?: CustomModelEntry[];
  extraHeaders?: Record<string, string>;
  model?: string;
  providerInstanceId?: string;
  providerName?: ProviderName;
  providerReplayRevision?: string;
}

interface OpenAIClientConfig {
  apiKey: string;
  baseUrl: string;
  extraHeaders: Record<string, string>;
  label: string;
  providerName: ProviderName;
}

export function createOpenAIProvider(
  options: OpenAIProviderOptions
): ProviderClient {
  const model = options.model ?? "gpt-5.4";
  const client: OpenAIClientConfig = {
    apiKey: options.apiKey,
    baseUrl: normalizeBaseUrl(options.baseUrl ?? DEFAULT_OPENAI_BASE_URL),
    extraHeaders: options.extraHeaders ?? {},
    label: providerLabel(options.providerName ?? "openai"),
    providerName: options.providerName ?? "openai",
  };
  const useResponsesApi =
    client.providerName === "openai" &&
    openAIEndpointSupportsNativeWebSearch(client.baseUrl);
  const customModels = options.customModels;
  const reasoningMetadata = customModels?.find((entry) => entry.id === model);
  const reasoningEffortValues = reasoningMetadata?.reasoningEffortValues;
  const defaultReasoningEffort = reasoningMetadata?.defaultReasoningEffort;
  const resolveThinking = (thinking: ProviderChatOptions["thinking"]) => {
    if (!modelSupportsReasoning(model, customModels)) {
      return;
    }
    if (thinking?.enabled === false) {
      return thinking;
    }
    if (!thinking?.enabled) {
      return;
    }
    const effort = resolveModelThinkingEffort(
      model,
      thinking.effort,
      customModels
    );
    return { enabled: true, ...(effort ? { effort } : {}) };
  };

  return {
    generateChat(input: GenerateChatInput) {
      if (useResponsesApi && usesResponsesApi(input, model, customModels)) {
        return generateOpenAIResponsesChat({
          apiKey: options.apiKey,
          customModels,
          defaultReasoningEffort,
          input,
          model,
          providerInstanceId: options.providerInstanceId,
          providerName: client.providerName,
          providerReplayRevision: options.providerReplayRevision,
          reasoningEffortValues,
          stream: false,
        });
      }

      return requestChatCompletion(client, {
        messages: input.messages,
        model,
        signal: input.signal,
        system: input.system,
        thinking: resolveThinking(input.providerOptions?.thinking),
        tools: input.tools,
      });
    },
    generateText(input: GenerateTextInput) {
      const useJson = (input.format ?? "json") === "json";
      const system = useJson
        ? input.system
        : `${input.system}\n\nReturn only the requested text. No JSON, keys, labels, markdown fences, or surrounding quotes.`;

      return requestCompletion(client, {
        messages: [
          { content: system, role: "system" },
          { content: input.prompt, role: "user" },
        ],
        model,
        responseFormat: useJson ? { type: "json_object" } : undefined,
        signal: input.signal,
      });
    },
    name: client.providerName,
    streamChat(input: GenerateChatInput, handlers: StreamChatHandlers) {
      if (useResponsesApi && usesResponsesApi(input, model, customModels)) {
        return generateOpenAIResponsesChat({
          apiKey: options.apiKey,
          customModels,
          defaultReasoningEffort,
          handlers,
          input,
          model,
          providerInstanceId: options.providerInstanceId,
          providerName: client.providerName,
          providerReplayRevision: options.providerReplayRevision,
          reasoningEffortValues,
          stream: true,
        });
      }

      return streamChatCompletion(client, {
        handlers,
        messages: input.messages,
        model,
        signal: input.signal,
        system: input.system,
        thinking: resolveThinking(input.providerOptions?.thinking),
        tools: input.tools,
      });
    },
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function providerLabel(providerName: ProviderName): string {
  return formatConfiguredProviderLabel(providerName);
}

function chatCompletionsUrl(client: OpenAIClientConfig): string {
  return `${client.baseUrl}/chat/completions`;
}

function buildRequestHeaders(
  client: OpenAIClientConfig
): Record<string, string> {
  return {
    Authorization: `Bearer ${client.apiKey}`,
    "Content-Type": "application/json",
    "User-Agent": DEFAULT_USER_AGENT,
    ...client.extraHeaders,
  };
}

function usesResponsesApi(
  input: GenerateChatInput,
  model: string,
  customModels?: CustomModelEntry[]
): boolean {
  if (openAIModelRequiresResponsesApi(model)) {
    return true;
  }

  if (messagesIncludeUserDocuments(input.messages)) {
    return true;
  }

  // gpt-5.4+ reject tools + reasoning_effort on chat/completions; Responses supports both.
  if (
    (input.tools?.length ?? 0) > 0 &&
    (openAIModelRejectsChatToolsWithReasoning(model) ||
      openAIModelSupportsThinking(model, customModels))
  ) {
    return true;
  }

  if (
    input.providerOptions?.thinking?.enabled &&
    openAIModelSupportsThinking(model, customModels)
  ) {
    return true;
  }

  return (
    Boolean(input.providerOptions?.webSearch) &&
    !messagesIncludeUserImages(input.messages)
  );
}

type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | Array<Record<string, unknown>> }
  | {
      role: "assistant";
      content: string | null;
      reasoning_content?: string;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

export async function toOpenAIMessages(
  system: string,
  messages: ChatMessage[],
  provider: ProviderName = "openai"
): Promise<OpenAIMessage[]> {
  const result: OpenAIMessage[] = [{ content: system, role: "system" }];

  for (const message of sanitizeToolCallHistory(messages)) {
    result.push(await toOpenAIMessage(message, provider));
  }

  return result;
}

async function toOpenAIMessage(
  message: ChatMessage,
  provider: ProviderName
): Promise<OpenAIMessage> {
  if (message.role === "user") {
    return {
      content: (await toOpenAIChatUserContent(message.content, provider)) as
        | string
        | Array<Record<string, unknown>>,
      role: "user",
    };
  }

  if (message.role === "assistant") {
    return toOpenAIAssistantMessage(message);
  }

  return {
    content: message.content,
    role: "tool",
    tool_call_id: message.toolCallId,
  };
}

function toOpenAIAssistantMessage(
  message: Extract<ChatMessage, { role: "assistant" }>
): Extract<OpenAIMessage, { role: "assistant" }> {
  const thinking = message.thinking?.trim();
  const hasToolCalls = Boolean(message.toolCalls?.length);

  return {
    // DeepSeek / OpenCode Go reject `{ content: null }` unless tool_calls is set.
    content: hasToolCalls ? message.content || null : (message.content ?? ""),
    role: "assistant",
    ...(thinking ? { reasoning_content: thinking } : {}),
    ...(hasToolCalls
      ? { tool_calls: toOpenAIAssistantToolCalls(message.toolCalls ?? []) }
      : {}),
  };
}

function toOpenAIAssistantToolCalls(toolCalls: ToolCall[]) {
  return toolCalls.map((call) => ({
    function: {
      arguments: JSON.stringify(call.arguments),
      name: call.name,
    },
    id: call.id,
    type: "function" as const,
  }));
}

export function toOpenAITools(tools: LlmToolDefinition[] | undefined) {
  if (!tools?.length) {
    return;
  }

  return tools.map((tool) => ({
    function: {
      description: tool.description,
      name: tool.name,
      parameters: tool.parameters,
    },
    type: "function" as const,
  }));
}

export function parseOpenAIToolCalls(
  toolCalls:
    | Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>
    | undefined
): ToolCall[] {
  if (!toolCalls?.length) {
    return [];
  }

  return toolCalls.flatMap((call) => {
    const name = call.function?.name?.trim();
    const id = call.id?.trim();

    if (!(name && id)) {
      throw new Error(
        "The provider returned a tool call without an ID or name."
      );
    }

    return [
      {
        arguments: parseToolArguments(call.function?.arguments),
        id,
        name,
      },
    ];
  });
}

async function buildChatCompletionRequestBody(options: {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools?: LlmToolDefinition[];
  stream?: boolean;
  streamOptions?: { includeUsage: boolean };
  provider?: ProviderName;
  thinking?: ProviderChatOptions["thinking"];
}) {
  const hasTools = Boolean(options.tools?.length);
  const provider = options.provider ?? "openai";

  return {
    model: options.model,
    ...(options.stream ? { stream: true } : {}),
    ...(options.streamOptions
      ? {
          stream_options: { include_usage: options.streamOptions.includeUsage },
        }
      : {}),
    messages: await toOpenAIMessages(
      options.system,
      options.messages,
      provider
    ),
    ...(usesDeepSeekThinkingBody(provider, options.model)
      ? buildDeepSeekThinkingBody(options.thinking)
      : options.thinking?.enabled && options.thinking.effort
        ? { reasoning_effort: options.thinking.effort }
        : {}),
    ...(hasTools
      ? {
          tool_choice: "auto",
          tools: toOpenAITools(options.tools),
        }
      : {}),
  };
}

function usesDeepSeekThinkingBody(
  provider: ProviderName,
  model: string
): boolean {
  if (provider === "deepseek") {
    return true;
  }

  return (
    provider === "opencode_go" &&
    toOpenCodeGoApiModelId(model).startsWith("deepseek")
  );
}

function buildDeepSeekThinkingBody(
  thinking: ProviderChatOptions["thinking"] | undefined
) {
  if (thinking?.enabled === false) {
    return { thinking: { type: "disabled" as const } };
  }

  if (!thinking?.enabled) {
    return {};
  }

  return {
    ...(thinking.effort ? { reasoning_effort: thinking.effort } : {}),
    thinking: { type: "enabled" as const },
  };
}

function readReasoningContent(
  value: unknown,
  options?: { preserveWhitespace?: boolean }
): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }

  const record = value as Record<string, unknown>;
  const direct =
    typeof record.reasoning_content === "string"
      ? record.reasoning_content
      : undefined;

  if (direct === undefined) {
    return;
  }

  if (options?.preserveWhitespace) {
    return direct.length > 0 ? direct : undefined;
  }

  const trimmed = direct.trim();
  return trimmed ? trimmed : undefined;
}

async function requestChatCompletion(
  client: OpenAIClientConfig,
  options: {
    model: string;
    system: string;
    messages: ChatMessage[];
    signal?: AbortSignal;
    tools?: LlmToolDefinition[];
    thinking?: ProviderChatOptions["thinking"];
  }
): Promise<ChatCompletionResult> {
  const response = await fetchWithoutIdleTimeout(chatCompletionsUrl(client), {
    body: JSON.stringify(
      await buildChatCompletionRequestBody({
        ...options,
        provider: client.providerName,
      })
    ),
    headers: buildRequestHeaders(client),
    method: "POST",
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(
      `${client.label} request failed (${response.status}): ${await response.text()}`
    );
  }

  const payload = (await response.json()) as {
    usage?: Record<string, unknown>;
    choices?: Array<{
      finish_reason?: string | null;
      message?: {
        content?: string | null;
        reasoning_content?: string | null;
        tool_calls?: Array<{
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
  };

  assertChatCompletionFinishReason(
    payload.choices?.[0]?.finish_reason,
    client.label,
    payload
  );
  const message = payload.choices?.[0]?.message;
  const toolCalls = parseOpenAIToolCalls(message?.tool_calls);
  const content = message?.content ?? "";
  const thinking = readReasoningContent(message);

  if (!content.trim() && toolCalls.length === 0 && !thinking) {
    throw new Error(`${client.label} returned an empty response.`);
  }

  return buildChatCompletionResult({
    content,
    thinking,
    toolCalls,
    usage: extractOpenAITokenUsage(payload.usage),
  });
}

export * from "./responses";

async function streamChatCompletion(
  client: OpenAIClientConfig,
  options: {
    model: string;
    system: string;
    messages: ChatMessage[];
    signal?: AbortSignal;
    tools?: LlmToolDefinition[];
    thinking?: ProviderChatOptions["thinking"];
    handlers: StreamChatHandlers;
  }
): Promise<ChatCompletionResult> {
  const response = await fetchWithoutIdleTimeout(chatCompletionsUrl(client), {
    body: JSON.stringify(
      await buildChatCompletionRequestBody({
        messages: options.messages,
        model: options.model,
        provider: client.providerName,
        stream: true,
        streamOptions: { includeUsage: true },
        system: options.system,
        thinking: options.thinking,
        tools: options.tools,
      })
    ),
    headers: buildRequestHeaders(client),
    method: "POST",
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(
      `${client.label} request failed (${response.status}): ${await response.text()}`
    );
  }

  if (!response.body) {
    throw new Error(`${client.label} returned an empty stream.`);
  }

  return readOpenAIStream(response.body, options.handlers, client.label);
}

async function requestCompletion(
  client: OpenAIClientConfig,
  options: {
    model: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    responseFormat?: { type: "json_object" };
    signal?: AbortSignal;
  }
): Promise<GenerateTextResult> {
  const response = await fetchWithoutIdleTimeout(chatCompletionsUrl(client), {
    body: JSON.stringify({
      messages: options.messages,
      model: options.model,
      ...(options.responseFormat
        ? { response_format: options.responseFormat }
        : {}),
    }),
    headers: buildRequestHeaders(client),
    method: "POST",
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(
      `${client.label} request failed (${response.status}): ${await response.text()}`
    );
  }

  const payload = (await response.json()) as {
    choices?: Array<{
      finish_reason?: string | null;
      message?: { content?: string | null };
    }>;
  };

  assertChatCompletionFinishReason(
    payload.choices?.[0]?.finish_reason,
    client.label,
    payload
  );
  const content = payload.choices?.[0]?.message?.content?.trim();
  const usage = extractOpenAITokenUsage(
    (payload as { usage?: Record<string, unknown> }).usage
  );

  if (!content) {
    throw new Error(`${client.label} returned an empty response.`);
  }

  return {
    content,
    ...(usage ? { usage } : {}),
  };
}

interface PendingToolCall {
  arguments: string;
  id: string;
  name: string;
}

function mergePendingToolCall(
  pending: Map<number, PendingToolCall>,
  toolDelta: {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }
): void {
  const index = toolDelta.index ?? 0;
  const current = pending.get(index) ?? {
    arguments: "",
    id: "",
    name: "",
  };

  if (toolDelta.id) {
    current.id = toolDelta.id;
  }

  if (toolDelta.function?.name) {
    current.name = toolDelta.function.name;
  }

  if (toolDelta.function?.arguments) {
    current.arguments += toolDelta.function.arguments;
  }

  pending.set(index, current);
}

function finalizePendingToolCalls(
  pending: Map<number, PendingToolCall>
): ToolCall[] {
  return [...pending.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => call)
    .flatMap((call) => {
      if (!(call.id && call.name)) {
        throw new Error(
          "The provider returned a tool call without an ID or name."
        );
      }

      return [
        {
          arguments: parseToolArguments(call.arguments),
          id: call.id,
          name: call.name,
        },
      ];
    });
}

async function readOpenAIStream(
  body: ReadableStream<Uint8Array>,
  handlers: StreamChatHandlers,
  label = "OpenAI"
): Promise<ChatCompletionResult> {
  let content = "";
  let thinking = "";
  let usage: ChatCompletionResult["usage"];
  const pending = new Map<number, PendingToolCall>();

  await readChatCompletionSseEvents(
    body,
    ({ data }) => {
      const payload = JSON.parse(data) as {
        usage?: Record<string, unknown>;
        choices?: Array<{
          delta?: {
            content?: string | null;
            reasoning_content?: string | null;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
      };

      usage = extractOpenAITokenUsage(payload.usage) ?? usage;

      const delta = payload.choices?.[0]?.delta;

      if (delta?.content) {
        content += delta.content;
        handlers.onChunk(delta.content);
      }

      const reasoningDelta = readReasoningContent(delta, {
        preserveWhitespace: true,
      });

      if (reasoningDelta) {
        thinking += reasoningDelta;
        handlers.onThinking?.(reasoningDelta);
      }

      if (delta?.tool_calls) {
        for (const toolDelta of delta.tool_calls) {
          const argDelta = toolDelta.function?.arguments ?? "";
          mergePendingToolCall(pending, toolDelta);

          if (argDelta) {
            const current = pending.get(toolDelta.index ?? 0);

            if (current) {
              notifyToolInputDelta(handlers, current, argDelta);
            }
          }
        }
      }
    },
    label
  );

  const toolCalls = finalizePendingToolCalls(pending);
  const thinkingText = thinking.trim() || undefined;

  if (!content.trim() && toolCalls.length === 0 && !thinkingText) {
    throw new Error(`${label} returned an empty response.`);
  }

  return buildChatCompletionResult({
    content,
    thinking: thinkingText,
    toolCalls,
    usage,
  });
}

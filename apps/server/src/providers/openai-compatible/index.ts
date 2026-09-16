import type {
  ChatCompletionResult,
  ChatMessage,
  GenerateChatInput,
  GenerateTextInput,
  GenerateTextResult,
  LlmToolDefinition,
  ProviderChatOptions,
  ProviderClient,
  StreamChatHandlers,
  ToolCall,
  WireApi,
} from "@atlas/core";
import {
  fetchWithoutIdleTimeout,
  IncompleteCompletionError,
  normalizeBaseUrl,
} from "@atlas/core";
import OpenAI from "openai";
import {
  parseOpenAIToolCalls,
  toOpenAIMessages,
  toOpenAITools,
} from "../openai";
import { generateOpenAIResponsesChat } from "../openai/responses";
import {
  assertChatCompletionFinishReason,
  buildChatCompletionResult,
  DEFAULT_USER_AGENT,
  extractOpenAITokenUsage,
  formatHttpErrorBody,
  notifyToolInputDelta,
  parseJsonRecord,
  parseToolArguments,
  readChatCompletionSseEvents,
  resolveThinkingEffort,
} from "../shared";

export interface OpenAICompatibleProviderOptions {
  apiKey: string;
  baseUrl: string;
  defaultReasoningEffort?: string;
  displayName: string;
  /** Override outbound fetch (OpenCode Go wraps this to send x-opencode-session). */
  fetch?: typeof fetchWithoutIdleTimeout;
  model: string;
  providerInstanceId?: string;
  providerName?: ProviderClient["name"];
  providerReplayRevision?: string;
  reasoningEffortValues?: string[];
  supportsThinking: boolean;
  /** `responses` targets `/responses`; all other values use chat completions. */
  wireApi?: WireApi;
}

interface PendingToolCall {
  arguments: string;
  id: string;
  name: string;
}

export function createOpenAICompatibleProvider(
  options: OpenAICompatibleProviderOptions
): ProviderClient {
  const label = options.displayName.trim() || "Custom provider";
  const model = options.model;
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const apiKey = options.apiKey || "not-needed";
  const useResponsesApi = options.wireApi === "responses";
  const providerName = options.providerName ?? "openai_compatible";

  const fetchImpl = options.fetch ?? fetchWithoutIdleTimeout;
  const client = new OpenAI({
    apiKey,
    baseURL: baseUrl,
    defaultHeaders: {
      "User-Agent": DEFAULT_USER_AGENT,
    },
    fetch: fetchImpl,
    maxRetries: 0,
    timeout: 300_000,
  });

  const resolveThinking = (thinking: ProviderChatOptions["thinking"]) => {
    if (!(options.supportsThinking && thinking?.enabled)) {
      return;
    }
    const effort = resolveThinkingEffort(
      thinking.effort,
      options.reasoningEffortValues,
      options.defaultReasoningEffort
    );
    return effort ? { effort, enabled: true } : undefined;
  };

  return {
    generateChat(input: GenerateChatInput) {
      if (useResponsesApi) {
        return generateOpenAIResponsesChat({
          apiKey,
          baseUrl,
          defaultReasoningEffort: options.defaultReasoningEffort,
          fetch: fetchImpl,
          input,
          label,
          model,
          providerInstanceId: options.providerInstanceId,
          providerName,
          providerReplayRevision: options.providerReplayRevision,
          reasoningEffortValues: options.reasoningEffortValues,
          stream: false,
          supportsThinking: options.supportsThinking,
        });
      }

      return requestChatCompletion(client, label, {
        messages: input.messages,
        model,
        signal: input.signal,
        system: input.system,
        thinking: resolveThinking(input.providerOptions?.thinking),
        tools: input.tools,
      });
    },
    async generateText(input: GenerateTextInput) {
      const useJson = (input.format ?? "json") === "json";
      const system = useJson
        ? input.system
        : `${input.system}\n\nReturn only the requested text. No JSON, keys, labels, markdown fences, or surrounding quotes.`;

      if (useResponsesApi) {
        const result = await generateOpenAIResponsesChat({
          apiKey,
          baseUrl,
          defaultReasoningEffort: options.defaultReasoningEffort,
          fetch: fetchImpl,
          input: {
            messages: [{ content: input.prompt, role: "user" }],
            providerOptions: input.providerOptions as
              | ProviderChatOptions
              | undefined,
            signal: input.signal,
            system,
          },
          jsonOutput: useJson,
          label,
          model,
          providerInstanceId: options.providerInstanceId,
          providerName,
          providerReplayRevision: options.providerReplayRevision,
          reasoningEffortValues: options.reasoningEffortValues,
          stream: false,
          supportsThinking: options.supportsThinking,
        });

        return {
          content: result.content,
          data: useJson ? parseJsonRecord(result.content) : result.content,
          usage: result.usage,
        };
      }

      const result = await requestChatCompletion(client, label, {
        messages: [{ content: input.prompt, role: "user" }],
        model,
        signal: input.signal,
        system,
        thinking: resolveThinking(
          input.providerOptions?.thinking as ProviderChatOptions["thinking"]
        ),
      });

      return {
        content: result.content,
        data: useJson ? parseJsonRecord(result.content) : result.content,
        usage: result.usage,
      };
    },
    name: providerName,
    streamChat(input: GenerateChatInput, handlers: StreamChatHandlers) {
      if (useResponsesApi) {
        return generateOpenAIResponsesChat({
          apiKey,
          baseUrl,
          defaultReasoningEffort: options.defaultReasoningEffort,
          fetch: fetchImpl,
          handlers,
          input,
          label,
          model,
          providerInstanceId: options.providerInstanceId,
          providerName,
          providerReplayRevision: options.providerReplayRevision,
          reasoningEffortValues: options.reasoningEffortValues,
          stream: true,
          supportsThinking: options.supportsThinking,
        });
      }

      return streamChatCompletion({
        apiKey,
        baseUrl,
        fetch: fetchImpl,
        handlers,
        label,
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

function formatSdkError(label: string, error: unknown): Error {
  if (error instanceof IncompleteCompletionError) {
    return error;
  }
  if (error instanceof OpenAI.APIError) {
    const body =
      typeof error.error === "string"
        ? error.error
        : error.error
          ? JSON.stringify(error.error)
          : error.message;
    return new Error(formatHttpErrorBody(label, error.status ?? 0, body));
  }

  if (error instanceof Error) {
    return new Error(`${label} request failed: ${error.message}`);
  }

  return new Error(`${label} request failed.`);
}

async function buildMessages(
  system: string,
  messages: ChatMessage[]
): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> {
  return (await toOpenAIMessages(
    system,
    messages,
    "openai_compatible"
  )) as OpenAI.Chat.ChatCompletionMessageParam[];
}

function readReasoningText(
  value: unknown,
  options?: { preserveWhitespace?: boolean }
): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }

  const record = value as Record<string, unknown>;
  const direct =
    typeof record.reasoning === "string"
      ? record.reasoning
      : typeof record.reasoning_content === "string"
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

function buildThinkingBody(thinking: ProviderChatOptions["thinking"]) {
  return thinking?.enabled && thinking.effort
    ? { reasoning_effort: thinking.effort }
    : {};
}

async function requestChatCompletion(
  client: OpenAI,
  label: string,
  options: {
    model: string;
    system: string;
    messages: ChatMessage[];
    signal?: AbortSignal;
    tools?: LlmToolDefinition[];
    thinking?: ProviderChatOptions["thinking"];
  }
): Promise<ChatCompletionResult> {
  try {
    const completion = await client.chat.completions.create(
      {
        messages: await buildMessages(options.system, options.messages),
        model: options.model,
        ...buildThinkingBody(options.thinking),
        ...(options.tools?.length
          ? {
              tool_choice: "auto" as const,
              tools: toOpenAITools(options.tools),
            }
          : {}),
      } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
      { signal: options.signal }
    );

    assertChatCompletionFinishReason(
      completion.choices[0]?.finish_reason,
      label,
      completion
    );
    const message = completion.choices[0]?.message;
    const toolCalls = parseOpenAIToolCalls(
      message?.tool_calls as
        | Array<{
            id?: string;
            function?: { name?: string; arguments?: string };
          }>
        | undefined
    );
    const content = message?.content ?? "";
    const thinking = readReasoningText(message);

    if (!content.trim() && toolCalls.length === 0 && !thinking?.trim()) {
      throw new Error(`${label} returned an empty response.`);
    }

    return buildChatCompletionResult({
      content,
      thinking,
      toolCalls,
      usage: extractOpenAITokenUsage(completion.usage),
    });
  } catch (error) {
    throw formatSdkError(label, error);
  }
}

async function streamChatCompletion(options: {
  label: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  system: string;
  messages: ChatMessage[];
  tools?: LlmToolDefinition[];
  thinking?: ProviderChatOptions["thinking"];
  handlers: StreamChatHandlers;
  signal?: AbortSignal;
  fetch?: typeof fetchWithoutIdleTimeout;
}): Promise<ChatCompletionResult> {
  const fetchImpl = options.fetch ?? fetchWithoutIdleTimeout;
  const response = await fetchImpl(`${options.baseUrl}/chat/completions`, {
    body: JSON.stringify({
      messages: await buildMessages(options.system, options.messages),
      model: options.model,
      stream: true,
      stream_options: { include_usage: true },
      ...buildThinkingBody(options.thinking),
      ...(options.tools?.length
        ? {
            tool_choice: "auto",
            tools: toOpenAITools(options.tools),
          }
        : {}),
    }),
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": DEFAULT_USER_AGENT,
    },
    method: "POST",
    signal: options.signal,
  });

  const bodyText = response.ok ? null : await response.text();

  if (!response.ok) {
    throw new Error(
      formatHttpErrorBody(options.label, response.status, bodyText ?? "")
    );
  }

  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    throw new Error(
      formatHttpErrorBody(options.label, response.status, await response.text())
    );
  }

  if (!response.body) {
    throw new Error(`${options.label} returned an empty stream.`);
  }

  let content = "";
  let thinking = "";
  let usage: ChatCompletionResult["usage"];
  const pending = new Map<number, PendingToolCall>();

  await readChatCompletionSseEvents(
    response.body,
    ({ data }) => {
      const payload = JSON.parse(data) as {
        usage?: Record<string, unknown>;
        choices?: Array<{
          delta?: {
            content?: string | null;
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
        options.handlers.onChunk(delta.content);
      }

      const reasoningDelta = readReasoningText(delta, {
        preserveWhitespace: true,
      });

      if (reasoningDelta) {
        thinking += reasoningDelta;
        options.handlers.onThinking?.(reasoningDelta);
      }

      if (delta?.tool_calls) {
        for (const toolDelta of delta.tool_calls) {
          const argDelta = toolDelta.function?.arguments ?? "";
          mergePendingToolCall(pending, toolDelta);

          if (argDelta) {
            const current = pending.get(toolDelta.index ?? 0);

            if (current) {
              notifyToolInputDelta(options.handlers, current, argDelta);
            }
          }
        }
      }
    },
    options.label
  );

  const toolCalls = finalizePendingToolCalls(pending);

  if (!content.trim() && toolCalls.length === 0 && !thinking.trim()) {
    throw new Error(`${options.label} returned an empty response.`);
  }

  return buildChatCompletionResult({ content, thinking, toolCalls, usage });
}

async function requestCompletion(
  client: OpenAI,
  label: string,
  options: {
    model: string;
    messages: Array<{ role: "system" | "user"; content: string }>;
    responseFormat?: { type: "json_object" };
  }
): Promise<GenerateTextResult> {
  try {
    const completion = await client.chat.completions.create({
      messages: options.messages,
      model: options.model,
      ...(options.responseFormat
        ? { response_format: options.responseFormat }
        : {}),
    });

    assertChatCompletionFinishReason(
      completion.choices[0]?.finish_reason,
      label,
      completion
    );
    const content = completion.choices[0]?.message?.content?.trim();

    if (!content) {
      throw new Error(`${label} returned an empty response.`);
    }

    const usage = extractOpenAITokenUsage(completion.usage);
    return {
      content,
      ...(usage ? { usage } : {}),
    };
  } catch (error) {
    throw formatSdkError(label, error);
  }
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

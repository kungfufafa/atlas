import {
  type ChatCompletionResult,
  type ChatMessage,
  type CustomModelEntry,
  type GenerateChatInput,
  type GenerateTextInput,
  type GenerateTextResult,
  type LlmToolDefinition,
  normalizeBaseUrl,
  type ProviderChatOptions,
  type ProviderClient,
  type StreamChatHandlers,
  type ToolCall,
} from "@atlas/core";
import OpenAI from "openai";
import {
  parseOpenAIToolCalls,
  toOpenAIMessages,
  toOpenAITools,
} from "../openai";
import { resolveModelThinkingEffort } from "../reasoning-metadata";
import {
  assertChatCompletionFinishReason,
  buildChatCompletionResult,
  DEFAULT_USER_AGENT,
  extractOpenAITokenUsage,
  formatHttpErrorBody,
  notifyToolInputDelta,
  parseToolArguments,
  readChatCompletionSseEvents,
} from "../shared";
import { fireworksModelSupportsThinking } from "./thinking";

export const FIREWORKS_INFERENCE_BASE_URL =
  "https://api.fireworks.ai/inference/v1";
export const FIREWORKS_AUDIO_PROD_BASE_URL =
  "https://audio-prod.api.fireworks.ai/v1";
export const FIREWORKS_AUDIO_TURBO_BASE_URL =
  "https://audio-turbo.api.fireworks.ai/v1";
const FIREWORKS_ACCOUNT_MODELS_PREFIX = "accounts/fireworks/models/";
const PROVIDER_LABEL = "Fireworks";

export function fireworksModelResource(model: string): string {
  const trimmed = model.trim();
  if (trimmed.startsWith("accounts/")) {
    return trimmed;
  }
  return `${FIREWORKS_ACCOUNT_MODELS_PREFIX}${trimmed.replace(/^\/+/, "")}`;
}

export function resolveFireworksAudioTranscriptionTarget(model: string): {
  model: string;
  url: string;
} {
  const slug = model.trim().toLowerCase();
  if (slug.includes("turbo")) {
    return {
      model: "whisper-v3-turbo",
      url: `${FIREWORKS_AUDIO_TURBO_BASE_URL}/audio/transcriptions`,
    };
  }
  return {
    model: "whisper-v3",
    url: `${FIREWORKS_AUDIO_PROD_BASE_URL}/audio/transcriptions`,
  };
}

export type FireworksImageGenerationKind =
  | "image_generation"
  | "workflows"
  | "workflows_async";

export function resolveFireworksImageGenerationTarget(
  model: string,
  baseUrl = FIREWORKS_INFERENCE_BASE_URL
): { kind: FireworksImageGenerationKind; pollUrl?: string; url: string } {
  const resource = fireworksModelResource(model);
  const root = normalizeBaseUrl(baseUrl);
  const slug = resource.toLowerCase();
  if (
    slug.includes("playground") ||
    slug.includes("stable-diffusion") ||
    slug.includes("ssd-1b") ||
    slug.includes("japanese-stable-diffusion")
  ) {
    return {
      kind: "image_generation",
      url: `${root}/image_generation/${resource}`,
    };
  }
  if (slug.includes("flux-kontext")) {
    return {
      kind: "workflows_async",
      pollUrl: `${root}/workflows/${resource}/get_result`,
      url: `${root}/workflows/${resource}`,
    };
  }
  return {
    kind: "workflows",
    url: `${root}/workflows/${resource}/text_to_image`,
  };
}

export interface FireworksProviderOptions {
  apiKey: string;
  customModels?: CustomModelEntry[];
  model: string;
}

interface PendingToolCall {
  arguments: string;
  id: string;
  name: string;
}

export function createFireworksProvider(
  options: FireworksProviderOptions
): ProviderClient {
  const model = options.model;
  const apiKey = options.apiKey;
  const customModels = options.customModels;
  const client = new OpenAI({
    apiKey,
    baseURL: FIREWORKS_INFERENCE_BASE_URL,
    defaultHeaders: {
      "User-Agent": DEFAULT_USER_AGENT,
    },
    maxRetries: 0,
    timeout: 300_000,
  });

  const resolveThinking = (input: GenerateChatInput) => {
    if (!fireworksModelSupportsThinking(model, customModels)) {
      return;
    }

    const thinking = input.providerOptions?.thinking;
    const effort = resolveModelThinkingEffort(
      model,
      thinking?.effort,
      customModels
    );
    return thinking?.enabled && effort ? { effort, enabled: true } : undefined;
  };

  return {
    generateChat(input: GenerateChatInput) {
      return requestChatCompletion(client, {
        messages: input.messages,
        model,
        signal: input.signal,
        system: input.system,
        thinking: resolveThinking(input),
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
      });
    },
    name: "fireworks",
    streamChat(input: GenerateChatInput, handlers: StreamChatHandlers) {
      return streamChatCompletion({
        apiKey,
        handlers,
        messages: input.messages,
        model,
        signal: input.signal,
        system: input.system,
        thinking: resolveThinking(input),
        tools: input.tools,
      });
    },
  };
}

function buildThinkingBody(thinking?: ProviderChatOptions["thinking"]) {
  if (!thinking?.enabled) {
    return {};
  }

  return {
    reasoning_effort: thinking.effort,
  };
}

function formatSdkError(error: unknown): Error {
  if (error instanceof OpenAI.APIError) {
    const body =
      typeof error.error === "string"
        ? error.error
        : error.error
          ? JSON.stringify(error.error)
          : error.message;
    return new Error(
      formatHttpErrorBody(PROVIDER_LABEL, error.status ?? 0, body)
    );
  }

  if (error instanceof Error) {
    return new Error(`${PROVIDER_LABEL} request failed: ${error.message}`);
  }

  return new Error(`${PROVIDER_LABEL} request failed.`);
}

async function buildMessages(
  system: string,
  messages: ChatMessage[]
): Promise<OpenAI.Chat.ChatCompletionMessageParam[]> {
  return (await toOpenAIMessages(
    system,
    messages,
    "fireworks"
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

async function requestChatCompletion(
  client: OpenAI,
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
      PROVIDER_LABEL
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
      throw new Error(`${PROVIDER_LABEL} returned an empty response.`);
    }

    return buildChatCompletionResult({
      content,
      thinking,
      toolCalls,
      usage: extractOpenAITokenUsage(completion.usage),
    });
  } catch (error) {
    throw formatSdkError(error);
  }
}

async function streamChatCompletion(options: {
  apiKey: string;
  model: string;
  system: string;
  messages: ChatMessage[];
  tools?: LlmToolDefinition[];
  thinking?: ProviderChatOptions["thinking"];
  handlers: StreamChatHandlers;
  signal?: AbortSignal;
}): Promise<ChatCompletionResult> {
  const response = await fetch(
    `${FIREWORKS_INFERENCE_BASE_URL}/chat/completions`,
    {
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
    }
  );

  const bodyText = response.ok ? null : await response.text();

  if (!response.ok) {
    throw new Error(
      formatHttpErrorBody(PROVIDER_LABEL, response.status, bodyText ?? "")
    );
  }

  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    throw new Error(
      formatHttpErrorBody(
        PROVIDER_LABEL,
        response.status,
        await response.text()
      )
    );
  }

  if (!response.body) {
    throw new Error(`${PROVIDER_LABEL} returned an empty stream.`);
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
    PROVIDER_LABEL
  );

  const toolCalls = finalizePendingToolCalls(pending);

  if (!content.trim() && toolCalls.length === 0 && !thinking.trim()) {
    throw new Error(`${PROVIDER_LABEL} returned an empty response.`);
  }

  return buildChatCompletionResult({ content, thinking, toolCalls, usage });
}

async function requestCompletion(
  client: OpenAI,
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
      PROVIDER_LABEL
    );
    const content = completion.choices[0]?.message?.content?.trim();

    if (!content) {
      throw new Error(`${PROVIDER_LABEL} returned an empty response.`);
    }

    const usage = extractOpenAITokenUsage(completion.usage);
    return {
      content,
      ...(usage ? { usage } : {}),
    };
  } catch (error) {
    throw formatSdkError(error);
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

import type {
  ChatCompletionResult,
  CustomModelEntry,
  GenerateChatInput,
  GenerateTextInput,
  GenerateTextResult,
  ProviderClient,
  StreamChatHandlers,
} from "@atlas/core";
import {
  ApiError,
  type GenerateContentResponse,
  GoogleGenAI,
  type Part,
} from "@google/genai";
import {
  buildChatCompletionResult,
  extractGeminiTokenUsage,
  notifyToolInputDelta,
  readToolArguments,
} from "../shared";
import { buildGeminiChatConfig, buildGeminiGenerateConfig } from "./config";
import {
  createGeminiFunctionCallId,
  extractTextAndThinkingFromParts,
  parseGeminiFunctionCalls,
  toGeminiContents,
} from "./messages";

const PROVIDER_LABEL = "Gemini";
const DEFAULT_MODEL = "gemini-3-flash-preview";

export interface GeminiProviderOptions {
  apiKey: string;
  baseUrl?: string;
  customModels?: CustomModelEntry[];
  model?: string;
  providerInstanceId?: string;
  providerReplayRevision?: string;
}

function createGeminiClient(apiKey: string, baseUrl?: string): GoogleGenAI {
  const trimmed = baseUrl?.trim();
  return new GoogleGenAI({
    apiKey,
    ...(trimmed ? { httpOptions: { baseUrl: trimmed } } : {}),
  });
}

function formatGeminiError(error: unknown): Error {
  if (error instanceof ApiError) {
    return new Error(
      `${PROVIDER_LABEL} request failed (${error.status}): ${error.message}`
    );
  }

  if (error instanceof Error) {
    return error;
  }

  return new Error(`${PROVIDER_LABEL} request failed.`);
}

async function withGeminiError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw formatGeminiError(error);
  }
}

function parseGenerateContentResponse(
  response: GenerateContentResponse,
  providerInstanceId?: string,
  modelId?: string,
  providerReplayRevision?: string
): ChatCompletionResult {
  assertGeminiFinishReason(response.candidates?.[0]?.finishReason);
  const parts = response.candidates?.[0]?.content?.parts;
  const { content, thinking } = extractTextAndThinkingFromParts(parts);
  const toolCalls = parseGeminiFunctionCalls(response.functionCalls);

  if (!content.trim() && toolCalls.length === 0 && !thinking) {
    throw new Error(`${PROVIDER_LABEL} returned an empty response.`);
  }

  return buildChatCompletionResult({
    content,
    providerContent: parts?.length ? parts : undefined,
    providerContentProvenance: {
      ...(modelId ? { modelId } : {}),
      ...(providerReplayRevision ? { providerReplayRevision } : {}),
      ...(providerInstanceId ? { providerInstanceId } : {}),
      protocol: "gemini-content",
      provider: "gemini",
    },
    thinking,
    toolCalls,
    usage: extractGeminiTokenUsage(response.usageMetadata),
  });
}

function assertGeminiFinishReason(reason: string | undefined): boolean {
  if (!reason || reason === "FINISH_REASON_UNSPECIFIED") {
    return false;
  }
  if (reason !== "STOP") {
    throw new Error(
      `Gemini stopped before completing the response (${reason}).`
    );
  }
  return true;
}

interface PendingFunctionCall {
  argsJson: string;
  id: string;
  name: string;
}

function mergePendingFunctionCall(
  pending: Map<string, PendingFunctionCall>,
  key: string,
  call: { id?: string; name?: string; args?: Record<string, unknown> },
  handlers?: StreamChatHandlers
): void {
  const current = pending.get(key) ?? {
    argsJson: "",
    id: call.id?.trim() || createGeminiFunctionCallId(),
    name: "",
  };

  if (call.name) {
    current.name = call.name;
  }

  if (call.args !== undefined) {
    const nextJson = JSON.stringify(readToolArguments(call.args));
    const delta =
      nextJson.length > current.argsJson.length
        ? nextJson.slice(current.argsJson.length)
        : nextJson;
    current.argsJson = nextJson;
    notifyToolInputDelta(
      handlers,
      { arguments: current.argsJson, id: current.id, name: current.name },
      delta
    );
  }

  pending.set(key, current);
}

function finalizePendingFunctionCalls(
  pending: Map<string, PendingFunctionCall>
): ReturnType<typeof parseGeminiFunctionCalls> {
  return [...pending.values()].flatMap((call) => {
    if (!(call.id && call.name)) {
      throw new Error(
        "The provider returned a tool call without an ID or name."
      );
    }

    return parseGeminiFunctionCalls([
      {
        args: JSON.parse(call.argsJson || "{}") as Record<string, unknown>,
        id: call.id,
        name: call.name,
      },
    ]);
  });
}

function accumulateStreamParts(
  parts: Part[] | undefined,
  state: { content: string; thinking: string },
  handlers?: StreamChatHandlers
): void {
  if (!parts?.length) {
    return;
  }

  for (const part of parts) {
    const text = part.text;

    if (!text) {
      continue;
    }

    if (part.thought) {
      state.thinking += text;
      handlers?.onThinking?.(text);
    } else {
      state.content += text;
      handlers?.onChunk(text);
    }
  }
}

async function readGeminiStream(
  stream: AsyncGenerator<GenerateContentResponse>,
  handlers: StreamChatHandlers,
  providerInstanceId?: string,
  modelId?: string,
  providerReplayRevision?: string
): Promise<ChatCompletionResult> {
  const state = { content: "", thinking: "" };
  const pending = new Map<string, PendingFunctionCall>();
  const rawParts: Part[] = [];
  let usage: ChatCompletionResult["usage"];
  let anonymousCallCount = 0;
  let completed = false;

  for await (const chunk of stream) {
    completed =
      assertGeminiFinishReason(chunk.candidates?.[0]?.finishReason) ||
      completed;
    usage = extractGeminiTokenUsage(chunk.usageMetadata) ?? usage;
    const parts = chunk.candidates?.[0]?.content?.parts;
    if (parts?.length) {
      rawParts.push(...parts);
    }
    accumulateStreamParts(parts, state, handlers);

    for (const call of chunk.functionCalls ?? []) {
      const providedId = call.id?.trim();
      const key = providedId || `anonymous:${anonymousCallCount}`;
      if (!providedId) {
        anonymousCallCount += 1;
      }
      mergePendingFunctionCall(pending, key, call, handlers);
    }
  }

  if (!completed) {
    throw new Error("Gemini stream ended before completion.");
  }
  const toolCalls = finalizePendingFunctionCalls(pending);
  const thinking = state.thinking.trim() || undefined;

  if (!state.content.trim() && toolCalls.length === 0 && !thinking) {
    throw new Error(`${PROVIDER_LABEL} returned an empty response.`);
  }

  return buildChatCompletionResult({
    content: state.content,
    providerContent: rawParts.length > 0 ? rawParts : undefined,
    providerContentProvenance: {
      ...(modelId ? { modelId } : {}),
      ...(providerReplayRevision ? { providerReplayRevision } : {}),
      ...(providerInstanceId ? { providerInstanceId } : {}),
      protocol: "gemini-content",
      provider: "gemini",
    },
    thinking,
    toolCalls,
    usage,
  });
}

export function createGeminiProvider(
  options: GeminiProviderOptions
): ProviderClient {
  const model = options.model ?? DEFAULT_MODEL;
  const client = createGeminiClient(options.apiKey, options.baseUrl);

  return {
    generateChat(input: GenerateChatInput) {
      return withGeminiError(async () => {
        const response = await client.models.generateContent({
          config: {
            ...buildGeminiChatConfig(
              input,
              input.system,
              model,
              options.customModels
            ),
            abortSignal: input.signal,
          },
          contents: await toGeminiContents(
            input.messages,
            options.providerInstanceId,
            model,
            options.providerReplayRevision
          ),
          model,
        });

        return parseGenerateContentResponse(
          response,
          options.providerInstanceId,
          model,
          options.providerReplayRevision
        );
      });
    },
    generateText(input: GenerateTextInput) {
      const useJson = (input.format ?? "json") === "json";
      const system = useJson
        ? `${input.system}\n\nRespond with valid JSON only.`
        : `${input.system}\n\nReturn only the requested text. No JSON, labels, or markdown fences.`;

      return withGeminiError(async () => {
        const response = await client.models.generateContent({
          config: buildGeminiGenerateConfig({
            model,
            responseMimeType: useJson ? "application/json" : undefined,
            system,
          }),
          contents: input.prompt,
          model,
        });

        assertGeminiFinishReason(response.candidates?.[0]?.finishReason);
        const content = response.text?.trim();
        const usage = extractGeminiTokenUsage(response.usageMetadata);

        if (!content) {
          throw new Error(`${PROVIDER_LABEL} returned an empty response.`);
        }

        return {
          content,
          ...(usage ? { usage } : {}),
        } satisfies GenerateTextResult;
      });
    },
    name: "gemini",
    streamChat(input: GenerateChatInput, handlers: StreamChatHandlers) {
      return withGeminiError(async () => {
        const stream = await client.models.generateContentStream({
          config: {
            ...buildGeminiChatConfig(
              input,
              input.system,
              model,
              options.customModels
            ),
            abortSignal: input.signal,
          },
          contents: await toGeminiContents(
            input.messages,
            options.providerInstanceId,
            model,
            options.providerReplayRevision
          ),
          model,
        });

        return readGeminiStream(
          stream,
          handlers,
          options.providerInstanceId,
          model,
          options.providerReplayRevision
        );
      });
    },
  };
}

export { toGeminiContents } from "./messages";

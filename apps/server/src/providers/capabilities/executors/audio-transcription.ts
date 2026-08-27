import {
  AtlasApiError,
  defaultDiscoveryBaseUrl,
  defaultOllamaBaseUrl,
  normalizeBaseUrl,
  PROVIDER_CAPABILITY_IDS,
  readEnvValue,
} from "@atlas/core";
import { GoogleGenAI } from "@google/genai";
import { resolveCloudflareModelRunUrl } from "../../cloudflare";
import {
  FIREWORKS_INFERENCE_BASE_URL,
  resolveFireworksAudioTranscriptionTarget,
} from "../../fireworks";
import { resolveOllamaBaseUrl } from "../../ollama";
import { ProviderCapabilityError } from "../errors";
import type {
  ProviderCapabilityExecutionContext,
  ProviderCapabilityExecutor,
} from "../registry";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const MEDIA_REQUEST_TIMEOUT_MS = 60_000;
const OPENROUTER_APP_TITLE = "Atlas";
const OPENROUTER_REFERER = "https://github.com/kungfufafa/atlas";
const OPENROUTER_AUDIO_FORMATS: Readonly<Record<string, string>> = {
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/m4a": "m4a",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/webm": "webm",
  "audio/x-wav": "wav",
};
const TRANSCRIPTION_PROMPT =
  "Provide an accurate, verbatim transcription of the audio. Output only the transcribed text with no commentary or formatting.";

export interface AudioTranscriptionInput {
  bytes: Uint8Array;
  filename: string;
  mediaType: string;
}

export interface AudioTranscriptionOutput {
  text: string;
}

interface AudioExecutionContext {
  apiKey: string;
  baseUrl?: string;
  model: string;
}

export function normalizeAudioTranscriptionInput(
  value: unknown
): AudioTranscriptionInput {
  const input = requireRecord(value, "audio transcription input");
  if (!(input.bytes instanceof Uint8Array)) {
    throw new AtlasApiError(
      "Audio transcription input bytes must be binary data.",
      400
    );
  }
  if (input.bytes.byteLength === 0) {
    throw new AtlasApiError("Audio transcription input is empty.", 400);
  }

  const filename = requireNonEmptyString(
    input.filename,
    "Audio transcription filename"
  );
  const mediaType = requireNonEmptyString(
    input.mediaType,
    "Audio transcription media type"
  ).toLowerCase();
  if (!mediaType.startsWith("audio/")) {
    throw new AtlasApiError(
      `Audio transcription media type "${mediaType}" is not supported.`,
      400
    );
  }

  return {
    bytes: Uint8Array.from(input.bytes),
    filename,
    mediaType,
  };
}

export function normalizeAudioTranscriptionOutput(
  value: unknown
): AudioTranscriptionOutput {
  const output = requireRecord(value, "audio transcription output");
  const text = typeof output.text === "string" ? output.text.trim() : undefined;
  if (!text) {
    throw new AtlasApiError("Audio transcription returned empty text.", 502);
  }
  return { text };
}

export interface OpenAICompatibleAudioTranscriptionOptions {
  allowMissingApiKey?: boolean;
  anonymousAuthorization?: string;
  appendModelField?: boolean;
  defaultBaseUrl?: string;
  extraHeaders?: (
    context: ProviderCapabilityExecutionContext
  ) => Record<string, string>;
  resolveFormModel?: (execution: AudioExecutionContext) => string;
  resolveUrl?: (
    execution: AudioExecutionContext,
    context: ProviderCapabilityExecutionContext
  ) => string;
}

export function createOpenAICompatibleAudioTranscriptionExecutor(
  options: OpenAICompatibleAudioTranscriptionOptions = {}
): ProviderCapabilityExecutor {
  return async (context, input) => {
    const execution = normalizeExecutionContext(context, options);
    const audio = normalizeAudioTranscriptionInput(input);
    const url =
      options.resolveUrl?.(execution, context) ??
      `${normalizeBaseUrl(execution.baseUrl ?? options.defaultBaseUrl ?? DEFAULT_OPENAI_BASE_URL)}/audio/transcriptions`;
    const formData = new FormData();
    const audioCopy = Uint8Array.from(audio.bytes);
    formData.append(
      "file",
      new Blob([audioCopy], { type: audio.mediaType }),
      audio.filename
    );
    if (options.appendModelField !== false) {
      formData.append(
        "model",
        options.resolveFormModel?.(execution) ?? execution.model
      );
    }

    const authorization = execution.apiKey
      ? `Bearer ${execution.apiKey}`
      : options.anonymousAuthorization;
    const response = await fetch(url, {
      body: formData,
      headers: {
        ...(authorization ? { Authorization: authorization } : {}),
        ...options.extraHeaders?.(context),
      },
      method: "POST",
      signal: AbortSignal.timeout(MEDIA_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new AtlasApiError(
        `Audio transcription failed (${response.status}): ${body}`,
        502
      );
    }

    return normalizeAudioTranscriptionOutput(await response.json());
  };
}

export const openAIAudioTranscriptionExecutor =
  createOpenAICompatibleAudioTranscriptionExecutor();

export const fireworksAudioTranscriptionExecutor =
  createOpenAICompatibleAudioTranscriptionExecutor({
    defaultBaseUrl: FIREWORKS_INFERENCE_BASE_URL,
    resolveFormModel: (execution) =>
      resolveFireworksAudioTranscriptionTarget(execution.model).model,
    resolveUrl: (execution) =>
      resolveFireworksAudioTranscriptionTarget(execution.model).url,
  });

export const openRouterAudioTranscriptionExecutor: ProviderCapabilityExecutor =
  async (context, input) => {
    const execution = normalizeExecutionContext(context);
    const audio = normalizeAudioTranscriptionInput(input);
    const format = openRouterAudioFormat(audio.mediaType, audio.filename);
    const baseUrl = normalizeBaseUrl(
      execution.baseUrl ?? DEFAULT_OPENROUTER_BASE_URL
    );
    const response = await fetch(`${baseUrl}/audio/transcriptions`, {
      body: JSON.stringify({
        input_audio: {
          data: Buffer.from(audio.bytes).toString("base64"),
          format,
        },
        model: execution.model,
      }),
      headers: {
        Authorization: `Bearer ${execution.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": OPENROUTER_REFERER,
        "X-Title": OPENROUTER_APP_TITLE,
      },
      method: "POST",
      signal: AbortSignal.timeout(MEDIA_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new AtlasApiError(
        `Audio transcription failed (${response.status}): ${body}`,
        502
      );
    }
    return normalizeAudioTranscriptionOutput(await response.json());
  };

export const xAIAudioTranscriptionExecutor =
  createOpenAICompatibleAudioTranscriptionExecutor({
    appendModelField: false,
    defaultBaseUrl: defaultDiscoveryBaseUrl("xai") ?? "https://api.x.ai/v1",
    resolveUrl: (execution) =>
      `${normalizeBaseUrl(execution.baseUrl ?? defaultDiscoveryBaseUrl("xai") ?? "https://api.x.ai/v1")}/stt`,
  });

export const zhipuAudioTranscriptionExecutor =
  createOpenAICompatibleAudioTranscriptionExecutor({
    defaultBaseUrl:
      defaultDiscoveryBaseUrl("zhipu") ?? "https://api.z.ai/api/paas/v4",
  });

export const zhipuCnAudioTranscriptionExecutor =
  createOpenAICompatibleAudioTranscriptionExecutor({
    defaultBaseUrl:
      defaultDiscoveryBaseUrl("zhipu_cn") ??
      "https://open.bigmodel.cn/api/paas/v4",
  });

export const ollamaAudioTranscriptionExecutor =
  createOpenAICompatibleAudioTranscriptionExecutor({
    allowMissingApiKey: true,
    anonymousAuthorization: "Bearer ollama",
    defaultBaseUrl: defaultOllamaBaseUrl("local"),
    resolveUrl: (_execution, context) =>
      `${resolveOllamaBaseUrl(context.instance)}/audio/transcriptions`,
  });

export const cloudflareAudioTranscriptionExecutor: ProviderCapabilityExecutor =
  async (context, input) => {
    const execution = normalizeExecutionContext(context);
    const audio = normalizeAudioTranscriptionInput(input);
    const url = cloudflareMediaRunUrl(execution.model, context.instance);
    const useJsonAudio = /whisper-large-v3-turbo/i.test(execution.model);
    const audioCopy = Uint8Array.from(audio.bytes);
    const response = await fetch(url, {
      body: useJsonAudio
        ? JSON.stringify({
            audio: Buffer.from(audioCopy).toString("base64"),
          })
        : audioCopy,
      headers: {
        Authorization: `Bearer ${execution.apiKey}`,
        "Content-Type": useJsonAudio ? "application/json" : audio.mediaType,
      },
      method: "POST",
      signal: AbortSignal.timeout(MEDIA_REQUEST_TIMEOUT_MS),
    });
    const payload = await readCloudflareJson(response);
    const result = asRecord(payload.result) ?? payload;
    return normalizeAudioTranscriptionOutput({
      text: typeof result.text === "string" ? result.text : undefined,
    });
  };

export const geminiAudioTranscriptionExecutor: ProviderCapabilityExecutor =
  async (context, input) => {
    const execution = normalizeExecutionContext(context);
    const audio = normalizeAudioTranscriptionInput(input);
    const ai = new GoogleGenAI({
      apiKey: execution.apiKey,
      ...(execution.baseUrl
        ? { httpOptions: { baseUrl: execution.baseUrl } }
        : {}),
    });

    try {
      const response = await ai.models.generateContent({
        contents: [
          {
            parts: [
              {
                inlineData: {
                  data: Buffer.from(audio.bytes).toString("base64"),
                  mimeType: audio.mediaType,
                },
              },
              { text: TRANSCRIPTION_PROMPT },
            ],
            role: "user",
          },
        ],
        model: execution.model,
      });

      return normalizeAudioTranscriptionOutput({ text: response.text });
    } catch (error) {
      if (error instanceof AtlasApiError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new AtlasApiError(
        `Gemini audio transcription failed: ${message}`,
        502
      );
    }
  };

function normalizeExecutionContext(
  context: ProviderCapabilityExecutionContext,
  options: Pick<
    OpenAICompatibleAudioTranscriptionOptions,
    "allowMissingApiKey"
  > = {}
): AudioExecutionContext {
  const apiKey = context.apiKey.trim();
  if (!(apiKey || options.allowMissingApiKey)) {
    throw new ProviderCapabilityError({
      capabilityId: PROVIDER_CAPABILITY_IDS.audioTranscription,
      code: "CAPABILITY_CREDENTIALS_MISSING",
      message: `Credentials for "${context.instance.label}" are missing. Review Settings → Providers.`,
    });
  }

  const model = context.model.trim();
  if (!model) {
    throw new AtlasApiError(
      "Audio transcription model must be configured.",
      400
    );
  }
  const baseUrl = context.instance.baseUrl?.trim() || undefined;
  return { apiKey, baseUrl, model };
}

async function readCloudflareJson(
  response: Response
): Promise<Record<string, unknown>> {
  const body = await response.text();
  let payload: Record<string, unknown>;
  try {
    payload = requireRecord(JSON.parse(body), "Cloudflare transcription");
  } catch {
    throw new AtlasApiError(
      `Audio transcription failed (${response.status}): ${body}`,
      502
    );
  }
  if (!response.ok || payload.success === false) {
    throw new AtlasApiError(
      `Audio transcription failed (${response.status}): ${body}`,
      502
    );
  }
  return payload;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  return value as Record<string, unknown>;
}

function openRouterAudioFormat(mediaType: string, filename: string): string {
  const mapped = OPENROUTER_AUDIO_FORMATS[mediaType];
  if (mapped) {
    return mapped;
  }
  const extension = filename.split(".").pop()?.trim().toLowerCase();
  if (
    extension &&
    ["aac", "flac", "m4a", "mp3", "ogg", "wav", "webm"].includes(extension)
  ) {
    return extension;
  }
  throw new AtlasApiError(
    `OpenRouter transcription does not support media type "${mediaType}".`,
    400
  );
}

function cloudflareMediaRunUrl(
  model: string,
  instance: ProviderCapabilityExecutionContext["instance"]
): string {
  try {
    return resolveCloudflareModelRunUrl(
      model,
      instance,
      readEnvValue(process.env, "CLOUDFLARE_ACCOUNT_ID") ?? ""
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AtlasApiError(message, 400);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AtlasApiError(`${label} must be an object.`, 400);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new AtlasApiError(`${label} is required.`, 400);
  }
  return value.trim();
}

import {
  AtlasApiError,
  normalizeBaseUrl,
  PROVIDER_CAPABILITY_IDS,
} from "@atlas/core";
import { GoogleGenAI } from "@google/genai";
import { ProviderCapabilityError } from "../errors";
import type {
  ProviderCapabilityExecutionContext,
  ProviderCapabilityExecutor,
} from "../registry";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
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

export const openAIAudioTranscriptionExecutor: ProviderCapabilityExecutor =
  async (context, input) => {
    const execution = normalizeExecutionContext(context);
    const audio = normalizeAudioTranscriptionInput(input);
    const baseUrl = normalizeBaseUrl(
      execution.baseUrl ?? DEFAULT_OPENAI_BASE_URL
    );
    const formData = new FormData();
    const audioCopy = Uint8Array.from(audio.bytes);
    formData.append(
      "file",
      new Blob([audioCopy.buffer], { type: audio.mediaType }),
      audio.filename
    );
    formData.append("model", execution.model);

    const response = await fetch(`${baseUrl}/audio/transcriptions`, {
      body: formData,
      headers: {
        Authorization: `Bearer ${execution.apiKey}`,
      },
      method: "POST",
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
  context: ProviderCapabilityExecutionContext
): AudioExecutionContext {
  const apiKey = context.apiKey.trim();
  if (!apiKey) {
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

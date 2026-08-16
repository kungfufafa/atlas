import {
  AtlasApiError,
  findProviderInstance,
  normalizeBaseUrl,
  type ProviderInstance,
  type UserConfig,
} from "@atlas/core";
import { GoogleGenAI } from "@google/genai";
import { modelSupportsTranscription } from "../providers/models";
import {
  decodeStoredModelSelection,
  type ResolvedProfileProviderSelection,
} from "./provider-instance-helpers";

export const TRANSCRIPTION_MODEL_REQUIRED_MESSAGE =
  "Configure an audio transcription model in Settings before sending voice messages.";

export function resolveTranscriptionProviderSelection(
  userConfig: UserConfig | null | undefined
): ResolvedProfileProviderSelection | null {
  const transcriptionModel = userConfig?.transcriptionModel?.trim();

  if (!transcriptionModel) {
    return null;
  }

  const decoded = decodeStoredModelSelection(transcriptionModel);

  if (!decoded || decoded.providerId === "__unknown__") {
    throw new AtlasApiError(
      "Configured audio transcription model is invalid. Update it in Settings.",
      400
    );
  }

  const instance = findProviderInstance(
    { providers: userConfig?.providers ?? [] },
    decoded.providerId
  );

  if (!instance) {
    throw new AtlasApiError(
      "Configured audio transcription provider is missing. Update it in Settings.",
      400
    );
  }

  if (instance.type !== "openai") {
    throw new AtlasApiError(
      "Audio transcription requires an OpenAI provider.",
      400
    );
  }

  const modelId = decoded.modelId.trim();

  if (!modelSupportsTranscription(modelId, instance.type)) {
    throw new AtlasApiError(
      `Configured audio transcription model "${modelId}" is not supported.`,
      400
    );
  }

  return {
    instance,
    model: modelId,
  };
}

export async function transcribeAudioWithOpenAI(
  apiKey: string,
  baseUrl: string | undefined,
  model: string,
  audio: { bytes: Uint8Array; filename: string; mediaType: string }
): Promise<string> {
  const normalizedBase = normalizeBaseUrl(
    baseUrl ?? "https://api.openai.com/v1"
  );
  const formData = new FormData();
  const blob = new Blob([audio.bytes], { type: audio.mediaType });
  formData.append("file", blob, audio.filename);
  formData.append("model", model);

  const response = await fetch(`${normalizedBase}/audio/transcriptions`, {
    body: formData,
    headers: {
      Authorization: `Bearer ${apiKey}`,
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

  const payload = (await response.json()) as { text?: string };
  const text = payload.text?.trim();

  if (!text) {
    throw new AtlasApiError("Audio transcription returned empty text.", 502);
  }

  return text;
}

export async function transcribeAudioWithGemini(
  apiKey: string,
  baseUrl: string | undefined,
  model: string,
  audio: { bytes: Uint8Array; filename: string; mediaType: string }
): Promise<string> {
  const trimmed = baseUrl?.trim();
  const ai = new GoogleGenAI({
    apiKey,
    ...(trimmed ? { httpOptions: { baseUrl: trimmed } } : {}),
  });
  const base64 = Buffer.from(audio.bytes).toString("base64");
  const modelName = model || "gemini-2.0-flash";

  try {
    const response = await ai.models.generateContent({
      contents: [
        {
          parts: [
            {
              inlineData: {
                data: base64,
                mimeType: audio.mediaType || "audio/mp3",
              },
            },
            {
              text: "Please provide an accurate, verbatim transcription of the provided audio file. Output only the transcribed text with no extra commentary, explanations, or formatting.",
            },
          ],
          role: "user",
        },
      ],
      model: modelName,
    });

    const text = response.text?.trim();
    if (!text) {
      throw new AtlasApiError("Audio transcription returned empty text.", 502);
    }
    return text;
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
}

export async function transcribeAudio(
  instance: ProviderInstance,
  model: string,
  audio: { bytes: Uint8Array; filename: string; mediaType: string }
): Promise<string> {
  if (instance.type === "gemini") {
    return transcribeAudioWithGemini(
      instance.apiKey,
      instance.baseUrl,
      model,
      audio
    );
  }

  return transcribeAudioWithOpenAI(
    instance.apiKey,
    instance.baseUrl,
    model,
    audio
  );
}

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

export const IMAGE_GENERATION_SIZES = [
  "1024x1024",
  "1024x1536",
  "1536x1024",
  "auto",
] as const;

export type ImageGenerationSize = (typeof IMAGE_GENERATION_SIZES)[number];

export const DEFAULT_IMAGE_GENERATION_SIZE: ImageGenerationSize = "1024x1024";

export interface ImageGenerationInput {
  prompt: string;
  size?: string;
}

export interface ImageGenerationUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ImageGenerationOutput {
  data: Uint8Array;
  mediaType: string;
  model: string;
  revisedPrompt?: string;
  size: string;
  usage?: ImageGenerationUsage;
}

interface ImageGenerationExecutionContext {
  apiKey: string;
  baseUrl?: string;
  model: string;
}

export function normalizeImageGenerationInput(
  value: unknown
): Required<ImageGenerationInput> {
  const input = requireRecord(value, "image generation input");
  const prompt = requireNonEmptyString(input.prompt, "Image generation prompt");
  if (input.size !== undefined && typeof input.size !== "string") {
    throw new AtlasApiError(
      "Image generation size must be a string when provided.",
      400
    );
  }
  const size = normalizeImageGenerationSize(input.size);
  return { prompt, size };
}

export function normalizeImageGenerationOutput(
  value: unknown
): ImageGenerationOutput {
  const output = requireRecord(value, "image generation output");
  if (!(output.data instanceof Uint8Array) || output.data.byteLength === 0) {
    throw new AtlasApiError(
      "Image generation returned empty or invalid image data.",
      502
    );
  }

  const mediaType = requireNonEmptyString(
    output.mediaType,
    "Image generation media type"
  );
  if (!mediaType.startsWith("image/")) {
    throw new AtlasApiError(
      `Image generation returned invalid media type "${mediaType}".`,
      502
    );
  }

  const model = requireNonEmptyString(output.model, "Image generation model");
  const size = requireNonEmptyString(output.size, "Image generation size");
  const revisedPrompt = optionalNonEmptyString(output.revisedPrompt);
  const usage = normalizeUsage(output.usage);

  return {
    data: Uint8Array.from(output.data),
    mediaType,
    model,
    ...(revisedPrompt ? { revisedPrompt } : {}),
    size,
    ...(usage ? { usage } : {}),
  };
}

export function normalizeImageGenerationSize(
  value: string | null | undefined
): ImageGenerationSize {
  const size = value?.trim() || DEFAULT_IMAGE_GENERATION_SIZE;
  if ((IMAGE_GENERATION_SIZES as readonly string[]).includes(size)) {
    return size as ImageGenerationSize;
  }
  throw new AtlasApiError(
    `Unsupported image size "${size}". Allowed: ${IMAGE_GENERATION_SIZES.join(", ")}.`,
    400
  );
}

export function fallbackImageGenerationTokens(
  prompt: string,
  size: string
): ImageGenerationUsage {
  const inputTokens = Math.max(1, Math.ceil(prompt.trim().length / 4));
  const outputTokens = size === "1024x1536" || size === "1536x1024" ? 167 : 200;
  return { inputTokens, outputTokens };
}

export function resolveImageGenerationTokens(
  prompt: string,
  size: string,
  usage: { input_tokens?: number; output_tokens?: number } | undefined
): ImageGenerationUsage {
  if (
    usage &&
    isNonNegativeFiniteNumber(usage.input_tokens) &&
    isNonNegativeFiniteNumber(usage.output_tokens)
  ) {
    return {
      inputTokens: Math.floor(usage.input_tokens),
      outputTokens: Math.floor(usage.output_tokens),
    };
  }
  return fallbackImageGenerationTokens(prompt, size);
}

export const openAIImageGenerationExecutor: ProviderCapabilityExecutor = async (
  context,
  input
) => {
  const execution = normalizeExecutionContext(context);
  const normalized = normalizeImageGenerationInput(input);
  const baseUrl = normalizeBaseUrl(
    execution.baseUrl ?? DEFAULT_OPENAI_BASE_URL
  );
  const response = await fetch(`${baseUrl}/images/generations`, {
    body: JSON.stringify({
      model: execution.model,
      n: 1,
      output_format: "png",
      prompt: normalized.prompt,
      size: normalized.size,
    }),
    headers: {
      Authorization: `Bearer ${execution.apiKey}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    const body = await response.text();
    throw new AtlasApiError(
      `Image generation failed (${response.status}): ${body}`,
      502
    );
  }

  const payload = (await response.json()) as {
    data?: Array<{ b64_json?: string; revised_prompt?: string; url?: string }>;
    output_format?: string;
    size?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const first = payload.data?.[0];
  const bytes = await resolveOpenAIImageBytes(first);
  const mediaType = mediaTypeForOutputFormat(payload.output_format);

  return normalizeImageGenerationOutput({
    data: bytes,
    mediaType,
    model: execution.model,
    revisedPrompt: first?.revised_prompt,
    size: payload.size?.trim() || normalized.size,
    usage: resolveImageGenerationTokens(
      normalized.prompt,
      normalized.size,
      payload.usage
    ),
  });
};

export const geminiImageGenerationExecutor: ProviderCapabilityExecutor = async (
  context,
  input
) => {
  const execution = normalizeExecutionContext(context);
  const normalized = normalizeImageGenerationInput(input);
  if (
    normalized.size !== DEFAULT_IMAGE_GENERATION_SIZE &&
    normalized.size !== "auto"
  ) {
    throw new AtlasApiError(
      `Gemini image generation does not support Atlas size "${normalized.size}". Use "1024x1024" or "auto".`,
      400
    );
  }

  const ai = new GoogleGenAI({
    apiKey: execution.apiKey,
    ...(execution.baseUrl
      ? { httpOptions: { baseUrl: execution.baseUrl } }
      : {}),
  });

  try {
    const response = await ai.models.generateContent({
      config: {
        imageConfig: { aspectRatio: "1:1" },
        responseModalities: ["IMAGE"],
      },
      contents: normalized.prompt,
      model: execution.model,
    });
    const generatedImage = findGeminiGeneratedImage(response.candidates);
    if (!generatedImage) {
      throw new AtlasApiError(
        "Gemini image generation returned no image data.",
        502
      );
    }

    const size = DEFAULT_IMAGE_GENERATION_SIZE;
    return normalizeImageGenerationOutput({
      data: decodeBase64Image(generatedImage.data),
      mediaType: generatedImage.mediaType,
      model: execution.model,
      size,
      usage: fallbackImageGenerationTokens(normalized.prompt, size),
    });
  } catch (error) {
    if (error instanceof AtlasApiError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new AtlasApiError(`Gemini image generation failed: ${message}`, 502);
  }
};

function findGeminiGeneratedImage(
  candidates:
    | Array<{
        content?: {
          parts?: Array<{
            inlineData?: { data?: string; mimeType?: string };
          }>;
        };
      }>
    | undefined
): { data: string; mediaType: string } | null {
  for (const candidate of candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      const data = part.inlineData?.data?.trim();
      if (!data) {
        continue;
      }
      const mediaType = part.inlineData?.mimeType?.trim() || "image/png";
      if (mediaType.startsWith("image/")) {
        return { data, mediaType };
      }
    }
  }
  return null;
}

function normalizeExecutionContext(
  context: ProviderCapabilityExecutionContext
): ImageGenerationExecutionContext {
  const apiKey = context.apiKey.trim();
  if (!apiKey) {
    throw new ProviderCapabilityError({
      capabilityId: PROVIDER_CAPABILITY_IDS.imageGeneration,
      code: "CAPABILITY_CREDENTIALS_MISSING",
      message: `Credentials for "${context.instance.label}" are missing. Review Settings → Providers.`,
    });
  }
  const model = context.model.trim();
  if (!model) {
    throw new AtlasApiError("Image generation model must be configured.", 400);
  }
  return {
    apiKey,
    baseUrl: context.instance.baseUrl?.trim() || undefined,
    model,
  };
}

async function resolveOpenAIImageBytes(
  image: { b64_json?: string; url?: string } | undefined
): Promise<Uint8Array> {
  const encoded = image?.b64_json?.trim();
  if (encoded) {
    return decodeBase64Image(encoded);
  }
  const url = image?.url?.trim();
  if (!url) {
    throw new AtlasApiError("Image generation returned no image data.", 502);
  }

  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AtlasApiError(
      `Image generation output download failed: ${message}`,
      502
    );
  }
  if (!response.ok) {
    throw new AtlasApiError(
      `Image generation output download failed (${response.status}).`,
      502
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new AtlasApiError("Image generation returned empty image data.", 502);
  }
  return bytes;
}

function decodeBase64Image(value: string): Uint8Array {
  const bytes = Uint8Array.from(Buffer.from(value, "base64"));
  if (bytes.byteLength === 0) {
    throw new AtlasApiError("Image generation returned empty image data.", 502);
  }
  return bytes;
}

function mediaTypeForOutputFormat(value: string | undefined): string {
  if (value === "jpeg") {
    return "image/jpeg";
  }
  if (value === "webp") {
    return "image/webp";
  }
  return "image/png";
}

function normalizeUsage(value: unknown): ImageGenerationUsage | undefined {
  if (value === undefined) {
    return;
  }
  const usage = requireRecord(value, "image generation usage");
  if (
    !(
      isNonNegativeFiniteNumber(usage.inputTokens) &&
      isNonNegativeFiniteNumber(usage.outputTokens)
    )
  ) {
    throw new AtlasApiError(
      "Image generation returned invalid usage data.",
      502
    );
  }
  return {
    inputTokens: Math.floor(usage.inputTokens),
    outputTokens: Math.floor(usage.outputTokens),
  };
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
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

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

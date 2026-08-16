import {
  AtlasApiError,
  findProviderInstance,
  normalizeBaseUrl,
  type ProviderInstance,
  type UserConfig,
} from "@atlas/core";
import { GoogleGenAI } from "@google/genai";
import { readApiKeyForInstance } from "../providers/create";
import {
  IMAGE_GENERATION_MODEL_ID,
  isAllowedImageGenerationSelection,
  modelSupportsImageGeneration,
} from "../providers/models";
import { decodeStoredModelSelection } from "./provider-instance-helpers";

export const IMAGE_MODEL_REQUIRED_MESSAGE =
  "Configure an image generation model in Settings before generating images.";

export const IMAGE_GENERATION_SIZES = [
  "1024x1024",
  "1024x1536",
  "1536x1024",
  "auto",
] as const;

export type ImageGenerationSize = (typeof IMAGE_GENERATION_SIZES)[number];

export const DEFAULT_IMAGE_GENERATION_SIZE: ImageGenerationSize = "1024x1024";

const OPENAI_IMAGES_GENERATIONS_URL =
  "https://api.openai.com/v1/images/generations";

export interface ResolvedImageGenerationSelection {
  apiKey: string;
  instance: ProviderInstance;
  model: string;
  selection: string;
}

export interface ImageGenerationUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface GenerateImageResult {
  data: Uint8Array;
  mediaType: string;
  model: string;
  revisedPrompt?: string;
  size: string;
  usage?: ImageGenerationUsage;
}

export interface GenerateImageInput {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  prompt: string;
  size?: string;
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
    typeof usage.input_tokens === "number" &&
    typeof usage.output_tokens === "number" &&
    Number.isFinite(usage.input_tokens) &&
    Number.isFinite(usage.output_tokens) &&
    usage.input_tokens >= 0 &&
    usage.output_tokens >= 0
  ) {
    return {
      inputTokens: Math.floor(usage.input_tokens),
      outputTokens: Math.floor(usage.output_tokens),
    };
  }

  return fallbackImageGenerationTokens(prompt, size);
}

export function normalizeImageGenerationSize(
  size: string | null | undefined
): ImageGenerationSize {
  const trimmed = size?.trim();
  if (!trimmed) {
    return DEFAULT_IMAGE_GENERATION_SIZE;
  }

  if ((IMAGE_GENERATION_SIZES as readonly string[]).includes(trimmed)) {
    return trimmed as ImageGenerationSize;
  }

  throw new AtlasApiError(
    `Unsupported image size "${trimmed}". Allowed: ${IMAGE_GENERATION_SIZES.join(", ")}.`,
    400
  );
}

export function resolveImageGenerationSelection(
  userConfig: UserConfig | null | undefined,
  env: Record<string, string | undefined> = process.env
): ResolvedImageGenerationSelection | null {
  const imageModel = userConfig?.imageModel?.trim();

  if (!imageModel) {
    return null;
  }

  if (!isAllowedImageGenerationSelection(imageModel)) {
    throw new AtlasApiError(
      "Configured image generation model is invalid. Update it in Settings.",
      400
    );
  }

  const decoded = decodeStoredModelSelection(imageModel);
  const providers = userConfig?.providers ?? [];
  let instance: ProviderInstance | null = null;
  let model = IMAGE_GENERATION_MODEL_ID;

  if (decoded && decoded.providerId !== "__unknown__") {
    instance =
      findProviderInstance({ providers }, decoded.providerId) ??
      providers.find((p) => p.type === decoded.providerId) ??
      null;
    model = decoded.modelId || IMAGE_GENERATION_MODEL_ID;
  } else {
    const preferredId = userConfig?.defaultProviderId?.trim();
    instance =
      (preferredId ? findProviderInstance({ providers }, preferredId) : null) ??
      providers.find((p) => p.type === "openai" || p.type === "gemini") ??
      providers[0] ??
      null;
  }

  if (!instance) {
    throw new AtlasApiError(
      "Image generation provider is missing. Add or update one in Settings.",
      400
    );
  }

  if (!modelSupportsImageGeneration(model, instance.type)) {
    throw new AtlasApiError(
      `Configured image generation model "${model}" is not supported for provider "${instance.type}".`,
      400
    );
  }

  const apiKey = readApiKeyForInstance(instance, env)?.trim();

  if (!apiKey) {
    throw new AtlasApiError(
      `API key for "${instance.label || instance.type}" is missing. Configure it in Settings.`,
      400
    );
  }

  return {
    apiKey,
    instance,
    model,
    selection: imageModel,
  };
}

export async function generateImageWithOpenAI(
  input: GenerateImageInput
): Promise<GenerateImageResult> {
  const prompt = input.prompt?.trim();

  if (!prompt) {
    throw new AtlasApiError("Image prompt is required.", 400);
  }

  const model = (input.model?.trim() || IMAGE_GENERATION_MODEL_ID) as string;
  const size = normalizeImageGenerationSize(input.size);
  const apiKey = input.apiKey?.trim();

  if (!apiKey) {
    throw new AtlasApiError(
      "API key is missing. Configure a provider in Settings.",
      400
    );
  }

  const baseUrl = input.baseUrl
    ? `${normalizeBaseUrl(input.baseUrl)}/images/generations`
    : OPENAI_IMAGES_GENERATIONS_URL;

  const response = await fetch(baseUrl, {
    body: JSON.stringify({
      model,
      n: 1,
      output_format: "png",
      prompt,
      response_format: "b64_json",
      size,
    }),
    headers: {
      Authorization: `Bearer ${apiKey}`,
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
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const first = payload.data?.[0];
  let b64 = first?.b64_json?.trim();

  if (!b64 && first?.url) {
    try {
      const imgRes = await fetch(first.url);
      if (imgRes.ok) {
        const ab = await imgRes.arrayBuffer();
        b64 = Buffer.from(ab).toString("base64");
      }
    } catch {
      // Fallthrough to empty check
    }
  }

  if (!b64) {
    throw new AtlasApiError("Image generation returned no image data.", 502);
  }

  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(Buffer.from(b64, "base64"));
  } catch {
    throw new AtlasApiError(
      "Image generation returned invalid base64 data.",
      502
    );
  }

  if (bytes.length === 0) {
    throw new AtlasApiError("Image generation returned empty image data.", 502);
  }

  const mediaType =
    payload.output_format === "jpeg"
      ? "image/jpeg"
      : payload.output_format === "webp"
        ? "image/webp"
        : "image/png";

  return {
    data: bytes,
    mediaType,
    model,
    size,
    ...(first?.revised_prompt?.trim()
      ? { revisedPrompt: first.revised_prompt.trim() }
      : {}),
    usage: resolveImageGenerationTokens(prompt, size, payload.usage),
  };
}

export async function generateImageWithGemini(
  input: GenerateImageInput
): Promise<GenerateImageResult> {
  const prompt = input.prompt?.trim();
  if (!prompt) {
    throw new AtlasApiError("Image prompt is required.", 400);
  }

  const model = input.model?.trim() || "imagen-3.0-generate-002";
  const apiKey = input.apiKey?.trim();
  if (!apiKey) {
    throw new AtlasApiError("Gemini API key is missing.", 400);
  }

  const ai = new GoogleGenAI({
    apiKey,
    ...(input.baseUrl ? { httpOptions: { baseUrl: input.baseUrl } } : {}),
  });

  try {
    const response = await ai.models.generateImages({
      config: {
        numberOfImages: 1,
        outputMimeType: "image/png",
      },
      model,
      prompt,
    });

    const generated = response.generatedImages?.[0]?.image;
    const b64 = generated?.imageBytes;
    if (!b64) {
      throw new AtlasApiError(
        "Gemini image generation returned no image data.",
        502
      );
    }

    const bytes = Uint8Array.from(Buffer.from(b64, "base64"));
    return {
      data: bytes,
      mediaType: "image/png",
      model,
      size: "1024x1024",
      usage: fallbackImageGenerationTokens(prompt, "1024x1024"),
    };
  } catch (error) {
    if (error instanceof AtlasApiError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new AtlasApiError(`Gemini image generation failed: ${message}`, 502);
  }
}

export async function generateImage(
  selection: ResolvedImageGenerationSelection,
  input: { prompt: string; size?: string }
): Promise<GenerateImageResult> {
  if (selection.instance.type === "gemini") {
    return generateImageWithGemini({
      apiKey: selection.apiKey,
      baseUrl: selection.instance.baseUrl,
      model: selection.model,
      prompt: input.prompt,
      size: input.size,
    });
  }

  return generateImageWithOpenAI({
    apiKey: selection.apiKey,
    baseUrl: selection.instance.baseUrl,
    model: selection.model,
    prompt: input.prompt,
    size: input.size,
  });
}

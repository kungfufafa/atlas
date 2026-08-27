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
  resolveFireworksImageGenerationTarget,
} from "../../fireworks";
import { resolveOllamaBaseUrl } from "../../ollama";
import { ProviderCapabilityError } from "../errors";
import type {
  ProviderCapabilityExecutionContext,
  ProviderCapabilityExecutor,
} from "../registry";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_APP_TITLE = "Atlas";
const OPENROUTER_REFERER = "https://github.com/kungfufafa/atlas";
const FIREWORKS_IMAGE_POLL_INTERVAL_MS = 500;
const FIREWORKS_IMAGE_POLL_TIMEOUT_MS = 120_000;
const MEDIA_REQUEST_TIMEOUT_MS = 60_000;

export const IMAGE_GENERATION_SIZES = [
  "1024x1024",
  "1024x1536",
  "1536x1024",
  "auto",
] as const;

export type ImageGenerationSize = (typeof IMAGE_GENERATION_SIZES)[number];

export const DEFAULT_IMAGE_GENERATION_SIZE: ImageGenerationSize = "auto";

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

export function atlasSizeToAspectRatio(
  size: string,
  autoValue = "1:1"
): string {
  if (size === "1024x1536") {
    return "2:3";
  }
  if (size === "1536x1024") {
    return "3:2";
  }
  if (size === "auto") {
    return autoValue;
  }
  return "1:1";
}

export function atlasSizeToDimensions(size: string): {
  height: number;
  width: number;
} {
  if (size === "1024x1536") {
    return { height: 1536, width: 1024 };
  }
  if (size === "1536x1024") {
    return { height: 1024, width: 1536 };
  }
  return { height: 1024, width: 1024 };
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
  if (normalized.size !== "1024x1024" && normalized.size !== "auto") {
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

    const size = "1024x1024";
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

export interface OpenAICompatibleImageGenerationOptions {
  allowMissingApiKey?: boolean;
  anonymousAuthorization?: string;
  buildBody?: (
    execution: ImageGenerationExecutionContext,
    input: Required<ImageGenerationInput>
  ) => Record<string, unknown>;
  defaultBaseUrl?: string;
  extraHeaders?: (
    context: ProviderCapabilityExecutionContext
  ) => Record<string, string>;
  path?: string;
  readImage?: (
    payload: Record<string, unknown>,
    execution: ImageGenerationExecutionContext,
    input: Required<ImageGenerationInput>
  ) => Promise<ImageGenerationOutput> | ImageGenerationOutput;
  resolveUrl?: (
    execution: ImageGenerationExecutionContext,
    context: ProviderCapabilityExecutionContext
  ) => string;
}

export function createOpenAICompatibleImageGenerationExecutor(
  options: OpenAICompatibleImageGenerationOptions = {}
): ProviderCapabilityExecutor {
  return async (context, input) => {
    const execution = normalizeExecutionContext(context, options);
    const normalized = normalizeImageGenerationInput(input);
    const url =
      options.resolveUrl?.(execution, context) ??
      `${normalizeBaseUrl(execution.baseUrl ?? options.defaultBaseUrl ?? DEFAULT_OPENAI_BASE_URL)}${options.path ?? "/images/generations"}`;
    const authorization = execution.apiKey
      ? `Bearer ${execution.apiKey}`
      : options.anonymousAuthorization;
    const response = await fetch(url, {
      body: JSON.stringify(
        options.buildBody?.(execution, normalized) ?? {
          model: execution.model,
          n: 1,
          output_format: "png",
          prompt: normalized.prompt,
          size: normalized.size,
        }
      ),
      headers: {
        ...(authorization ? { Authorization: authorization } : {}),
        "Content-Type": "application/json",
        ...options.extraHeaders?.(context),
      },
      method: "POST",
      signal: AbortSignal.timeout(MEDIA_REQUEST_TIMEOUT_MS),
    });
    const payload = await readJsonObject(response, "Image generation");
    if (options.readImage) {
      return normalizeImageGenerationOutput(
        await options.readImage(payload, execution, normalized)
      );
    }
    return readOpenAIImagePayload(payload, execution, normalized);
  };
}

export const fireworksImageGenerationExecutor: ProviderCapabilityExecutor =
  async (context, input) => {
    const execution = normalizeExecutionContext(context);
    const normalized = normalizeImageGenerationInput(input);
    const target = resolveFireworksImageGenerationTarget(
      execution.model,
      execution.baseUrl ?? FIREWORKS_INFERENCE_BASE_URL
    );
    const dimensions = atlasSizeToDimensions(normalized.size);
    const body = {
      aspect_ratio: atlasSizeToAspectRatio(normalized.size),
      height: dimensions.height,
      prompt: normalized.prompt,
      samples: 1,
      width: dimensions.width,
    };

    if (target.kind === "workflows_async") {
      const submitted = await readJsonObject(
        await fetch(target.url, {
          body: JSON.stringify(body),
          headers: jsonAuthHeaders(execution.apiKey),
          method: "POST",
          signal: AbortSignal.timeout(MEDIA_REQUEST_TIMEOUT_MS),
        }),
        "Fireworks image generation"
      );
      const requestId =
        optionalNonEmptyString(submitted.request_id) ??
        optionalNonEmptyString(submitted.id);
      if (!requestId) {
        throw new AtlasApiError(
          "Fireworks image generation did not return a request id.",
          502
        );
      }
      const imageUrl = await pollFireworksImageUrl(
        target.pollUrl ?? `${target.url}/get_result`,
        requestId,
        execution.apiKey
      );
      const bytes = await downloadImageBytes(imageUrl);
      return normalizeImageGenerationOutput({
        data: bytes,
        mediaType: mediaTypeFromImageBytes(bytes),
        model: execution.model,
        size: normalized.size,
        usage: fallbackImageGenerationTokens(
          normalized.prompt,
          normalized.size
        ),
      });
    }

    const response = await fetch(target.url, {
      body: JSON.stringify(body),
      headers: jsonAuthHeaders(execution.apiKey),
      method: "POST",
      signal: AbortSignal.timeout(MEDIA_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new AtlasApiError(
        `Image generation failed (${response.status}): ${await response.text()}`,
        502
      );
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const payload = requireRecord(
        await response.json(),
        "Fireworks image generation"
      );
      return readOpenAIImagePayload(payload, execution, normalized);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw new AtlasApiError(
        "Image generation returned empty image data.",
        502
      );
    }
    return normalizeImageGenerationOutput({
      data: bytes,
      mediaType: mediaTypeFromImageBytes(bytes, contentType),
      model: execution.model,
      size: normalized.size,
      usage: fallbackImageGenerationTokens(normalized.prompt, normalized.size),
    });
  };

export const cloudflareImageGenerationExecutor: ProviderCapabilityExecutor =
  async (context, input) => {
    const execution = normalizeExecutionContext(context);
    const normalized = normalizeImageGenerationInput(input);
    const dimensions = atlasSizeToDimensions(normalized.size);
    const url = cloudflareMediaRunUrl(execution.model, context.instance);
    const useMultipart = /flux-2/i.test(execution.model);
    const jsonBody = /flux-1-schnell/i.test(execution.model)
      ? { prompt: normalized.prompt }
      : {
          height: dimensions.height,
          prompt: normalized.prompt,
          width: dimensions.width,
        };
    const response = useMultipart
      ? await fetch(url, {
          body: cloudflareImageForm(normalized.prompt, dimensions),
          headers: { Authorization: `Bearer ${execution.apiKey}` },
          method: "POST",
          signal: AbortSignal.timeout(MEDIA_REQUEST_TIMEOUT_MS),
        })
      : await fetch(url, {
          body: JSON.stringify(jsonBody),
          headers: jsonAuthHeaders(execution.apiKey),
          method: "POST",
          signal: AbortSignal.timeout(MEDIA_REQUEST_TIMEOUT_MS),
        });
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok) {
      throw new AtlasApiError(
        `Image generation failed (${response.status}): ${await response.text()}`,
        502
      );
    }
    if (contentType.startsWith("image/")) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      return normalizeImageGenerationOutput({
        data: bytes,
        mediaType: contentType.split(";")[0]?.trim() || "image/png",
        model: execution.model,
        size: normalized.size,
        usage: fallbackImageGenerationTokens(
          normalized.prompt,
          normalized.size
        ),
      });
    }
    const payload = requireRecord(
      await response.json(),
      "Cloudflare image generation"
    );
    if (payload.success === false) {
      throw new AtlasApiError(
        `Image generation failed (${response.status}): ${JSON.stringify(payload)}`,
        502
      );
    }
    const result = asRecord(payload.result) ?? payload;
    const encoded =
      optionalNonEmptyString(result.image) ??
      optionalNonEmptyString(result.b64_json);
    if (!encoded) {
      throw new AtlasApiError("Image generation returned no image data.", 502);
    }
    const bytes = decodeBase64Image(encoded);
    return normalizeImageGenerationOutput({
      data: bytes,
      mediaType: mediaTypeFromImageBytes(bytes, "image/jpeg"),
      model: execution.model,
      size: normalized.size,
      usage: fallbackImageGenerationTokens(normalized.prompt, normalized.size),
    });
  };

export const openRouterImageGenerationExecutor =
  createOpenAICompatibleImageGenerationExecutor({
    buildBody: (execution, input) => ({
      aspect_ratio: atlasSizeToAspectRatio(input.size, "auto"),
      model: execution.model,
      n: 1,
      output_format: "png",
      prompt: input.prompt,
    }),
    defaultBaseUrl: DEFAULT_OPENROUTER_BASE_URL,
    extraHeaders: () => ({
      "HTTP-Referer": OPENROUTER_REFERER,
      "X-Title": OPENROUTER_APP_TITLE,
    }),
    path: "/images",
    readImage: (payload, execution, input) => {
      const data = Array.isArray(payload.data) ? payload.data : [];
      const first = asRecord(data[0]);
      const encoded = optionalNonEmptyString(first?.b64_json);
      if (!encoded) {
        throw new AtlasApiError(
          "Image generation returned no image data.",
          502
        );
      }
      const usage = asRecord(payload.usage);
      return {
        data: decodeBase64Image(encoded),
        mediaType:
          optionalNonEmptyString(first?.media_type) &&
          String(first?.media_type).startsWith("image/")
            ? String(first?.media_type)
            : "image/png",
        model: execution.model,
        size: input.size,
        usage: resolveImageGenerationTokens(input.prompt, input.size, {
          input_tokens:
            typeof usage?.prompt_tokens === "number"
              ? usage.prompt_tokens
              : typeof usage?.input_tokens === "number"
                ? usage.input_tokens
                : undefined,
          output_tokens:
            typeof usage?.completion_tokens === "number"
              ? usage.completion_tokens
              : typeof usage?.output_tokens === "number"
                ? usage.output_tokens
                : undefined,
        }),
      };
    },
  });

export const minimaxImageGenerationExecutor =
  createOpenAICompatibleImageGenerationExecutor({
    buildBody: (execution, input) => ({
      aspect_ratio: atlasSizeToAspectRatio(input.size),
      model: execution.model,
      n: 1,
      prompt: input.prompt,
      response_format: "base64",
    }),
    defaultBaseUrl:
      defaultDiscoveryBaseUrl("minimax") ?? "https://api.minimax.io/v1",
    path: "/image_generation",
    readImage: (payload, execution, input) => {
      const baseResp = asRecord(payload.base_resp);
      const statusCode = baseResp?.status_code;
      if (statusCode !== undefined && statusCode !== 0) {
        throw new AtlasApiError(
          `Image generation failed (${String(statusCode)}): ${optionalNonEmptyString(baseResp?.status_msg) ?? "MiniMax rejected the request."}`,
          502
        );
      }
      const data = asRecord(payload.data) ?? payload;
      const encoded = Array.isArray(data.image_base64)
        ? optionalNonEmptyString(data.image_base64[0])
        : optionalNonEmptyString(data.image_base64);
      if (encoded) {
        const bytes = decodeBase64Image(encoded);
        return {
          data: bytes,
          mediaType: mediaTypeFromImageBytes(bytes),
          model: execution.model,
          size: input.size,
          usage: fallbackImageGenerationTokens(input.prompt, input.size),
        };
      }
      const url = Array.isArray(data.image_urls)
        ? optionalNonEmptyString(data.image_urls[0])
        : optionalNonEmptyString(data.image_urls);
      if (!url) {
        throw new AtlasApiError(
          "Image generation returned no image data.",
          502
        );
      }
      return downloadImageOutput(url, execution.model, input);
    },
    resolveUrl: (execution, context) => {
      const fallback =
        context.instance.type === "minimax_cn"
          ? (defaultDiscoveryBaseUrl("minimax_cn") ??
            "https://api.minimaxi.com/v1")
          : (defaultDiscoveryBaseUrl("minimax") ?? "https://api.minimax.io/v1");
      return `${normalizeBaseUrl(execution.baseUrl ?? fallback)}/image_generation`;
    },
  });

export const xAIImageGenerationExecutor =
  createOpenAICompatibleImageGenerationExecutor({
    buildBody: (execution, input) => ({
      aspect_ratio: atlasSizeToAspectRatio(input.size, "auto"),
      model: execution.model,
      n: 1,
      prompt: input.prompt,
      response_format: "b64_json",
    }),
    defaultBaseUrl: defaultDiscoveryBaseUrl("xai") ?? "https://api.x.ai/v1",
  });

export const zhipuImageGenerationExecutor =
  createOpenAICompatibleImageGenerationExecutor({
    buildBody: (execution, input) => ({
      model: execution.model,
      n: 1,
      prompt: input.prompt,
      size: zhipuImageSize(input.size),
    }),
    defaultBaseUrl:
      defaultDiscoveryBaseUrl("zhipu") ?? "https://api.z.ai/api/paas/v4",
  });

export const zhipuCnImageGenerationExecutor =
  createOpenAICompatibleImageGenerationExecutor({
    buildBody: (execution, input) => ({
      model: execution.model,
      n: 1,
      prompt: input.prompt,
      size: zhipuImageSize(input.size),
    }),
    defaultBaseUrl:
      defaultDiscoveryBaseUrl("zhipu_cn") ??
      "https://open.bigmodel.cn/api/paas/v4",
  });

export const ollamaImageGenerationExecutor =
  createOpenAICompatibleImageGenerationExecutor({
    allowMissingApiKey: true,
    anonymousAuthorization: "Bearer ollama",
    buildBody: (execution, input) => ({
      model: execution.model,
      n: 1,
      prompt: input.prompt,
      size: input.size === "auto" ? "1024x1024" : input.size,
    }),
    defaultBaseUrl: defaultOllamaBaseUrl("local"),
    resolveUrl: (_execution, context) =>
      `${resolveOllamaBaseUrl(context.instance)}/images/generations`,
  });

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
  context: ProviderCapabilityExecutionContext,
  options: Pick<
    OpenAICompatibleImageGenerationOptions,
    "allowMissingApiKey"
  > = {}
): ImageGenerationExecutionContext {
  const apiKey = context.apiKey.trim();
  if (!(apiKey || options.allowMissingApiKey)) {
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

function zhipuImageSize(size: string): string {
  if (size === "1024x1536") {
    return "1056x1568";
  }
  if (size === "1536x1024") {
    return "1568x1056";
  }
  return "1280x1280";
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

function jsonAuthHeaders(apiKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };
}

async function readJsonObject(
  response: Response,
  label: string
): Promise<Record<string, unknown>> {
  const body = await response.text();
  if (!response.ok) {
    throw new AtlasApiError(
      `${label} failed (${response.status}): ${body}`,
      502
    );
  }
  try {
    return requireRecord(JSON.parse(body), label);
  } catch (error) {
    if (error instanceof AtlasApiError) {
      throw error;
    }
    throw new AtlasApiError(
      `${label} failed (${response.status}): ${body}`,
      502
    );
  }
}

async function readOpenAIImagePayload(
  payload: Record<string, unknown>,
  execution: ImageGenerationExecutionContext,
  input: Required<ImageGenerationInput>
): Promise<ImageGenerationOutput> {
  const data = Array.isArray(payload.data) ? payload.data : [];
  const first = asRecord(data[0]);
  const bytes = await resolveOpenAIImageBytes(
    first
      ? {
          b64_json: optionalNonEmptyString(first.b64_json),
          url: optionalNonEmptyString(first.url),
        }
      : undefined
  );
  const usage = asRecord(payload.usage);
  return normalizeImageGenerationOutput({
    data: bytes,
    mediaType: mediaTypeForOutputFormat(
      optionalNonEmptyString(payload.output_format)
    ),
    model: execution.model,
    revisedPrompt: optionalNonEmptyString(first?.revised_prompt),
    size: optionalNonEmptyString(payload.size) || input.size,
    usage: resolveImageGenerationTokens(input.prompt, input.size, {
      input_tokens:
        typeof usage?.input_tokens === "number"
          ? usage.input_tokens
          : undefined,
      output_tokens:
        typeof usage?.output_tokens === "number"
          ? usage.output_tokens
          : undefined,
    }),
  });
}

async function pollFireworksImageUrl(
  pollUrl: string,
  requestId: string,
  apiKey: string
): Promise<string> {
  const started = Date.now();
  while (Date.now() - started < FIREWORKS_IMAGE_POLL_TIMEOUT_MS) {
    const payload = await readJsonObject(
      await fetch(pollUrl, {
        body: JSON.stringify({ id: requestId }),
        headers: jsonAuthHeaders(apiKey),
        method: "POST",
        signal: AbortSignal.timeout(MEDIA_REQUEST_TIMEOUT_MS),
      }),
      "Fireworks image generation"
    );
    const status = optionalNonEmptyString(payload.status);
    if (status === "Ready") {
      const result = asRecord(payload.result);
      const sample = optionalNonEmptyString(result?.sample);
      if (sample) {
        return sample;
      }
      throw new AtlasApiError(
        "Fireworks image generation is ready but missing result.sample.",
        502
      );
    }
    if (status === "Error" || status === "Failed") {
      throw new AtlasApiError(
        `Fireworks image generation failed with status: ${status}.`,
        502
      );
    }
    await new Promise((resolve) => {
      setTimeout(resolve, FIREWORKS_IMAGE_POLL_INTERVAL_MS);
    });
  }
  throw new AtlasApiError(
    `Fireworks image generation timed out after ${FIREWORKS_IMAGE_POLL_TIMEOUT_MS}ms.`,
    502
  );
}

async function downloadImageBytes(url: string): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(MEDIA_REQUEST_TIMEOUT_MS),
    });
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

async function downloadImageOutput(
  url: string,
  model: string,
  input: Required<ImageGenerationInput>
): Promise<ImageGenerationOutput> {
  const bytes = await downloadImageBytes(url);
  return {
    data: bytes,
    mediaType: mediaTypeFromImageBytes(bytes),
    model,
    size: input.size,
    usage: fallbackImageGenerationTokens(input.prompt, input.size),
  };
}

function mediaTypeFromImageBytes(
  bytes: Uint8Array,
  contentType?: string
): string {
  const headerType = contentType?.split(";")[0]?.trim();
  if (headerType?.startsWith("image/")) {
    return headerType;
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return "image/jpeg";
  }
  if (bytes[0] === 0x52 && bytes[1] === 0x49) {
    return "image/webp";
  }
  return "image/png";
}

function cloudflareImageForm(
  prompt: string,
  dimensions: { height: number; width: number }
): FormData {
  const form = new FormData();
  form.append("prompt", prompt);
  form.append("width", String(dimensions.width));
  form.append("height", String(dimensions.height));
  return form;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  return value as Record<string, unknown>;
}

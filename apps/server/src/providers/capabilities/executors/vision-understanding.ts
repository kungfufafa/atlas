import {
  AtlasApiError,
  IMAGE_VISION_SYSTEM_PROMPT,
  type MessageContentPart,
  type ProviderClient,
} from "@atlas/core";
import type {
  ProviderCapabilityExecutionContext,
  ProviderCapabilityExecutor,
} from "../registry";

export type VisionImage = Extract<MessageContentPart, { type: "image" }>;

export interface VisionUnderstandingInput {
  images: VisionImage[];
  instruction?: string;
}

export interface VisionUnderstandingOutput {
  descriptions: string[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export type VisionChatClientFactory = (
  context: ProviderCapabilityExecutionContext
) => ProviderClient;

/**
 * Compose an image-understanding executor with an adapter-owned chat client.
 * The executor is provider-agnostic; adapters own wire protocol and credentials.
 */
export function createVisionUnderstandingExecutor(
  createChatClient: VisionChatClientFactory
): ProviderCapabilityExecutor {
  return async (context, input) => {
    const normalized = normalizeVisionUnderstandingInput(input);
    const provider = createChatClient(context);
    return describeImagesWithProvider(provider, normalized);
  };
}

export async function describeImagesWithProvider(
  provider: ProviderClient,
  input: VisionUnderstandingInput
): Promise<VisionUnderstandingOutput> {
  const normalized = normalizeVisionUnderstandingInput(input);
  const descriptions: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let hasUsage = false;

  for (const image of normalized.images) {
    const result = await provider.generateChat({
      messages: [{ content: [image], role: "user" }],
      system: normalized.instruction ?? IMAGE_VISION_SYSTEM_PROMPT,
    });
    const description = result.content.trim();

    if (!description) {
      throw new AtlasApiError(
        "Image parsing returned an empty description.",
        502
      );
    }
    descriptions.push(description);
    if (result.usage) {
      hasUsage = true;
      inputTokens += result.usage.inputTokens;
      outputTokens += result.usage.outputTokens;
      totalTokens += result.usage.totalTokens;
    }
  }

  return {
    descriptions,
    ...(hasUsage ? { usage: { inputTokens, outputTokens, totalTokens } } : {}),
  };
}

export function normalizeVisionUnderstandingInput(
  input: unknown
): VisionUnderstandingInput {
  if (!(input && typeof input === "object" && !Array.isArray(input))) {
    throw invalidVisionInput("Image parsing input must be an object.");
  }

  const record = input as Record<string, unknown>;
  if (!Array.isArray(record.images) || record.images.length === 0) {
    throw invalidVisionInput(
      "Image parsing requires at least one image input."
    );
  }

  const images = record.images.map((image, index) =>
    normalizeVisionImage(image, index)
  );
  const instruction = normalizeInstruction(record.instruction);

  return {
    images,
    ...(instruction ? { instruction } : {}),
  };
}

function normalizeVisionImage(value: unknown, index: number): VisionImage {
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    throw invalidVisionInput(
      `Image parsing input images[${index}] is invalid.`
    );
  }

  const image = value as Record<string, unknown>;
  if (image.type !== "image") {
    throw invalidVisionInput(
      `Image parsing input images[${index}] must have type "image".`
    );
  }

  const mediaType = readRequiredString(
    image.mediaType,
    `Image parsing input images[${index}].mediaType is required.`
  );
  const data = readRequiredString(
    image.data,
    `Image parsing input images[${index}].data is required.`
  );
  const description = readOptionalString(image.description);

  return {
    data,
    mediaType,
    type: "image",
    ...(description ? { description } : {}),
  };
}

function normalizeInstruction(value: unknown): string | undefined {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string") {
    throw invalidVisionInput(
      "Image parsing input instruction must be a string."
    );
  }
  return value.trim() || undefined;
}

function readRequiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalidVisionInput(message);
  }
  return value.trim();
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function invalidVisionInput(message: string): AtlasApiError {
  return new AtlasApiError(message, 400);
}

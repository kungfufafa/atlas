import {
  MAX_DOCUMENT_BYTES,
  MAX_IMAGE_BYTES,
} from "@atlas/core/message-content-limits";
import { manipulateAsync, SaveFormat } from "expo-image-manipulator";
import {
  base64ByteLength,
  COMPRESS_IMAGE_OVER_BYTES,
  MAX_IMAGE_DIMENSION,
  scaleImageDimensions,
} from "@/lib/compress-image-size";

export {
  base64ByteLength,
  COMPRESS_IMAGE_OVER_BYTES,
  scaleImageDimensions,
} from "@/lib/compress-image-size";

export async function compressImageAttachment(input: {
  data: string;
  height?: number;
  mediaType: string;
  uri: string;
  width?: number;
}): Promise<{ data: string; mediaType: string }> {
  const currentSize = base64ByteLength(input.data);
  if (input.mediaType === "image/gif") {
    if (currentSize > MAX_IMAGE_BYTES) {
      throw new Error("GIF images must be at most 5 MB.");
    }
    return { data: input.data, mediaType: input.mediaType };
  }

  if (currentSize <= COMPRESS_IMAGE_OVER_BYTES) {
    return { data: input.data, mediaType: input.mediaType };
  }

  const width = input.width ?? MAX_IMAGE_DIMENSION;
  const height = input.height ?? MAX_IMAGE_DIMENSION;
  const size = scaleImageDimensions(width, height, MAX_IMAGE_DIMENSION);
  const actions =
    size.width !== width || size.height !== height
      ? [{ resize: { height: size.height, width: size.width } }]
      : [];

  let lastFit: { data: string; mediaType: string } | null = null;

  for (const compress of [0.85, 0.7, 0.55, 0.4] as const) {
    const result = await manipulateAsync(input.uri, actions, {
      base64: true,
      compress,
      format: SaveFormat.JPEG,
    });
    if (!result.base64) {
      continue;
    }

    const nextSize = base64ByteLength(result.base64);
    const next = { data: result.base64, mediaType: "image/jpeg" };
    if (nextSize <= COMPRESS_IMAGE_OVER_BYTES) {
      return next;
    }
    if (nextSize <= MAX_IMAGE_BYTES) {
      lastFit = next;
    }
  }

  if (lastFit) {
    return lastFit;
  }

  if (currentSize > MAX_IMAGE_BYTES) {
    throw new Error("Could not compress this image below 5 MB.");
  }

  return { data: input.data, mediaType: input.mediaType };
}

export function assertDocumentSize(data: string): void {
  if (base64ByteLength(data) > MAX_DOCUMENT_BYTES) {
    throw new Error("Files must be at most 5 MB.");
  }
}

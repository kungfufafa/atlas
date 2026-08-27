import {
  AtlasApiError,
  decodeBase64AttachmentData,
  type ImageAttachment,
  MAX_GENERATED_IMAGE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  normalizeImageMediaType,
  validateImageAttachments,
} from "@atlas/core";
import sharp from "sharp";

const SHARP_FORMAT_BY_MEDIA_TYPE: Readonly<Record<string, string>> = {
  "image/gif": "gif",
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
};

export interface DecodedImageDimensions {
  height: number;
  width: number;
}

/**
 * Fully decodes untrusted image attachments one at a time. The core validator
 * rejects malformed containers cheaply; Sharp catches corrupt compressed pixel
 * data without multiplying peak memory across the attachment batch.
 */
export async function validateDecodedImageAttachments(
  images: ImageAttachment[]
): Promise<void> {
  validateImageAttachments(images);

  for (const image of images) {
    await validateDecodedImageAttachment(image);
  }
}

async function validateDecodedImageAttachment(
  image: ImageAttachment
): Promise<void> {
  const mediaType = normalizeImageMediaType(image.mediaType);
  const bytes = Buffer.from(
    decodeBase64AttachmentData(image.data, "image", MAX_IMAGE_BYTES)
  );

  await decodeStillImage(bytes, mediaType, 400);
}

export async function validateGeneratedImageOutput(
  data: Uint8Array,
  mediaTypeInput: string
): Promise<DecodedImageDimensions> {
  if (data.byteLength === 0) {
    throw new AtlasApiError("Generated image data must not be empty.", 502);
  }
  if (data.byteLength > MAX_GENERATED_IMAGE_BYTES) {
    throw new AtlasApiError(
      `Generated image exceeds the ${MAX_GENERATED_IMAGE_BYTES / (1024 * 1024)} MB size limit.`,
      502
    );
  }

  const mediaType = normalizeImageMediaType(mediaTypeInput);
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return decodeStillImage(bytes, mediaType, 502);
}

async function decodeStillImage(
  bytes: Buffer,
  mediaType: string,
  errorStatus: 400 | 502
): Promise<DecodedImageDimensions> {
  const expectedFormat = SHARP_FORMAT_BY_MEDIA_TYPE[mediaType];
  if (!expectedFormat) {
    throw new AtlasApiError(
      `Unsupported image type: ${mediaType || "unknown"}.`,
      errorStatus
    );
  }

  try {
    const decoder = sharp(bytes, {
      failOn: "warning",
      limitInputPixels: MAX_IMAGE_PIXELS,
      page: 0,
      pages: 1,
      sequentialRead: true,
    });
    const metadata = await decoder.metadata();

    if (metadata.format !== expectedFormat) {
      throw new AtlasApiError(
        `Image bytes do not match declared type "${mediaType}".`,
        errorStatus
      );
    }

    const hasMultipleFrames =
      (metadata.pages ?? 1) > 1 ||
      (metadata.pageHeight !== undefined &&
        metadata.pageHeight !== metadata.height) ||
      hasContainerAnimation(bytes, mediaType);
    if (hasMultipleFrames) {
      throw new AtlasApiError(
        "Animated images are not supported.",
        errorStatus
      );
    }

    const decodedPixels = metadata.width * metadata.height;
    if (
      !Number.isSafeInteger(decodedPixels) ||
      decodedPixels < 1 ||
      decodedPixels > MAX_IMAGE_PIXELS
    ) {
      throw new AtlasApiError(
        `Image dimensions are too large. Maximum: ${MAX_IMAGE_PIXELS.toLocaleString("en-US")} pixels.`,
        errorStatus
      );
    }

    await decoder.stats();
    return { height: metadata.height, width: metadata.width };
  } catch (error) {
    if (error instanceof AtlasApiError) {
      throw error;
    }
    throw new AtlasApiError(
      "Image data could not be decoded safely.",
      errorStatus
    );
  }
}

function hasContainerAnimation(bytes: Buffer, mediaType: string): boolean {
  if (mediaType === "image/png") {
    return pngContainsAnimationControl(bytes);
  }
  if (mediaType === "image/webp") {
    const featureFlags = bytes[20] ?? 0;
    return (
      bytes.subarray(12, 16).toString("ascii") === "VP8X" &&
      Math.floor(featureFlags / 2) % 2 === 1
    );
  }
  return false;
}

function pngContainsAnimationControl(bytes: Buffer): boolean {
  let offset = 8;
  while (offset + 12 <= bytes.byteLength) {
    const chunkLength = bytes.readUInt32BE(offset);
    const chunkType = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    if (chunkType === "acTL") {
      return true;
    }
    if (chunkType === "IEND") {
      return false;
    }
    offset += chunkLength + 12;
  }
  return false;
}

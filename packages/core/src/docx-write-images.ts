const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 24 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 40_000_000;
const MAX_IMAGE_COUNT = 32;
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

export interface DocxImageAsset {
  bytes: Uint8Array;
  filename: string;
}

export interface MarkdownDocxOptions {
  resolveImage?: (reference: string) => Promise<DocxImageAsset>;
}

export interface DocxImage {
  data: Uint8Array;
  transformation: { height: number; width: number };
  type: "png" | "jpg" | "gif";
}

function jpegSize(bytes: Uint8Array): { height: number; width: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      break;
    }
    while (bytes[offset] === 0xff) {
      offset += 1;
    }
    const marker = bytes[offset++]!;
    if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) {
      break;
    }
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) {
      break;
    }
    if (JPEG_SOF_MARKERS.has(marker) && length >= 8) {
      return {
        height: view.getUint16(offset + 3),
        width: view.getUint16(offset + 5),
      };
    }
    offset += length;
  }
  throw new Error("JPEG image dimensions are missing or malformed.");
}

function imageMetadata(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = new TextDecoder("ascii").decode(bytes.subarray(0, 8));
  if (
    bytes.length >= 33 &&
    view.getUint32(0) === 0x89_50_4e_47 &&
    view.getUint32(4) === 0x0d_0a_1a_0a &&
    view.getUint32(8) === 13 &&
    view.getUint32(12) === 0x49_48_44_52
  ) {
    return {
      height: view.getUint32(20),
      type: "png" as const,
      width: view.getUint32(16),
    };
  }
  if (
    bytes.length >= 13 &&
    (header.startsWith("GIF87a") || header.startsWith("GIF89a"))
  ) {
    return {
      height: view.getUint16(8, true),
      type: "gif" as const,
      width: view.getUint16(6, true),
    };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return { ...jpegSize(bytes), type: "jpg" as const };
  }
  throw new Error("Markdown images must contain PNG, JPEG, or GIF image data.");
}

export async function resolveDocxImages(
  references: ReadonlySet<string>,
  options: MarkdownDocxOptions
): Promise<Map<string, DocxImage>> {
  const images = new Map<string, DocxImage>();
  if (references.size > MAX_IMAGE_COUNT) {
    throw new Error(
      `Word documents support at most ${MAX_IMAGE_COUNT} distinct Markdown images.`
    );
  }
  let totalBytes = 0;
  for (const reference of references) {
    if (
      !reference ||
      /^[a-z][a-z\d+.-]*:/i.test(reference) ||
      reference.startsWith("//")
    ) {
      throw new Error(
        "Markdown images require workspace paths or stored attachment references; remote URLs are unsupported."
      );
    }
    if (!options.resolveImage) {
      throw new Error(
        "Embedding Markdown images requires a workspace image resolver."
      );
    }
    const asset = await options.resolveImage(reference);
    totalBytes += asset.bytes.byteLength;
    if (
      !asset.bytes.byteLength ||
      asset.bytes.byteLength > MAX_IMAGE_BYTES ||
      totalBytes > MAX_TOTAL_IMAGE_BYTES
    ) {
      throw new Error("Markdown images exceed the supported byte limit.");
    }
    const { width, height, type } = imageMetadata(asset.bytes);
    if (
      !(width && height) ||
      width > 20_000 ||
      height > 20_000 ||
      width * height > MAX_IMAGE_PIXELS
    ) {
      throw new Error("Markdown image dimensions exceed the supported limit.");
    }
    const scale = Math.min(1, 600 / width, 750 / height);
    images.set(reference, {
      data: asset.bytes,
      transformation: {
        height: Math.max(1, Math.round(height * scale)),
        width: Math.max(1, Math.round(width * scale)),
      },
      type,
    });
  }
  return images;
}

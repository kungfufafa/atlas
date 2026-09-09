import {
  prepareChannelImage,
  type SaveInboundDocument,
} from "@atlas/core/attachments/inbound-document";
import type { ImageAttachment, SendMessageInput } from "@atlas/core/contract";
import {
  MAX_IMAGE_BYTES,
  normalizeImageMediaType,
} from "@atlas/core/message-content";
import type { Context } from "grammy";
import {
  downloadTelegramFile,
  isTelegramImageDocument,
  OversizedTelegramFileError,
  type TelegramDownloadOptions,
} from "./attachments";

export const OVERSIZED_IMAGE_REPLY =
  "Image is too large. Maximum size is 5 MB.";

export function hasTelegramImage(ctx: Context): boolean {
  return Boolean(
    ctx.message?.sticker ||
      ctx.message?.photo?.length ||
      isTelegramImageDocument(ctx)
  );
}

export async function buildTelegramImageInput(
  ctx: Context,
  options: TelegramDownloadOptions & {
    saveInboundDocument?: SaveInboundDocument;
  } = {}
): Promise<
  | { kind: "input"; input: SendMessageInput }
  | { kind: "reject"; message: string }
  | null
> {
  const sticker = ctx.message?.sticker;
  if (sticker && (sticker.is_animated || sticker.is_video)) {
    return {
      kind: "reject",
      message:
        "Animated and video stickers are not supported. Send a static sticker, image, or video file instead.",
    };
  }
  const photos = ctx.message?.photo;
  const photo = photos?.[photos.length - 1];
  const document = isTelegramImageDocument(ctx)
    ? ctx.message?.document
    : undefined;
  const source = sticker ?? photo ?? document;
  if (!source) {
    return null;
  }
  if (source.file_size !== undefined && source.file_size > MAX_IMAGE_BYTES) {
    return { kind: "reject", message: OVERSIZED_IMAGE_REPLY };
  }

  try {
    const downloaded = await downloadTelegramFile(
      ctx,
      source.file_id,
      MAX_IMAGE_BYTES,
      options
    );
    const mediaType = sticker
      ? "image/webp"
      : inferMediaType(
          document?.file_name ?? downloaded.filePath,
          document?.mime_type ?? downloaded.contentType
        );
    const filename =
      document?.file_name?.trim() ||
      (sticker ? "sticker.webp" : `photo.${mediaType.split("/")[1]}`);
    const caption = sticker
      ? `Describe this sticker.${sticker.emoji ? ` Telegram emoji label: ${sticker.emoji}` : ""}`
      : (ctx.message?.caption?.trim() ?? "");

    return await prepareChannelImage({
      bytes: Buffer.from(downloaded.bytes),
      caption,
      channel: "Telegram",
      filename,
      mediaType,
      saveInboundDocument: options.saveInboundDocument,
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof OversizedTelegramFileError) {
      return { kind: "reject", message: OVERSIZED_IMAGE_REPLY };
    }
    throw error;
  }
}

export async function downloadTelegramImage(
  ctx: Context,
  fileId: string,
  options: TelegramDownloadOptions = {}
): Promise<ImageAttachment> {
  try {
    const downloaded = await downloadTelegramFile(
      ctx,
      fileId,
      MAX_IMAGE_BYTES,
      options
    );
    return {
      data: Buffer.from(downloaded.bytes).toString("base64"),
      mediaType: inferMediaType(downloaded.filePath, downloaded.contentType),
    };
  } catch (error) {
    if (error instanceof OversizedTelegramFileError) {
      throw new Error(OVERSIZED_IMAGE_REPLY);
    }
    throw error;
  }
}

function inferMediaType(filePath: string, headerType: string | null): string {
  const normalizedHeaderType = normalizeImageMediaType(headerType ?? "");
  if (normalizedHeaderType.startsWith("image/")) {
    return normalizedHeaderType;
  }

  const extension = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  switch (extension) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return "image/jpeg";
  }
}

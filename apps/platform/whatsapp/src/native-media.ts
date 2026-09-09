import { throwIfSignalAborted } from "@atlas/core/download-deadline";

const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;
const MEDIA_TIMEOUT_MS = 30_000;

export interface NativeMediaOptions {
  maxOutputBytes?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Decode only an explicitly selected container from stdin. No local files,
 * URLs, shell, or inherited credentials are available to the media input. */
export async function transformWhatsAppMedia(
  bytes: Uint8Array,
  format: string,
  outputArgs: string[],
  options: NativeMediaOptions = {}
): Promise<Buffer> {
  if (options.signal) {
    throwIfSignalAborted(options.signal);
  }
  if (!bytes.byteLength || bytes.byteLength > MAX_OUTPUT_BYTES) {
    throw new Error("WhatsApp media must contain between 1 byte and 25 MB.");
  }
  const executable = Bun.which("ffmpeg");
  if (!executable) {
    throw new Error("WhatsApp media processing requires ffmpeg.");
  }
  const child = Bun.spawn(
    [
      executable,
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-max_alloc",
      "67108864",
      "-threads",
      "1",
      "-protocol_whitelist",
      "pipe",
      "-f",
      format,
      "-i",
      "pipe:0",
      ...outputArgs,
      "pipe:1",
    ],
    {
      env: { LANG: "C", PATH: process.env.PATH ?? "" },
      stderr: "pipe",
      stdin: bytes,
      stdout: "pipe",
    }
  );
  let failure: Error | undefined;
  const stop = (error: Error) => {
    failure ??= error;
    child.kill("SIGKILL");
  };
  const abort = () => stop(new Error("WhatsApp media processing was aborted."));
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => stop(new Error("WhatsApp media processing timed out.")),
    options.timeoutMs ?? MEDIA_TIMEOUT_MS
  );
  try {
    const output = readBounded(
      child.stdout,
      options.maxOutputBytes ?? MAX_OUTPUT_BYTES,
      stop
    );
    // Consume bounded diagnostics without returning decoder details to chat.
    const diagnostics = readBounded(child.stderr, 64 * 1024, stop);
    const [result, , exitCode] = await Promise.all([
      output,
      diagnostics,
      child.exited,
    ]);
    if (options.signal) {
      throwIfSignalAborted(options.signal);
    }
    if (failure) {
      throw failure;
    }
    if (exitCode !== 0 || !result.byteLength) {
      throw new Error("WhatsApp media could not be decoded.");
    }
    return result;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  stop: (error: Error) => void
): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > maxBytes) {
      stop(new Error("WhatsApp processed media is too large."));
      continue;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function audioFormat(mimeType: string): string {
  switch (mimeType.split(";")[0]?.trim().toLowerCase()) {
    case "audio/ogg":
    case "audio/opus":
      return "ogg";
    case "audio/mp4":
    case "audio/x-m4a":
      return "mov";
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    case "audio/aac":
      return "aac";
    case "audio/flac":
      return "flac";
    default:
      throw new Error("Unsupported WhatsApp audio container.");
  }
}

export function encodeWhatsAppAudio(
  bytes: Uint8Array,
  mimeType: string,
  voiceNote: boolean,
  options?: NativeMediaOptions
): Promise<Buffer> {
  return transformWhatsAppMedia(
    bytes,
    audioFormat(mimeType),
    [
      "-map",
      "0:a:0",
      "-vn",
      "-ac",
      voiceNote ? "1" : "2",
      "-ar",
      "48000",
      "-c:a",
      voiceNote ? "libopus" : "libmp3lame",
      "-b:a",
      voiceNote ? "48k" : "128k",
      "-f",
      voiceNote ? "ogg" : "mp3",
    ],
    options
  );
}

export function encodeWhatsAppVideo(
  bytes: Uint8Array,
  options?: NativeMediaOptions
): Promise<Buffer> {
  return transformWhatsAppMedia(
    bytes,
    "mov",
    [
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-vf",
      "scale=trunc(min(1280\\,iw)/2)*2:-2,fps=24",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-movflags",
      "frag_keyframe+empty_moov",
      "-f",
      "mp4",
    ],
    options
  );
}

/** Providing this thumbnail prevents Baileys from launching its own shell
 * ffmpeg process with inherited credentials and no cancellation boundary. */
export async function prepareWhatsAppVideo(
  bytes: Uint8Array,
  options?: NativeMediaOptions
): Promise<{ jpegThumbnail: string; video: Buffer }> {
  const video = await encodeWhatsAppVideo(bytes, options);
  const jpegThumbnail = await transformWhatsAppMedia(
    video,
    "mov",
    [
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-vf",
      "scale=min(160\\,iw):-2",
      "-c:v",
      "mjpeg",
      "-threads",
      "1",
      "-f",
      "image2pipe",
    ],
    { ...options, maxOutputBytes: 64 * 1024 }
  );
  return { jpegThumbnail: jpegThumbnail.toString("base64"), video };
}

export async function decodeWhatsAppVisual(
  bytes: Uint8Array,
  kind: "sticker" | "video",
  options?: NativeMediaOptions
): Promise<Buffer> {
  return transformWhatsAppMedia(
    kind === "sticker" ? firstWebPFrame(bytes) : bytes,
    kind === "sticker" ? "webp_pipe" : "mov",
    [
      "-map",
      "0:v:0",
      "-frames:v",
      "1",
      "-vf",
      "scale=min(1280\\,iw):-2",
      "-c:v",
      "png",
      "-threads",
      "1",
      "-f",
      "image2pipe",
    ],
    { ...options, maxOutputBytes: 5 * 1024 * 1024 }
  );
}

/** ANMF contains a 16-byte frame header followed by ordinary image chunks.
 * Repackage that first frame for ffmpeg builds without animated WebP decoding.
 * https://developers.google.com/speed/webp/docs/riff_container#animation */
function firstWebPFrame(input: Uint8Array): Uint8Array {
  const bytes = Buffer.from(input);
  if (
    bytes.length < 12 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  ) {
    throw new Error("Invalid WebP container.");
  }
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const length = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + length;
    if (end > bytes.length) {
      throw new Error("Truncated WebP chunk.");
    }
    if (bytes.toString("ascii", offset, offset + 4) === "ANMF") {
      if (length < 24) {
        throw new Error("Invalid animated WebP frame.");
      }
      const frame = bytes.subarray(offset + 8, end);
      const payload = frame.subarray(16);
      const extended = Buffer.alloc(18);
      extended.write("VP8X", 0);
      extended.writeUInt32LE(10, 4);
      extended[8] = payload.toString("ascii", 0, 4) === "ALPH" ? 0x10 : 0;
      frame.copy(extended, 12, 6, 12);
      const header = Buffer.alloc(12);
      header.write("RIFF", 0);
      header.writeUInt32LE(4 + extended.length + payload.length, 4);
      header.write("WEBP", 8);
      return Buffer.concat([header, extended, payload]);
    }
    offset = end + (length % 2);
  }
  return bytes;
}

export function extractWhatsAppVideoAudio(
  bytes: Uint8Array,
  options?: NativeMediaOptions
): Promise<Buffer> {
  return transformWhatsAppMedia(
    bytes,
    "mov",
    [
      "-map",
      "0:a:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      "-f",
      "wav",
    ],
    options
  );
}

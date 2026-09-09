import { MessageFlags, type REST, Routes } from "discord.js";
import { DISCORD_ARTIFACT_ATTACHMENT_MAX_BYTES } from "./send-artifact-attachment";

const SAMPLE_RATE = 48_000;
const MAX_VOICE_SECONDS = 120;
const PCM_LIMIT = SAMPLE_RATE * 2 * MAX_VOICE_SECONDS;

async function readLimited(
  stream: ReadableStream<Uint8Array>,
  limit: number
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > limit) {
        throw new Error("Discord audio exceeds the supported duration or size");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    reader.releaseLock();
  }
}

async function convertAudio(
  bytes: Uint8Array,
  args: string[],
  limit: number,
  signal?: AbortSignal
): Promise<Buffer> {
  signal?.throwIfAborted();
  const child = Bun.spawn(
    ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", ...args],
    {
      env: { LANG: "C", PATH: process.env.PATH ?? "" },
      stderr: "pipe",
      stdin: bytes,
      stdout: "pipe",
    }
  );
  const abort = () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  };
  const timeout = setTimeout(abort, 30_000);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    const [output, , exitCode] = await Promise.all([
      readLimited(child.stdout, limit),
      readLimited(child.stderr, 65_536),
      child.exited,
    ]);
    signal?.throwIfAborted();
    if (exitCode !== 0 || output.length === 0) {
      throw new Error("Discord audio conversion failed");
    }
    return output;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    abort();
    await child.exited;
  }
}

export function describeDiscordPcm(pcm: Buffer): {
  durationSeconds: number;
  waveform: string;
} {
  if (pcm.length === 0 || pcm.length % 2 !== 0 || pcm.length > PCM_LIMIT) {
    throw new Error("Discord voice PCM is invalid or exceeds two minutes");
  }
  const samples = pcm.length / 2;
  const durationSeconds = samples / SAMPLE_RATE;
  const pointCount = Math.min(
    256,
    Math.max(1, Math.ceil(durationSeconds * 10))
  );
  const waveform = Buffer.alloc(pointCount);
  for (let point = 0; point < pointCount; point += 1) {
    let peak = 0;
    const start = Math.floor((point * samples) / pointCount);
    const end = Math.floor(((point + 1) * samples) / pointCount);
    for (let sample = start; sample < end; sample += 1) {
      peak = Math.max(peak, Math.abs(pcm.readInt16LE(sample * 2)));
    }
    waveform[point] = Math.round((peak / 32_768) * 255);
  }
  return { durationSeconds, waveform: waveform.toString("base64") };
}

/** Normalize provider WAV rates/channels before the in-process Discord Opus encoder. */
export async function prepareDiscordPlaybackPcm(
  bytes: Uint8Array,
  signal?: AbortSignal
): Promise<Buffer> {
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) {
    throw new Error("Discord speech audio exceeds the supported size");
  }
  return await convertAudio(
    bytes,
    [
      "-protocol_whitelist",
      "pipe",
      "-f",
      "wav",
      "-i",
      "pipe:0",
      "-vn",
      "-t",
      "91",
      "-ar",
      String(SAMPLE_RATE),
      "-ac",
      "2",
      "-f",
      "s16le",
      "pipe:1",
    ],
    SAMPLE_RATE * 4 * 90,
    signal
  );
}

export async function prepareDiscordVoiceMessage(
  bytes: Uint8Array,
  signal?: AbortSignal
): Promise<{
  bytes: Buffer;
  durationSeconds: number;
  waveform: string;
}> {
  if (
    bytes.length === 0 ||
    bytes.length > DISCORD_ARTIFACT_ATTACHMENT_MAX_BYTES
  ) {
    throw new Error("Discord audio attachment size is invalid");
  }
  const pcm = await convertAudio(
    bytes,
    [
      "-protocol_whitelist",
      "pipe",
      "-i",
      "pipe:0",
      "-vn",
      "-t",
      String(MAX_VOICE_SECONDS + 1),
      "-ar",
      String(SAMPLE_RATE),
      "-ac",
      "1",
      "-f",
      "s16le",
      "pipe:1",
    ],
    PCM_LIMIT,
    signal
  );
  const description = describeDiscordPcm(pcm);
  const opus = await convertAudio(
    pcm,
    [
      "-protocol_whitelist",
      "pipe",
      "-f",
      "s16le",
      "-ar",
      String(SAMPLE_RATE),
      "-ac",
      "1",
      "-i",
      "pipe:0",
      "-c:a",
      "libopus",
      "-b:a",
      "32k",
      "-f",
      "ogg",
      "pipe:1",
    ],
    DISCORD_ARTIFACT_ATTACHMENT_MAX_BYTES,
    signal
  );
  return { bytes: opus, ...description };
}

/** discord.js 14.26 AttachmentBuilder omits voice metadata; use the official REST body. */
export async function sendDiscordVoiceMessage(input: {
  channelId: string;
  rest: Pick<REST, "post">;
  voice: Awaited<ReturnType<typeof prepareDiscordVoiceMessage>>;
}): Promise<{ id: string }> {
  const response: unknown = await input.rest.post(
    Routes.channelMessages(input.channelId),
    {
      body: {
        allowed_mentions: { parse: [] },
        attachments: [
          {
            duration_secs: input.voice.durationSeconds,
            filename: "voice-message.ogg",
            id: "0",
            waveform: input.voice.waveform,
          },
        ],
        flags: MessageFlags.IsVoiceMessage,
      },
      files: [
        {
          contentType: "audio/ogg",
          data: input.voice.bytes,
          name: "voice-message.ogg",
        },
      ],
    }
  );
  if (
    typeof response !== "object" ||
    response === null ||
    !("id" in response) ||
    typeof response.id !== "string"
  ) {
    throw new Error("Discord did not return a voice message receipt");
  }
  return { id: response.id };
}

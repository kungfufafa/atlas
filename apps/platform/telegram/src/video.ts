import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SendMessageInput } from "@atlas/core/contract";
import { throwIfSignalAborted } from "@atlas/core/download-deadline";
import type { Context } from "grammy";
import { downloadTelegramFile } from "./attachments";

const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const FFMPEG_TIMEOUT_MS = 15_000;

export function hasTelegramVideo(ctx: Context): boolean {
  return Boolean(ctx.message?.video || ctx.message?.video_note);
}

/** Caller must authorize files before downloading, decoding or allocating temporary files. */
export async function buildTelegramVideoInput(
  ctx: Context,
  signal: AbortSignal
): Promise<SendMessageInput> {
  const video = ctx.message?.video ?? ctx.message?.video_note;
  if (!video) {
    throw new Error("Telegram video is missing.");
  }
  if (video.duration > 60) {
    throw new Error("Send a video of at most 60 seconds for frame analysis.");
  }
  const downloaded = await downloadTelegramFile(
    ctx,
    video.file_id,
    MAX_VIDEO_BYTES,
    { signal }
  );
  const frames = await extractTelegramVideoFrames(
    new Uint8Array(downloaded.bytes),
    signal
  );
  return {
    images: frames.map((bytes) => ({
      data: bytes.toString("base64"),
      mediaType: "image/png",
    })),
    message: [
      "Analyze these sampled video frames from the first 60 seconds. Audio was not transcribed; frames do not represent every moment.",
      ctx.message?.caption?.trim(),
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
}

export async function extractTelegramVideoFrames(
  bytes: Uint8Array,
  signal: AbortSignal
): Promise<Buffer[]> {
  throwIfSignalAborted(signal);
  if (
    bytes.length > MAX_VIDEO_BYTES ||
    bytes.length < 12 ||
    Buffer.from(bytes.subarray(4, 8)).toString() !== "ftyp"
  ) {
    throw new Error(
      "Video frame analysis requires an MP4 file no larger than 25 MB."
    );
  }
  const directory = await mkdtemp(join(tmpdir(), "atlas-telegram-video-"));
  try {
    const source = join(directory, "source.mp4");
    await writeFile(source, bytes, { mode: 0o600 });
    throwIfSignalAborted(signal);
    await runFfmpeg(
      [
        "-nostdin",
        "-max_alloc",
        "67108864",
        "-max_pixels",
        "16777216",
        "-hide_banner",
        "-loglevel",
        "error",
        "-threads",
        "1",
        "-protocol_whitelist",
        "file,pipe",
        "-f",
        "mov",
        "-enable_drefs",
        "0",
        "-i",
        source,
        "-t",
        "60",
        "-an",
        "-sn",
        "-dn",
        "-vf",
        "select=isnan(prev_selected_t)+gte(t-prev_selected_t\\,15),scale=640:640:force_original_aspect_ratio=decrease",
        "-fps_mode",
        "vfr",
        "-frames:v",
        "4",
        "-threads",
        "1",
        join(directory, "frame-%02d.png"),
      ],
      signal
    );
    throwIfSignalAborted(signal);
    const names = (await readdir(directory))
      .filter((name) => /^frame-0[1-4]\.png$/.test(name))
      .sort();
    if (names.length === 0) {
      throw new Error("No video frames could be decoded.");
    }
    const frames: Buffer[] = [];
    for (const name of names) {
      const frame = await readFile(join(directory, name));
      if (
        frame.length > MAX_FRAME_BYTES ||
        !frame
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ) {
        throw new Error(
          "Video decoding returned an invalid or oversized frame."
        );
      }
      frames.push(frame);
    }
    return frames;
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function runFfmpeg(args: string[], signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, {
      env: { PATH: process.env.PATH },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let failed = false;
    const finish = (error?: Error) => {
      if (failed) {
        return;
      }
      failed = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const abort = () => {
      child.kill("SIGKILL");
    };
    const timer = setTimeout(abort, FFMPEG_TIMEOUT_MS);
    signal.addEventListener("abort", abort, { once: true });
    // Drain decoder diagnostics without retaining attacker-controlled output.
    child.stderr.resume();
    child.once("error", () =>
      finish(
        new Error("Video decoding requires an installed ffmpeg executable.")
      )
    );
    child.once("close", (code) => {
      if (signal.aborted) {
        finish(new DOMException("Aborted", "AbortError"));
      } else {
        finish(
          code === 0
            ? undefined
            : new Error(
                "Video decoding failed or exceeded its 15 second limit."
              )
        );
      }
    });
    if (signal.aborted) {
      abort();
    }
  });
}

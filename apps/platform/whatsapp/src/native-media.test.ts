import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWAMessageMedia, type WAMessage } from "@whiskeysockets/baileys";
import { buildWhatsAppMediaInput } from "./attachments";
import {
  executeWhatsAppNativeAction,
  WhatsAppMessageRegistry,
} from "./native-actions";
import {
  decodeWhatsAppVisual,
  encodeWhatsAppAudio,
  encodeWhatsAppVideo,
  transformWhatsAppMedia,
} from "./native-media";
import { sendWhatsAppArtifact } from "./send-artifact-media";

let wav: Buffer;
let video: Buffer;
let sticker: Buffer;

async function ffmpeg(args: string[]): Promise<Buffer> {
  const child = Bun.spawn(
    ["ffmpeg", "-hide_banner", "-loglevel", "error", ...args, "pipe:1"],
    { stderr: "pipe", stdout: "pipe" }
  );
  const [output, errors, code] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) {
    throw new Error(errors);
  }
  return Buffer.from(output);
}

async function inspect(
  bytes: Buffer
): Promise<{ streams: Array<{ codec_name: string; codec_type: string }> }> {
  const child = Bun.spawn(
    ["ffprobe", "-v", "error", "-show_streams", "-of", "json", "pipe:0"],
    { stderr: "pipe", stdin: bytes, stdout: "pipe" }
  );
  const [json, code] = await Promise.all([
    new Response(child.stdout).text(),
    child.exited,
  ]);
  expect(code).toBe(0);
  return JSON.parse(json);
}

beforeAll(async () => {
  wav = await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=0.2",
    "-f",
    "wav",
  ]);
  video = await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=64x64:d=0.3",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=0.3",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    "-movflags",
    "frag_keyframe+empty_moov",
    "-f",
    "mp4",
  ]);
  sticker = Buffer.from(
    "UklGRkgAAABXRUJQVlA4IDwAAAAQAwCdASogACAAPm00lkekIyIhKAgAgA2JZQB2AACAoKAA/vkd2//+QH/+QH/+QH/8gP/+IXeyAwAAAAA=",
    "base64"
  );
});

describe("WhatsApp native media using actual local ffmpeg and ffprobe", () => {
  test.each(["audio", "video"] as const)(
    "ordinary %s delivery checks fresh authority after real codec preparation",
    async (kind) => {
      let checks = 0;
      let sends = 0;
      const result = await sendWhatsAppArtifact(
        {
          sendMessage: async () => {
            sends += 1;
          },
        } as never,
        "628101@s.whatsapp.net",
        {
          beforeSend: async () => {
            checks += 1;
            throw new Error("Current membership revoked");
          },
          bytes: kind === "audio" ? wav : video,
          filename: kind === "audio" ? "tone.wav" : "video.mp4",
          mimeType: kind === "audio" ? "audio/wav" : "video/mp4",
        }
      );
      expect(checks).toBe(1);
      expect(result.ok).toBe(false);
      expect(sends).toBe(0);
    }
  );
  test.each(["artifact", "native"] as const)(
    "%s video: actual Baileys preparation uses the bounded thumbnail without launching its implicit shell decoder",
    async (flow) => {
      let content: Parameters<typeof prepareWAMessageMedia>[0] | undefined;
      const destination = "628101@s.whatsapp.net";
      const socket = {
        sendMessage: async (
          jid: string,
          body: Parameters<typeof prepareWAMessageMedia>[0]
        ) => {
          content = body;
          return { key: { fromMe: true, id: "sent-video", remoteJid: jid } };
        },
      };
      const media = {
        bytes: video,
        filename: "clip.mp4",
        mimeType: "video/mp4",
      };
      if (flow === "artifact") {
        expect(
          (await sendWhatsAppArtifact(socket as never, destination, media)).ok
        ).toBe(true);
      } else {
        const binding = {
          channelUserAliases: [],
          channelUserId: destination,
          destination,
          orgId: "org",
          profileId: "profile",
          sessionId: "session",
          userId: "user",
        };
        const receipt = await executeWhatsAppNativeAction({
          binding,
          readMedia: async () => media,
          registry: new WhatsAppMessageRegistry(),
          request: {
            action: { kind: "send_media", mode: "video", path: "clip.mp4" },
            channel: "whatsapp",
            channelChatId: destination,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            id: "video",
            orgId: binding.orgId,
            profileId: binding.profileId,
            sessionId: binding.sessionId,
          },
          socket: socket as never,
        });
        expect(receipt.status).toBe("accepted");
      }
      const directory = await mkdtemp(
        join(tmpdir(), "atlas-wa-thumbnail-boundary-")
      );
      const executable = join(directory, "ffmpeg");
      const marker = join(directory, "implicit-decoder-called");
      await writeFile(
        executable,
        '#!/bin/sh\nprintf invoked > "$ATLAS_WA_THUMBNAIL_PROBE"\nexit 1\n'
      );
      await chmod(executable, 0o700);
      const previousPath = process.env.PATH;
      const previousProbe = process.env.ATLAS_WA_THUMBNAIL_PROBE;
      process.env.PATH = directory;
      process.env.ATLAS_WA_THUMBNAIL_PROBE = marker;
      try {
        let uploads = 0;
        const prepared = await prepareWAMessageMedia(content!, {
          upload: async () => {
            uploads += 1;
            return {
              directPath: "/controlled/video",
              mediaUrl: "https://controlled.invalid/video",
            };
          },
        });
        expect(uploads).toBe(1);
        expect(existsSync(marker)).toBe(false);
        expect(
          Buffer.from(prepared.videoMessage!.jpegThumbnail!).subarray(0, 2)
        ).toEqual(Buffer.from([0xff, 0xd8]));
      } finally {
        if (previousPath === undefined) {
          delete process.env.PATH;
        } else {
          process.env.PATH = previousPath;
        }
        if (previousProbe === undefined) {
          delete process.env.ATLAS_WA_THUMBNAIL_PROBE;
        } else {
          process.env.ATLAS_WA_THUMBNAIL_PROBE = previousProbe;
        }
        await rm(directory, { force: true, recursive: true });
      }
    }
  );
  test("animated WebP first frame is actually decoded without claiming animation understanding", async () => {
    const animated = Buffer.from(
      "UklGRuQAAABXRUJQVlA4WAoAAAACAAAAHwAAHwAAQU5JTQYAAAAAAAAAAABBTk1GWAAAAAAAAAAAAB8AAB8AAGQAAAJWUDggQAAAAFADAJ0BKiAAIAA+bTSWR6QjIiEoCACADYllAHYABMUOHaMAAP75Hdv//kB//kB//kB//ID//iF3shz/9P4AAABBTk1GWAAAAAAAAAAAAB8AAB8AAGQAAABWUDggQAAAADQDAJ0BKiAAIAA+bTSWR4KAgAAA2JZQDJAoB+AALWkGO1AA/vCbQ//ILlhdcjX/8gP+QH/ID/+QH/6b2anzgAA=",
      "base64"
    );
    const decoded = await decodeWhatsAppVisual(animated, "sticker");
    expect((await inspect(decoded)).streams[0]?.codec_name).toBe("png");
    await expect(
      decodeWhatsAppVisual(animated.subarray(0, animated.length - 5), "sticker")
    ).rejects.toThrow();
  });
  test("encodes ordinary audio as MP3 and voice notes as Opus, then uses native Baileys fields", async () => {
    const content: Array<Record<string, unknown>> = [];
    const socket = {
      sendMessage: async (_jid: string, body: Record<string, unknown>) => {
        content.push(body);
        return { key: { id: "ack" } };
      },
    };
    for (const voiceNote of [false, true]) {
      const result = await sendWhatsAppArtifact(
        socket as never,
        "628100@s.whatsapp.net",
        { bytes: wav, filename: "voice.wav", mimeType: "audio/wav", voiceNote }
      );
      expect(result.ok).toBe(true);
    }
    expect(
      (await inspect(content[0]!.audio as Buffer)).streams[0]!.codec_name
    ).toBe("mp3");
    expect(
      (await inspect(content[1]!.audio as Buffer)).streams[0]!.codec_name
    ).toBe("opus");
    expect(content[0]!.ptt).toBe(false);
    expect(content[1]!.ptt).toBe(true);
    expect(content[1]!.mimetype).toBe("audio/ogg; codecs=opus");
    expect(content.every((item) => !("document" in item))).toBe(true);
  });

  test("normalizes a real video to H264/AAC and delivers native video bytes", async () => {
    const encoded = await encodeWhatsAppVideo(video);
    const metadata = await inspect(encoded);
    expect(metadata.streams.map((item) => item.codec_name)).toEqual([
      "h264",
      "aac",
    ]);
    const sent: Array<Record<string, unknown>> = [];
    const result = await sendWhatsAppArtifact(
      {
        sendMessage: async (_jid: string, body: Record<string, unknown>) => {
          sent.push(body);
        },
      } as never,
      "628101@s.whatsapp.net",
      { bytes: video, filename: "clip.mp4", mimeType: "video/mp4" }
    );
    expect(result.ok).toBe(true);
    expect(
      (await inspect(sent[0]!.video as Buffer)).streams[0]!.codec_name
    ).toBe("h264");
  });

  test("inbound video supplies a decoded visual frame and extracted real audio to transcription", async () => {
    const transcribed: Buffer[] = [];
    const result = await buildWhatsAppMediaInput(
      {
        key: {},
        message: {
          videoMessage: {
            caption: "Review this clip",
            fileLength: video.length,
            mimetype: "video/mp4",
          },
        },
      } as WAMessage,
      async () => video,
      {
        transcribeVideoAudio: async (input) => {
          transcribed.push(Buffer.from(input.data, "base64"));
          return { text: "The test narration." };
        },
      }
    );
    expect(result?.kind).toBe("input");
    if (result?.kind !== "input") {
      throw new Error("Video was rejected");
    }
    expect((await inspect(transcribed[0]!)).streams[0]!.codec_name).toBe(
      "pcm_s16le"
    );
    expect(
      (await inspect(Buffer.from(result.input.images![0]!.data, "base64")))
        .streams[0]!.codec_name
    ).toBe("png");
    expect(result.input.message).toContain("The test narration.");
    expect(result.input.message).toContain("first frame");
  });

  test("inbound sticker becomes a decodable PNG instead of an unsupported placeholder", async () => {
    const result = await buildWhatsAppMediaInput(
      {
        key: {},
        message: {
          stickerMessage: {
            fileLength: sticker.length,
            mimetype: "image/webp",
          },
        },
      } as WAMessage,
      async () => sticker
    );
    expect(result?.kind).toBe("input");
    if (result?.kind !== "input") {
      throw new Error("Sticker rejected");
    }
    expect(
      (await inspect(Buffer.from(result.input.images![0]!.data, "base64")))
        .streams[0]!.codec_name
    ).toBe("png");
  });

  test("corrupt bytes, oversized declared input, aborted jobs and bounded output fail without sends", async () => {
    let sends = 0;
    const result = await sendWhatsAppArtifact(
      {
        sendMessage: async () => {
          sends += 1;
        },
      } as never,
      "628103@s.whatsapp.net",
      {
        bytes: Buffer.from("invalid"),
        filename: "bad.wav",
        mimeType: "audio/wav",
      }
    );
    expect(result.ok).toBe(false);
    expect(sends).toBe(0);
    let downloads = 0;
    const oversized = await buildWhatsAppMediaInput(
      {
        key: {},
        message: {
          videoMessage: { fileLength: 30 * 1024 * 1024, mimetype: "video/mp4" },
        },
      } as WAMessage,
      async () => {
        downloads += 1;
        return video;
      }
    );
    expect(oversized?.kind).toBe("reject");
    expect(downloads).toBe(0);
    await expect(
      encodeWhatsAppAudio(wav, "audio/wav", true, {
        signal: AbortSignal.abort(),
      })
    ).rejects.toBeDefined();
    await expect(
      transformWhatsAppMedia(wav, "wav", ["-f", "wav"], { maxOutputBytes: 10 })
    ).rejects.toBeDefined();
    await expect(
      decodeWhatsAppVisual(Buffer.from("bad"), "sticker")
    ).rejects.toBeDefined();
  });

  test("a transport rejection after receiving bytes is never retried", async () => {
    let sends = 0;
    const result = await sendWhatsAppArtifact(
      {
        sendMessage: async () => {
          sends += 1;
          throw new Error("unknown send outcome");
        },
      } as never,
      "628104@s.whatsapp.net",
      {
        bytes: wav,
        filename: "note.wav",
        mimeType: "audio/wav",
        voiceNote: true,
      }
    );
    expect(result.ok).toBe(false);
    expect(sends).toBe(1);
  });
});

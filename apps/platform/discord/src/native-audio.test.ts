import { expect, spyOn, test } from "bun:test";
import { MessageFlags, type REST } from "discord.js";
import {
  describeDiscordPcm,
  prepareDiscordPlaybackPcm,
  prepareDiscordVoiceMessage,
  sendDiscordVoiceMessage,
} from "./native-audio";
import { discordPcmToWav } from "./voice-session";

test("real FFmpeg converts PCM WAV to a native Opus voice payload with measured waveform", async () => {
  const pcm = Buffer.alloc((48_000 * 4) / 5);
  for (let frame = 0; frame < pcm.length / 4; frame += 1) {
    const sample = Math.round(
      Math.sin((frame * 2 * Math.PI * 440) / 48_000) * 12_000
    );
    pcm.writeInt16LE(sample, frame * 4);
    pcm.writeInt16LE(sample, frame * 4 + 2);
  }
  const voice = await prepareDiscordVoiceMessage(discordPcmToWav(pcm));
  expect(voice.bytes.toString("ascii", 0, 4)).toBe("OggS");
  expect(voice.bytes.includes(Buffer.from("OpusHead"))).toBe(true);
  expect(voice.durationSeconds).toBeCloseTo(0.2, 3);
  expect(Buffer.from(voice.waveform, "base64").length).toBe(2);
  expect(
    [...Buffer.from(voice.waveform, "base64")].every((point) => point > 0)
  ).toBe(true);
  const requests: { route: string; options: unknown }[] = [];
  const rest = {
    post: async (route: string, options: unknown) => {
      requests.push({ options, route });
      return { id: "voice-receipt" };
    },
  } as unknown as Pick<REST, "post">;
  expect(
    await sendDiscordVoiceMessage({ channelId: "room", rest, voice })
  ).toEqual({ id: "voice-receipt" });
  expect(requests).toEqual([
    {
      options: {
        body: {
          allowed_mentions: { parse: [] },
          attachments: [
            {
              duration_secs: voice.durationSeconds,
              filename: "voice-message.ogg",
              id: "0",
              waveform: voice.waveform,
            },
          ],
          flags: MessageFlags.IsVoiceMessage,
        },
        files: [
          {
            contentType: "audio/ogg",
            data: voice.bytes,
            name: "voice-message.ogg",
          },
        ],
      },
      route: "/channels/room/messages",
    },
  ]);
});

test("malformed audio and invalid PCM are rejected before a native upload", async () => {
  await expect(
    prepareDiscordVoiceMessage(Buffer.from("not audio"))
  ).rejects.toThrow();
  await expect(prepareDiscordVoiceMessage(new Uint8Array())).rejects.toThrow();
  expect(() => describeDiscordPcm(Buffer.alloc(1))).toThrow();
  expect(() => describeDiscordPcm(Buffer.alloc(48_000 * 2 * 121))).toThrow();
});

test("missing Discord receipt is an error, not upload acceptance", async () => {
  const rest = { post: async () => ({}) } as unknown as Pick<REST, "post">;
  await expect(
    sendDiscordVoiceMessage({
      channelId: "room",
      rest,
      voice: {
        bytes: Buffer.from("synthetic controlled payload"),
        durationSeconds: 1,
        waveform: "AA==",
      },
    })
  ).rejects.toThrow();
});

test("actual 24 kHz mono provider WAV resamples to 48 kHz stereo with unchanged pitch and duration", async () => {
  const header = Buffer.alloc(44);
  const source = Buffer.alloc((24_000 * 2) / 5);
  for (let sample = 0; sample < source.length / 2; sample += 1) {
    source.writeInt16LE(
      Math.round(Math.sin((sample * 2 * Math.PI * 440) / 24_000) * 12_000),
      sample * 2
    );
  }
  header.write("RIFF");
  header.writeUInt32LE(36 + source.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24_000, 24);
  header.writeUInt32LE(48_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(source.length, 40);
  const pcm = await prepareDiscordPlaybackPcm(Buffer.concat([header, source]));
  expect(pcm.length).toBe((48_000 * 4) / 5);
  let crossings = 0;
  const left: number[] = [];
  const right: number[] = [];
  for (let frame = 1; frame < pcm.length / 4; frame += 1) {
    const sample = pcm.readInt16LE(frame * 4);
    left.push(sample);
    right.push(pcm.readInt16LE(frame * 4 + 2));
    if (pcm.readInt16LE((frame - 1) * 4) <= 0 && sample > 0) {
      crossings += 1;
    }
  }
  expect(left).toEqual(right);
  expect(crossings / 0.2).toBeCloseTo(440, 0);
});

test.each([
  { convert: prepareDiscordVoiceMessage, name: "voice-note" },
  { convert: prepareDiscordPlaybackPcm, name: "playback" },
])(
  "cancelling $name conversion kills and reaps the real child with only the allowlisted environment",
  async ({ convert }) => {
    const controller = new AbortController();
    const spawn = Bun.spawn;
    const children: ReturnType<typeof Bun.spawn>[] = [];
    const environments: unknown[] = [];
    const observer = spyOn(Bun, "spawn").mockImplementation(((
      ...args: Parameters<typeof Bun.spawn>
    ) => {
      environments.push(args[1]?.env);
      const child = spawn(...args);
      children.push(child);
      queueMicrotask(() =>
        controller.abort(new DOMException("Stopped", "AbortError"))
      );
      return child;
    }) as typeof Bun.spawn);
    try {
      await expect(
        convert(discordPcmToWav(Buffer.alloc(3840)), controller.signal)
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(children).toHaveLength(1);
      expect(await children[0]?.exited).toBe(137);
      expect(children[0]?.signalCode).toBe("SIGKILL");
      expect(environments).toEqual([
        { LANG: "C", PATH: process.env.PATH ?? "" },
      ]);
      await expect(
        convert(discordPcmToWav(Buffer.alloc(3840)), controller.signal)
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(children).toHaveLength(1);
    } finally {
      observer.mockRestore();
    }
  }
);

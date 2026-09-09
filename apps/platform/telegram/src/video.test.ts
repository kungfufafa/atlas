import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractTelegramVideoFrames } from "./video";

test("real ffmpeg produces bounded actual PNG frames from a synthetic MP4", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-video-fixture-"));
  try {
    const file = join(directory, "video.mp4");
    execFileSync(
      "ffmpeg",
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=32x32:d=2",
        "-c:v",
        "mpeg4",
        "-y",
        file,
      ],
      { stdio: "ignore", timeout: 10_000 }
    );
    const frames = await extractTelegramVideoFrames(
      await readFile(file),
      new AbortController().signal
    );
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.length).toBeLessThanOrEqual(4);
    expect(frames[0]!.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    );
    expect(frames[0]!.readUInt32BE(16)).toBeLessThanOrEqual(640);
    expect(frames[0]!.readUInt32BE(20)).toBeLessThanOrEqual(640);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("invalid, oversized and aborted inputs allocate no decoder workspace", async () => {
  const before = (await readdir(tmpdir())).filter((name) =>
    name.startsWith("atlas-telegram-video-")
  );
  await expect(
    extractTelegramVideoFrames(
      Buffer.from("not a video"),
      new AbortController().signal
    )
  ).rejects.toThrow();
  await expect(
    extractTelegramVideoFrames(
      new Uint8Array(26 * 1024 * 1024),
      new AbortController().signal
    )
  ).rejects.toThrow();
  const controller = new AbortController();
  controller.abort();
  await expect(
    extractTelegramVideoFrames(Buffer.from("0000ftyp0000"), controller.signal)
  ).rejects.toThrow();
  expect(
    (await readdir(tmpdir())).filter((name) =>
      name.startsWith("atlas-telegram-video-")
    )
  ).toEqual(before);
});

test("actual decoder failure removes all allocated input and frame files", async () => {
  const before = (await readdir(tmpdir())).filter((name) =>
    name.startsWith("atlas-telegram-video-")
  );
  await expect(
    extractTelegramVideoFrames(
      Buffer.from("0000ftypmalformed-mp4"),
      new AbortController().signal
    )
  ).rejects.toThrow();
  expect(
    (await readdir(tmpdir())).filter((name) =>
      name.startsWith("atlas-telegram-video-")
    )
  ).toEqual(before);
});

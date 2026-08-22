import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getProfileArtifactsDir } from "@atlas/core";
import { sendDiscordArtifactTool } from "./send-discord-artifact-tool";

const previousConfigDir = process.env.ATLAS_CONFIG_DIR;

afterEach(() => {
  if (previousConfigDir === undefined) {
    delete process.env.ATLAS_CONFIG_DIR;
  } else {
    process.env.ATLAS_CONFIG_DIR = previousConfigDir;
  }
});

describe("sendDiscordArtifactTool", () => {
  test("rejects non-discord channels", async () => {
    const result = await sendDiscordArtifactTool.run(
      { path: "report.pdf" },
      { channel: "web", orgId: "org", profileId: "profile" }
    );
    expect(result).toEqual({
      error: "send_discord_artifact is only available in Discord chats.",
      ok: false,
    });
  });

  test("accepts an existing attachable artifact on discord", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "atlas-discord-tool-"));
    process.env.ATLAS_CONFIG_DIR = home;
    const orgId = "org_test";
    const profileId = "profile_test";
    const artifactsDir = getProfileArtifactsDir(orgId, profileId);
    await mkdir(artifactsDir, { recursive: true });
    await writeFile(
      path.join(artifactsDir, "atlas-pitch-deck.pdf"),
      "%PDF-1.4"
    );

    const result = await sendDiscordArtifactTool.run(
      { path: "artifacts/atlas-pitch-deck.pdf" },
      { channel: "discord", orgId, profileId }
    );

    expect(result).toEqual({
      filename: "atlas-pitch-deck.pdf",
      mimeType: "application/pdf",
      ok: true,
      path: "atlas-pitch-deck.pdf",
      sizeBytes: 8,
    });
  });

  test("refuses artifact metadata sidecars", async () => {
    const result = await sendDiscordArtifactTool.run(
      { path: "artifacts/report.md.atlas-meta.json" },
      { channel: "discord", orgId: "org", profileId: "profile" }
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("sidecar");
    }
  });
});

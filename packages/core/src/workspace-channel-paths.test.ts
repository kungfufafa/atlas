import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDiscordConfigPath, saveDiscordConfig } from "./discord-config";
import { loadTelegramConfigFile, saveTelegramConfig } from "./telegram-config";
import { loadWhatsAppConfigFile, saveWhatsAppConfig } from "./whatsapp-config";
import {
  getWorkspaceChannelDir,
  listConfiguredChannelWorkspaceIds,
  migrateLegacyChannelToWorkspace,
} from "./workspace-channel-paths";

let configDir: string | null = null;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "atlas-workspace-channels-"));
  process.env.ATLAS_CONFIG_DIR = configDir;
  delete process.env.ATLAS_WORKSPACE_ID;
});

afterEach(async () => {
  if (configDir) {
    await rm(configDir, { force: true, recursive: true });
    configDir = null;
  }

  delete process.env.ATLAS_CONFIG_DIR;
  delete process.env.ATLAS_WORKSPACE_ID;
});

describe("workspace channel isolation", () => {
  test("keeps Telegram credentials and profiles isolated by workspace", async () => {
    await saveTelegramConfig(
      { botToken: "workspace-a-token", profileId: "profile-a" },
      "workspace-a"
    );
    await saveTelegramConfig(
      { botToken: "workspace-b-token", profileId: "profile-b" },
      "workspace-b"
    );

    expect(await loadTelegramConfigFile("workspace-a")).toMatchObject({
      botToken: "workspace-a-token",
      profileId: "profile-a",
    });
    expect(await loadTelegramConfigFile("workspace-b")).toMatchObject({
      botToken: "workspace-b-token",
      profileId: "profile-b",
    });
  });

  test("keeps Discord credentials in separate workspace directories", async () => {
    await saveDiscordConfig({ botToken: "discord-a" }, "workspace-a");
    await saveDiscordConfig({ botToken: "discord-b" }, "workspace-b");

    const workspaceAConfig = await readFile(
      getDiscordConfigPath("workspace-a"),
      "utf8"
    );
    const workspaceBConfig = await readFile(
      getDiscordConfigPath("workspace-b"),
      "utf8"
    );

    expect(workspaceAConfig).toContain("discord-a");
    expect(workspaceAConfig).not.toContain("discord-b");
    expect(workspaceBConfig).toContain("discord-b");
    expect(workspaceBConfig).not.toContain("discord-a");
  });

  test("keeps WhatsApp phone and profile isolated by workspace", async () => {
    await saveWhatsAppConfig(
      { phoneNumber: "+628111", profileId: "profile-a" },
      "workspace-a"
    );
    await saveWhatsAppConfig(
      { phoneNumber: "+628222", profileId: "profile-b" },
      "workspace-b"
    );

    expect(await loadWhatsAppConfigFile("workspace-a")).toMatchObject({
      phoneNumber: "+628111",
      profileId: "profile-a",
    });
    expect(await loadWhatsAppConfigFile("workspace-b")).toMatchObject({
      phoneNumber: "+628222",
      profileId: "profile-b",
    });
  });

  test("uses the worker workspace when no explicit workspace is passed", () => {
    process.env.ATLAS_WORKSPACE_ID = "workspace-worker";

    expect(getWorkspaceChannelDir("telegram")).toContain(
      join("orgs", "workspace-worker", "channels", "telegram")
    );
  });

  test("copies a legacy config without overwriting workspace settings", async () => {
    await saveTelegramConfig({ botToken: "legacy-token" }, null);

    expect(
      await migrateLegacyChannelToWorkspace("telegram", "workspace-a")
    ).toBe(true);
    expect(await loadTelegramConfigFile("workspace-a")).toMatchObject({
      botToken: "legacy-token",
    });

    await saveTelegramConfig({ botToken: "workspace-token" }, "workspace-a");
    expect(
      await migrateLegacyChannelToWorkspace("telegram", "workspace-a")
    ).toBe(false);
    expect(await loadTelegramConfigFile("workspace-a")).toMatchObject({
      botToken: "workspace-token",
    });
  });

  test("discovers every workspace with a configured channel", async () => {
    await saveWhatsAppConfig({ phoneNumber: "+628111" }, "workspace-b");
    await saveWhatsAppConfig({ phoneNumber: "+628222" }, "workspace-a");

    expect(await listConfiguredChannelWorkspaceIds("whatsapp")).toEqual([
      "workspace-a",
      "workspace-b",
    ]);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveDiscordConfig } from "./discord-config";
import { saveTelegramConfig } from "./telegram-config";
import { saveWhatsAppConfig } from "./whatsapp-config";
import {
  discordBotTokenUsedByAnotherWorkspace,
  telegramBotTokenUsedByAnotherWorkspace,
  whatsAppPhoneUsedByAnotherWorkspace,
} from "./workspace-channel-credentials";

let configDir: string | null = null;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "atlas-channel-credentials-"));
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

describe("workspace channel credential uniqueness", () => {
  test("detects a Telegram bot token already saved in another workspace", async () => {
    await saveTelegramConfig({ botToken: "shared-token" }, "workspace-a");
    await saveTelegramConfig({ botToken: "other-token" }, "workspace-b");

    expect(
      await telegramBotTokenUsedByAnotherWorkspace(
        "workspace-b",
        "shared-token"
      )
    ).toBe(true);
    expect(
      await telegramBotTokenUsedByAnotherWorkspace(
        "workspace-a",
        "shared-token"
      )
    ).toBe(false);
  });

  test("detects a Discord bot token already saved in another workspace", async () => {
    await saveDiscordConfig({ botToken: "discord-shared" }, "workspace-a");

    expect(
      await discordBotTokenUsedByAnotherWorkspace(
        "workspace-b",
        "discord-shared"
      )
    ).toBe(true);
  });

  test("detects a WhatsApp number already saved in another workspace", async () => {
    await saveWhatsAppConfig({ phoneNumber: "+62811111111" }, "workspace-a");

    expect(
      await whatsAppPhoneUsedByAnotherWorkspace("workspace-b", "0811111111")
    ).toBe(true);
    expect(
      await whatsAppPhoneUsedByAnotherWorkspace("workspace-a", "0811111111")
    ).toBe(false);
  });
});

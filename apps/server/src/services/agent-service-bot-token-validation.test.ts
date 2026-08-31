import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDiscordConfigFile, loadTelegramConfigFile } from "@atlas/core";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { AgentService } from "./agent-service";

const ORG_ID = "org_bot_token_validation";

describe("AgentService bot-token validation", () => {
  const originalFetch = globalThis.fetch;
  const originalConfigDir = process.env.ATLAS_CONFIG_DIR;
  let configDir = "";

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "atlas-bot-token-"));
    process.env.ATLAS_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (originalConfigDir === undefined) {
      delete process.env.ATLAS_CONFIG_DIR;
    } else {
      process.env.ATLAS_CONFIG_DIR = originalConfigDir;
    }
    await rm(configDir, { force: true, recursive: true });
  });

  test("does not persist tokens rejected by Telegram or Discord", async () => {
    const service = new AgentService(
      null,
      null,
      createInMemoryDatabaseAdapter()
    );
    globalThis.fetch = (async () =>
      new Response(null, { status: 401 })) as typeof fetch;

    await expect(
      service.setTelegramSettings(ORG_ID, { botToken: "123456:rejected" })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.setDiscordSettings(ORG_ID, { botToken: "rejected-discord" })
    ).rejects.toMatchObject({ status: 400 });
    expect(await loadTelegramConfigFile(ORG_ID)).toBeNull();
    expect(await loadDiscordConfigFile(ORG_ID)).toBeNull();
  });

  test("persists tokens only after provider verification", async () => {
    const service = new AgentService(
      null,
      null,
      createInMemoryDatabaseAdapter()
    );
    let telegramUrl = "";
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("api.telegram.org")) {
        telegramUrl = url;
        return new Response(
          JSON.stringify({ ok: true, result: { is_bot: true } }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ id: "1525937133096013954" }), {
        status: 200,
      });
    }) as typeof fetch;

    await service.setTelegramSettings(ORG_ID, {
      botToken: "123456:accepted",
    });
    await service.setDiscordSettings(ORG_ID, {
      botToken: "accepted-discord",
    });

    expect(new URL(telegramUrl).pathname).toBe("/bot123456%3Aaccepted/getMe");
    expect(await loadTelegramConfigFile(ORG_ID)).toMatchObject({
      botToken: "123456:accepted",
    });
    expect(await loadDiscordConfigFile(ORG_ID)).toMatchObject({
      botToken: "accepted-discord",
    });
  });
});

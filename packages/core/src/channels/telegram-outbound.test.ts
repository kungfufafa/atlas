import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import { writePrivateTextFile } from "../fs";
import {
  getTelegramConfigDir,
  getTelegramConfigPath,
  saveTelegramConfig,
} from "../telegram-config";
import { createTelegramOutboundAdapter } from "./telegram-outbound";

describe("createTelegramOutboundAdapter", () => {
  let tempHome = "";
  let homedirSpy: ReturnType<typeof spyOn<typeof os, "homedir">> | null = null;

  afterEach(async () => {
    homedirSpy?.mockRestore();
    homedirSpy = null;

    if (tempHome) {
      await rm(tempHome, { force: true, recursive: true });
      tempHome = "";
    }
  });

  async function useTempHome(run: () => Promise<void>): Promise<void> {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "atlas-tg-outbound-"));
    homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
    await saveTelegramConfig({ botToken: "1234567890:TEST" });
    await run();
  }

  test("sends to a plain chat", async () => {
    await useTempHome(async () => {
      const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
      const adapter = createTelegramOutboundAdapter({
        fetchImpl: async (input, init) => {
          calls.push({
            body: JSON.parse(String(init?.body)),
            url: String(input),
          });
          return new Response("ok", { status: 200 });
        },
      });

      await expect(
        adapter.send({ chatIds: [1001], text: "hello" })
      ).resolves.toEqual({
        ok: true,
      });
      expect(calls[0]?.body).toEqual({ chat_id: 1001, text: "hello" });
    });
  });

  test("sends to a topic when topicId is provided", async () => {
    await useTempHome(async () => {
      const calls: Array<Record<string, unknown>> = [];
      const adapter = createTelegramOutboundAdapter({
        fetchImpl: async (_input, init) => {
          calls.push(JSON.parse(String(init?.body)));
          return new Response("ok", { status: 200 });
        },
      });

      await expect(
        adapter.send({ chatIds: [1001], text: "hello", topicId: 22 })
      ).resolves.toEqual({ ok: true });
      expect(calls[0]).toEqual({
        chat_id: 1001,
        message_thread_id: 22,
        text: "hello",
      });
    });
  });

  test("renders markdown as Telegram HTML when parse mode is requested", async () => {
    await useTempHome(async () => {
      const calls: Array<Record<string, unknown>> = [];
      const adapter = createTelegramOutboundAdapter({
        fetchImpl: async (_input, init) => {
          calls.push(JSON.parse(String(init?.body)));
          return new Response("ok", { status: 200 });
        },
      });

      await expect(
        adapter.send({
          chatIds: [1001],
          parseMode: "HTML",
          text: "✅ **New payment**\n\nCustomer: [Ahmad](https://example.com)",
        })
      ).resolves.toEqual({ ok: true });

      expect(calls[0]).toEqual({
        chat_id: 1001,
        parse_mode: "HTML",
        text: '✅ <b>New payment</b>\n\nCustomer: <a href="https://example.com">Ahmad</a>',
      });
    });
  });

  test("isolates bot tokens and destinations between workspaces", async () => {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "atlas-tg-outbound-"));
    homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);

    await writePrivateTextFile(
      getTelegramConfigPath("workspace-a"),
      "bot_token=token-a\nprofile_id=default\npaired_user_ids=101\n",
      { ensureDir: getTelegramConfigDir("workspace-a") }
    );
    await writePrivateTextFile(
      getTelegramConfigPath("workspace-b"),
      "bot_token=token-b\nprofile_id=default\npaired_user_ids=202\n",
      { ensureDir: getTelegramConfigDir("workspace-b") }
    );

    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const adapter = createTelegramOutboundAdapter({
      fetchImpl: async (input, init) => {
        calls.push({
          body: JSON.parse(String(init?.body)),
          url: String(input),
        });
        return new Response("ok", { status: 200 });
      },
    });

    const resA = await adapter.send({
      orgId: "workspace-a",
      text: "hello A",
    });
    expect(resA.ok).toBe(true);
    expect(calls[0]?.url).toBe(
      "https://api.telegram.org/bottoken-a/sendMessage"
    );
    expect(calls[0]?.body).toEqual({ chat_id: 101, text: "hello A" });

    const resB = await adapter.send({
      orgId: "workspace-b",
      text: "hello B",
    });
    expect(resB.ok).toBe(true);
    expect(calls[1]?.url).toBe(
      "https://api.telegram.org/bottoken-b/sendMessage"
    );
    expect(calls[1]?.body).toEqual({ chat_id: 202, text: "hello B" });

    const resUnconfigured = await adapter.send({
      orgId: "workspace-c",
      text: "hello C",
    });
    expect(resUnconfigured.ok).toBe(false);
    expect(resUnconfigured.error).toBe("Telegram bot token is not configured.");
  });
});

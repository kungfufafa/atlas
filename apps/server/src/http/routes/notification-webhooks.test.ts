import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import {
  getTelegramConfigDir,
  getTelegramConfigPath,
  writePrivateTextFile,
} from "@atlas/core";
import { createMinimalHonoApp } from "../test-app-helpers";

describe("notification webhook routes", () => {
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

  async function createApp() {
    tempHome = await mkdtemp(path.join(os.tmpdir(), "atlas-notify-webhook-"));
    homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
    await writePrivateTextFile(
      getTelegramConfigPath("org_1"),
      "bot_token=1234567890:TEST\nprofile_id=default\npaired_user_ids=1001\n",
      { ensureDir: getTelegramConfigDir("org_1") }
    );

    const result = createMinimalHonoApp({
      agent: {},
      systemStatus: {},
    });
    const now = "2026-07-04T10:00:00.000Z";
    await result.databaseAdapter.upsertOrganization({
      createdAt: now,
      id: "org_1",
      name: "Acme",
      slug: "acme",
      updatedAt: now,
    });
    return result;
  }

  test("accepts authenticated webhook requests and delivers to telegram topics", async () => {
    const telegramCalls: Array<Record<string, unknown>> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      telegramCalls.push(JSON.parse(String(init?.body)));
      return new Response("ok", { status: 200 });
    };

    try {
      const { app, databaseAdapter, authService } = await createApp();
      await databaseAdapter.upsertNotificationDestination({
        channel: "telegram",
        config: { chatId: 1001, topicId: 22 },
        createdAt: "2026-07-04T10:00:00.000Z",
        id: "dest_1",
        name: "Payments",
        orgId: "org_1",
        secretHash: authService.hashToken("secret_key"),
        updatedAt: "2026-07-04T10:00:00.000Z",
      });

      const response = await app.fetch(
        new Request("http://localhost:4310/v1/notify/dest_1", {
          body: JSON.stringify({
            body: "Customer: Ahmad",
            level: "success",
            title: "New payment received",
          }),
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": "secret_key",
          },
          method: "POST",
        })
      );

      expect(response.status).toBe(204);
      expect(telegramCalls[0]).toEqual({
        chat_id: 1001,
        message_thread_id: 22,
        parse_mode: "HTML",
        text: "✅ <b>New payment received</b>\n\nCustomer: Ahmad",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects invalid webhook credentials", async () => {
    const { app, databaseAdapter, authService } = await createApp();

    await databaseAdapter.upsertNotificationDestination({
      channel: "telegram",
      config: { chatId: 1001, topicId: null },
      createdAt: "2026-07-04T10:00:00.000Z",
      id: "dest_1",
      name: "Payments",
      orgId: "org_1",
      secretHash: authService.hashToken("secret_key"),
      updatedAt: "2026-07-04T10:00:00.000Z",
    });

    const response = await app.fetch(
      new Request("http://localhost:4310/v1/notify/dest_1", {
        body: JSON.stringify({ body: "Hello" }),
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": "wrong",
        },
        method: "POST",
      })
    );

    expect(response.status).toBe(401);
  });

  test("does not deliver for an archived organization", async () => {
    const telegramCalls: unknown[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      telegramCalls.push(init?.body);
      return new Response("ok", { status: 200 });
    };

    try {
      const { app, databaseAdapter, authService } = await createApp();
      const now = "2026-08-26T00:00:00.000Z";
      await databaseAdapter.upsertOrganization({
        archivedAt: now,
        createdAt: "2026-07-04T10:00:00.000Z",
        id: "org_1",
        name: "Acme",
        slug: "acme",
        updatedAt: now,
      });
      await databaseAdapter.upsertNotificationDestination({
        channel: "telegram",
        config: { chatId: 1001, topicId: null },
        createdAt: now,
        id: "dest_1",
        name: "Payments",
        orgId: "org_1",
        secretHash: authService.hashToken("secret_key"),
        updatedAt: now,
      });

      const response = await app.fetch(
        new Request("http://localhost:4310/v1/notify/dest_1", {
          body: JSON.stringify({ body: "Hello" }),
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": "secret_key",
          },
          method: "POST",
        })
      );

      expect(response.status).toBe(404);
      expect(telegramCalls).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

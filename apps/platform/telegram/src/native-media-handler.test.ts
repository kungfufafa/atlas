import { expect, test } from "bun:test";
import { join } from "node:path";
import type {
  ChannelActionReceipt,
  ChannelNativeActionRequest,
} from "@atlas/core/channel-native-actions";
import { TelegramAuthStore } from "./auth-store";
import { createChatHandler, resetChatLocksForTests } from "./chat-handler";
import { SessionStore } from "./session-store";
import {
  createMessageContext,
  createMockClient,
  createTestOrgStore,
  withTempHome,
  writeTelegramConfigIni,
} from "./test-helpers";

async function fixture(home: string) {
  resetChatLocksForTests();
  await writeTelegramConfigIni(home, {
    botToken: "123:controlled",
    pairedUserIds: [42],
  });
  const authStore = new TelegramAuthStore();
  await authStore.reload();
  const mock = createMockClient();
  const orgStore = createTestOrgStore(home);
  await orgStore.load();
  const handler = createChatHandler({
    authStore,
    client: mock.client,
    config: { botToken: "123:controlled", profileId: "default" },
    orgStore,
    sessionStore: new SessionStore(join(home, "media-sessions.json")),
  });
  const message = createMessageContext({ userId: 42 });
  let downloads = 0;
  Object.assign(message.ctx.api, {
    getFile: async () => {
      downloads++;
      return { file_path: "sticker.webp" };
    },
    token: "controlled",
  });
  return { downloads: () => downloads, handler, message, mock };
}

test("static WebP sticker bytes reach the actual Telegram chat input as an image", async () => {
  await withTempHome(async (home) => {
    const f = await fixture(home);
    const bytes = Buffer.from(
      "UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA",
      "base64"
    );
    Object.assign(f.message.ctx.message!, {
      sticker: {
        emoji: "🙂",
        file_id: "static",
        is_animated: false,
        is_video: false,
      },
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async () =>
        new Response(bytes, {
          headers: { "content-type": "image/webp" },
        }),
      { preconnect() {} }
    );
    try {
      await f.handler(f.message.ctx);
      expect(f.downloads()).toBe(1);
      expect(f.mock.calls.sendStream).toBe(1);
      const input = f.mock.getLastStreamInput() as {
        images?: Array<{ data: string; mediaType: string }>;
      };
      expect(input.images?.[0]?.mediaType).toBe("image/webp");
      expect(Buffer.from(input.images![0]!.data, "base64")).toEqual(bytes);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("unsupported animated stickers are rejected without downloading or invoking a model", async () => {
  await withTempHome(async (home) => {
    const f = await fixture(home);
    Object.assign(f.message.ctx.message!, {
      sticker: { file_id: "animated", is_animated: true },
    });
    await f.handler(f.message.ctx);
    expect(f.downloads()).toBe(0);
    expect(f.mock.calls.sendStream).toBe(0);
  });
});

test("video authority denial happens before file download, decoding or model dispatch", async () => {
  await withTempHome(async (home) => {
    const f = await fixture(home);
    Object.assign(f.message.ctx.message!, {
      video: { duration: 1, file_id: "video", mime_type: "video/mp4" },
    });
    f.mock.client.authorizeChannelPrincipal = async () => {
      throw new Error("Current files policy denies access");
    };
    await f.handler(f.message.ctx);
    expect(f.downloads()).toBe(0);
    expect(f.mock.calls.sendStream).toBe(0);
  });
});

for (const outcome of ["accepted", "unknown"] as const) {
  test(`native voice ${outcome} suppresses automatic duplicate delivery while retaining the artifact registry`, async () => {
    await withTempHome(async (home) => {
      resetChatLocksForTests();
      await writeTelegramConfigIni(home, {
        botToken: "123:controlled",
        pairedUserIds: [42],
      });
      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const request: ChannelNativeActionRequest = {
        action: {
          kind: "send_media",
          mode: "voice",
          path: "artifacts/voice.ogg",
        },
        channel: "telegram",
        channelChatId: "42",
        channelIsGroup: false,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        id: crypto.randomUUID(),
        orgId: "org_test",
        profileId: "default",
        sessionId: "session_test",
      };
      const bytes = Buffer.concat([
        Buffer.from("OggS"),
        Buffer.alloc(24),
        Buffer.from("OpusHead"),
        Buffer.alloc(16),
      ]);
      const mock = createMockClient({
        steps: [
          { request, type: "channel_action" },
          {
            artifact: {
              createdAt: new Date().toISOString(),
              filename: "voice.ogg",
              id: "voice",
              mimeType: "audio/ogg",
              path: "artifacts/voice.ogg",
              size: bytes.length,
              type: "file",
            },
            type: "artifact",
          },
        ],
        streaming: true,
      });
      const receipts: ChannelActionReceipt[] = [];
      mock.client.claimChannelAction = async () => request;
      mock.client.completeChannelAction = async ({ receipt }) => {
        receipts.push(receipt);
        return { recorded: true };
      };
      mock.client.readProfileArtifactContent = async () => ({
        contentType: "audio/ogg",
        data: bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength
        ),
      });
      const orgStore = createTestOrgStore(home);
      await orgStore.load();
      const sessionStore = new SessionStore(join(home, "media-sessions.json"));
      const handler = createChatHandler({
        authStore,
        client: mock.client,
        config: { botToken: "123:controlled", profileId: "default" },
        orgStore,
        sessionStore,
      });
      const message = createMessageContext({
        text: "Create a voice note",
        userId: 42,
      });
      let uploads = 0;
      Object.assign(message.ctx.api, {
        sendVoice: async (_chat: number, file: { fileData: Uint8Array }) => {
          uploads++;
          expect(Buffer.from(file.fileData)).toEqual(bytes);
          if (outcome === "unknown") {
            throw new Error("Acknowledgement lost after upload");
          }
          return { message_id: 900 };
        },
      });
      await handler(message.ctx);
      expect(uploads).toBe(1);
      expect(message.documentSends).toBe(0);
      expect(receipts).toEqual([expect.objectContaining({ status: outcome })]);
      expect(sessionStore.getDeliverableArtifacts("42")).toEqual([
        expect.objectContaining({ path: "voice.ogg" }),
      ]);
    });
  });
}

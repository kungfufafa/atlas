import { afterEach, expect, spyOn, test } from "bun:test";
import path from "node:path";
import type { ChannelAccessMode } from "@atlas/core/contract";
import { MAX_DOCUMENT_BYTES } from "@atlas/core/message-content";
import { TelegramAuthStore } from "./auth-store";
import { createChatHandler, resetChatLocksForTests } from "./chat-handler";
import { SessionStore } from "./session-store";
import {
  createMessageContext,
  createMockClient,
  createTestOrgStore,
  TEST_BOT_INFO,
  withTempHome,
  writeTelegramConfigIni,
} from "./test-helpers";

afterEach(resetChatLocksForTests);

const identities = [
  {
    allowlist: true,
    denylist: true,
    label: "paired",
    open: true,
    pairing: true,
    userId: 11,
  },
  {
    allowlist: true,
    denylist: true,
    label: "allowed guest",
    open: true,
    pairing: true,
    userId: 22,
  },
  {
    allowlist: false,
    denylist: true,
    label: "unlinked guest",
    open: true,
    pairing: false,
    userId: 33,
  },
  {
    allowlist: false,
    denylist: false,
    label: "blocked guest",
    open: true,
    pairing: false,
    userId: 44,
  },
  {
    allowlist: true,
    denylist: false,
    label: "paired and blocked",
    open: true,
    pairing: true,
    userId: 55,
  },
  {
    allowlist: true,
    denylist: false,
    label: "allowed and blocked",
    open: true,
    pairing: true,
    userId: 66,
  },
] as const;
const modes: ChannelAccessMode[] = ["pairing", "allowlist", "denylist", "open"];
const surfaces = ["dm", "group mention", "unaddressed group", "topic"] as const;

for (const accessMode of modes) {
  for (const identity of identities) {
    for (const surface of surfaces) {
      test(`Telegram access: ${accessMode} / ${identity.label} / ${surface}`, async () => {
        await withTempHome(async (homeDir) => {
          await writeTelegramConfigIni(homeDir, {
            accessMode: "open",
            botToken: "foreign-token",
            orgId: "org_b",
          });
          await writeTelegramConfigIni(homeDir, {
            accessMode,
            allowedUserIds: [22, 66],
            blockedUserIds: [44, 55, 66],
            botToken: "tenant-token",
            orgId: "org_a",
            pairedUserIds: [11, 55],
          });
          const {
            client,
            calls,
            getLastCreateSessionExternalPrincipal,
            getLastCreateSessionProfileId,
            getCreateSessionOrgIds,
          } = createMockClient({ profiles: [{ id: "profile_a" }] });
          const handler = createChatHandler({
            authStore: new TelegramAuthStore("org_a"),
            client,
            config: { botToken: "tenant-token", profileId: "profile_a" },
            fixedWorkspaceId: "org_a",
            getBotInfo: () => TEST_BOT_INFO,
            orgStore: createTestOrgStore(homeDir),
            sessionStore: new SessionStore(
              path.join(homeDir, "sessions_a.json")
            ),
          });
          const mention = surface === "group mention" || surface === "topic";
          const message = createMessageContext({
            chatId: surface === "dm" ? identity.userId : -100,
            chatType: surface === "dm" ? "private" : "supergroup",
            entities: mention
              ? [{ length: 6, offset: 0, type: "mention" }]
              : undefined,
            messageThreadId: surface === "topic" ? 77 : undefined,
            text: mention ? "@mybot hello" : "hello",
            userId: identity.userId,
          });
          await handler(message.ctx);
          const allowed =
            identity[accessMode] && surface !== "unaddressed group";
          expect(calls.sendStream).toBe(allowed ? 1 : 0);
          expect(calls.createSession).toBe(allowed ? 1 : 0);
          expect(calls.readProfileArtifactContent).toBe(0);
          expect(calls.publishProfileArtifactShare).toBe(0);
          expect(message.documentSends + message.photoSends).toBe(0);
          if (allowed) {
            expect(getLastCreateSessionExternalPrincipal()).toEqual({
              channelAddressed: true,
              channelChatId: String(surface === "dm" ? identity.userId : -100),
              channelIsGroup: surface !== "dm",
              channelThreadId: surface === "topic" ? "77" : undefined,
              channelUserId: String(identity.userId),
            });
            expect(getLastCreateSessionProfileId()).toBe("profile_a");
            expect(getCreateSessionOrgIds()).toEqual(["org_a"]);
          }
        });
      });
    }
  }
}

for (const command of [
  "attach",
  "clear",
  "compact",
  "new",
  "status",
  "stop",
  "org",
  "profile",
]) {
  for (const group of [false, true]) {
    test(`Telegram blocked paired user cannot execute /${command} (${group ? "group" : "DM"})`, async () => {
      await withTempHome(async (homeDir) => {
        await writeTelegramConfigIni(homeDir, {
          accessMode: "denylist",
          blockedUserIds: [11],
          botToken: "token",
          pairedUserIds: [11],
        });
        const { client, calls } = createMockClient();
        const listProfiles = spyOn(client, "listProfiles");
        const listOrgs = spyOn(client, "listUserOrgs");
        const handler = createChatHandler({
          authStore: new TelegramAuthStore(),
          client,
          config: { botToken: "token", profileId: "default" },
          fixedWorkspaceId: "org_a",
          getBotInfo: () => TEST_BOT_INFO,
          orgStore: createTestOrgStore(homeDir),
          sessionStore: new SessionStore(path.join(homeDir, "sessions.json")),
        });
        const message = createMessageContext({
          chatId: group ? -100 : 11,
          chatType: group ? "supergroup" : "private",
          text: `/${command}${group ? "@mybot" : ""}`,
          userId: 11,
        });
        await handler(message.ctx);
        expect(
          calls.createSession +
            calls.sendStream +
            calls.readProfileArtifactContent
        ).toBe(0);
        expect(message.documentSends + message.photoSends).toBe(0);
        expect(listProfiles).not.toHaveBeenCalled();
        expect(listOrgs).not.toHaveBeenCalled();
        listProfiles.mockRestore();
        listOrgs.mockRestore();
      });
    });
  }
}

test("Telegram revalidates cached paired sessions before downloading or saving inbound bytes", async () => {
  await withTempHome(async (homeDir) => {
    await writeTelegramConfigIni(homeDir, {
      botToken: "token",
      pairedUserIds: [11],
    });
    const { client, calls } = createMockClient();
    const authorize = spyOn(
      client,
      "authorizeChannelPrincipal"
    ).mockRejectedValue(new Error("Current principal cannot write files"));
    try {
      const sessionStore = new SessionStore(
        path.join(homeDir, "sessions.json")
      );
      sessionStore.set("11", {
        channelUserId: "11",
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      sessionStore.setHotSession(
        "11",
        client.createChatSession("session_test", "telegram")
      );
      const handler = createChatHandler({
        authStore: new TelegramAuthStore(),
        client,
        config: { botToken: "token", profileId: "default" },
        fixedWorkspaceId: "org_a",
        orgStore: createTestOrgStore(homeDir),
        sessionStore,
      });
      const message = createMessageContext({ userId: 11 });
      Object.assign(message.ctx.message!, {
        document: {
          file_id: "doc",
          file_name: "secret.pdf",
          file_size: 30,
          mime_type: "application/pdf",
        },
      });
      let downloads = 0;
      Object.assign(message.ctx.api, {
        getFile: () => {
          downloads += 1;
          throw new Error("Unauthorized download");
        },
      });
      await handler(message.ctx);
      expect(authorize).toHaveBeenCalledWith({
        channel: "telegram",
        channelAddressed: true,
        channelChatId: "11",
        channelIsGroup: false,
        channelThreadId: undefined,
        channelUserId: "11",
        intent: "files",
        profileId: "default",
        sessionId: "session_test",
      });
      expect(downloads).toBe(0);
      expect(calls.sendStream).toBe(0);
      const { readdir } = await import("node:fs/promises");
      expect(
        await readdir(
          path.join(homeDir, ".atlas", "orgs", "org_a", "profiles")
        ).catch(() => [])
      ).toEqual([]);
    } finally {
      authorize.mockRestore();
    }
  });
});

test("Telegram /attach revalidates the current sender before reading cached artifacts", async () => {
  await withTempHome(async (homeDir) => {
    await writeTelegramConfigIni(homeDir, {
      botToken: "token",
      pairedUserIds: [11],
    });
    const { client, calls } = createMockClient();
    const authorize = spyOn(
      client,
      "authorizeChannelPrincipal"
    ).mockRejectedValue(new Error("Principal revoked"));
    try {
      const sessionStore = new SessionStore(
        path.join(homeDir, "sessions.json")
      );
      sessionStore.set("11", {
        channelUserId: "11",
        deliverableArtifacts: [
          {
            filename: "secret.pdf",
            mimeType: "application/pdf",
            path: "secret.pdf",
            savedAt: new Date().toISOString(),
            sharePath: "/secret",
            shareUrl: "https://private.example/secret",
            sizeBytes: 30,
          },
        ],
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      const handler = createChatHandler({
        authStore: new TelegramAuthStore(),
        client,
        config: { botToken: "token", profileId: "default" },
        fixedWorkspaceId: "org_a",
        orgStore: createTestOrgStore(homeDir),
        sessionStore,
      });
      const message = createMessageContext({ text: "/attach", userId: 11 });
      await handler(message.ctx);
      expect(authorize).toHaveBeenCalledWith({
        channel: "telegram",
        channelAddressed: true,
        channelChatId: "11",
        channelIsGroup: false,
        channelThreadId: undefined,
        channelUserId: "11",
        intent: "read",
        profileId: "default",
        sessionId: "session_test",
      });
      expect(
        calls.readProfileArtifactContent + calls.publishProfileArtifactShare
      ).toBe(0);
      expect(message.documentSends).toBe(0);
      expect(message.replies.join("\n")).not.toContain(
        "https://private.example/secret"
      );
    } finally {
      authorize.mockRestore();
    }
  });
});

test("Telegram does not emit a cached share URL when delivery authorization is revoked after the turn", async () => {
  await withTempHome(async (homeDir) => {
    await writeTelegramConfigIni(homeDir, {
      botToken: "token",
      pairedUserIds: [11],
    });
    const { client, calls } = createMockClient({
      messages: [
        { content: "save a file", role: "user" },
        {
          content: "",
          role: "assistant",
          toolCalls: [
            {
              arguments: { content: "%PDF-1.4", path: "artifacts/secret.pdf" },
              id: "write_secret",
              name: "write_file",
            },
          ],
        },
        {
          content: JSON.stringify({
            bytesWritten: 8,
            path: "artifacts/secret.pdf",
          }),
          name: "write_file",
          role: "tool",
          toolCallId: "write_secret",
        },
        { content: "Saved the file.", role: "assistant" },
      ],
    });
    const authorize = spyOn(
      client,
      "authorizeChannelPrincipal"
    ).mockRejectedValue(new Error("Principal revoked"));
    try {
      const sessionStore = new SessionStore(
        path.join(homeDir, "sessions.json")
      );
      sessionStore.set("11", {
        artifactShareUrls: { "secret.pdf": "https://private.example/secret" },
        channelUserId: "11",
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      const handler = createChatHandler({
        authStore: new TelegramAuthStore(),
        client,
        config: { botToken: "token", profileId: "default" },
        fixedWorkspaceId: "org_a",
        orgStore: createTestOrgStore(homeDir),
        sessionStore,
      });
      const message = createMessageContext({ text: "continue", userId: 11 });
      await handler(message.ctx);
      expect(calls.sendStream).toBe(1);
      expect(authorize).toHaveBeenCalledWith({
        channel: "telegram",
        channelAddressed: true,
        channelChatId: "11",
        channelIsGroup: false,
        channelThreadId: undefined,
        channelUserId: "11",
        intent: "read",
        profileId: "default",
        sessionId: "session_test",
      });
      expect(
        calls.readProfileArtifactContent + calls.publishProfileArtifactShare
      ).toBe(0);
      expect(message.documentSends).toBe(0);
      expect(message.replies.join("\n")).not.toContain(
        "https://private.example/secret"
      );
    } finally {
      authorize.mockRestore();
    }
  });
});

test("Telegram does not persist source bytes if authorization is revoked during download", async () => {
  await withTempHome(async (homeDir) => {
    await writeTelegramConfigIni(homeDir, {
      botToken: "token",
      pairedUserIds: [11],
    });
    const { client, calls } = createMockClient();
    const originalAuthorize = client.authorizeChannelPrincipal.bind(client);
    let checks = 0;
    const authorize = spyOn(
      client,
      "authorizeChannelPrincipal"
    ).mockImplementation(async (input) => {
      checks += 1;
      if (checks > 1) {
        throw new Error("Principal revoked during download");
      }
      return originalAuthorize(input);
    });
    const bytes = Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 32);
    bytes.write("%PDF-1.4");
    const download = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(async () => new Response(bytes), { preconnect() {} })
    );
    try {
      const handler = createChatHandler({
        authStore: new TelegramAuthStore(),
        client,
        config: { botToken: "token", profileId: "default" },
        fixedWorkspaceId: "org_a",
        orgStore: createTestOrgStore(homeDir),
        sessionStore: new SessionStore(path.join(homeDir, "sessions.json")),
      });
      const message = createMessageContext({ userId: 11 });
      Object.assign(message.ctx.message!, {
        document: {
          file_id: "doc",
          file_name: "source.pdf",
          file_size: bytes.length,
          mime_type: "application/pdf",
        },
      });
      Object.assign(message.ctx.api, {
        getFile: async () => ({
          file_path: "source.pdf",
          file_size: bytes.length,
        }),
        token: "token",
      });
      await handler(message.ctx);
      expect(download).toHaveBeenCalledTimes(1);
      expect(checks).toBe(2);
      expect(calls.sendStream).toBe(0);
      const { readdir } = await import("node:fs/promises");
      expect(
        await readdir(
          path.join(homeDir, ".atlas", "orgs", "org_a", "profiles")
        ).catch(() => [])
      ).toEqual([]);
    } finally {
      authorize.mockRestore();
      download.mockRestore();
    }
  });
});

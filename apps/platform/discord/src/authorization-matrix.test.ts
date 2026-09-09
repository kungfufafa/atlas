import { afterEach, expect, spyOn, test } from "bun:test";
import path from "node:path";
import type { ChannelAccessMode } from "@atlas/core/contract";
import { MAX_DOCUMENT_BYTES } from "@atlas/core/message-content";
import { DiscordAuthStore } from "./auth-store";
import { createChatHandler, resetChatLocksForTests } from "./chat-handler";
import { SessionStore } from "./session-store";
import {
  createDmMessage,
  createGuildChatMessage,
  createMockClient,
  createSlashInteraction,
  createTestOrgStore,
  withTempHome,
  writeDiscordConfigIni,
} from "./test-helpers";
import { ThreadStore } from "./thread-store";

afterEach(resetChatLocksForTests);

const identities = [
  {
    allowlist: true,
    denylist: true,
    label: "paired",
    open: true,
    pairing: true,
    userId: "111111111111111111",
  },
  {
    allowlist: true,
    denylist: true,
    label: "allowed guest",
    open: true,
    pairing: true,
    userId: "222222222222222222",
  },
  {
    allowlist: false,
    denylist: true,
    label: "unlinked guest",
    open: true,
    pairing: false,
    userId: "333333333333333333",
  },
  {
    allowlist: false,
    denylist: false,
    label: "blocked guest",
    open: true,
    pairing: false,
    userId: "444444444444444444",
  },
  {
    allowlist: true,
    denylist: false,
    label: "paired and blocked",
    open: true,
    pairing: true,
    userId: "555555555555555555",
  },
  {
    allowlist: true,
    denylist: false,
    label: "allowed and blocked",
    open: true,
    pairing: true,
    userId: "666666666666666666",
  },
] as const;
const modes: ChannelAccessMode[] = ["pairing", "allowlist", "denylist", "open"];
const surfaces = [
  "dm",
  "guild mention",
  "unaddressed guild",
  "owned thread",
  "foreign thread",
  "claim thread",
] as const;

for (const accessMode of modes) {
  for (const identity of identities) {
    for (const surface of surfaces) {
      test(`Discord access: ${accessMode} / ${identity.label} / ${surface}`, async () => {
        await withTempHome(async (homeDir) => {
          await writeDiscordConfigIni(homeDir, {
            accessMode: "open",
            botToken: "foreign-token",
            orgId: "org_b",
          });
          await writeDiscordConfigIni(homeDir, {
            accessMode,
            allowedUserIds: [identities[1].userId, identities[5].userId],
            blockedUserIds: [
              identities[3].userId,
              identities[4].userId,
              identities[5].userId,
            ],
            botToken: "tenant-token",
            orgId: "org_a",
            pairedUserIds: [identities[0].userId, identities[4].userId],
          });
          const authStore = new DiscordAuthStore("org_a");
          const { client, calls } = createMockClient({
            profiles: [{ id: "profile_a" }],
          });
          const createSession = spyOn(client, "createSession");
          const sessionStore = new SessionStore(
            path.join(homeDir, "sessions_a.json")
          );
          const threadStore = new ThreadStore(
            path.join(homeDir, "threads_a.json")
          );
          if (surface === "owned thread") {
            threadStore.add("thread_1");
          }
          const handler = createChatHandler({
            authStore,
            client,
            config: { botToken: "tenant-token", profileId: "profile_a" },
            fixedWorkspaceId: "org_a",
            orgStore: createTestOrgStore(homeDir),
            sessionStore,
            threadStore,
          });
          const triggered =
            surface !== "unaddressed guild" && surface !== "foreign thread";
          const allowed = identity[accessMode] && triggered;
          if (surface === "dm") {
            const message = createDmMessage({
              content: "hello",
              userId: identity.userId,
            });
            await handler.handleMessage(message.message);
            expect(message.fileSendCalls).toBe(0);
          } else {
            const message = createGuildChatMessage({
              content:
                surface === "guild mention" || surface === "claim thread"
                  ? "<@bot_id> hello"
                  : "hello",
              inThread: surface.includes("thread"),
              mentionsBot:
                surface === "guild mention" || surface === "claim thread",
              userId: identity.userId,
            });
            await handler.handleMessage(message.message);
            expect(message.startThreadCalls).toBe(
              allowed && surface === "guild mention" ? 1 : 0
            );
            expect(
              message.channelFileSendCalls + message.threadFileSendCalls
            ).toBe(0);
            if (surface === "claim thread") {
              expect(threadStore.hasThreadId("thread_1")).toBe(allowed);
            }
          }
          expect(calls.sendStream).toBe(allowed ? 1 : 0);
          expect(calls.createSession).toBe(allowed ? 1 : 0);
          expect(calls.readProfileArtifactContent).toBe(0);
          expect(calls.publishProfileArtifactShare).toBe(0);
          if (allowed) {
            expect(createSession).toHaveBeenCalledWith("discord", {
              externalPrincipal: {
                channelAddressed: true,
                channelChatId:
                  surface === "dm" ? "dm_channel_1" : "guild_channel_1",
                channelIsGroup: surface !== "dm",
                channelThreadId:
                  surface === "dm" ? undefined : expect.any(String),
                channelUserId: identity.userId,
              },
              profileId: "profile_a",
            });
          }
          createSession.mockRestore();
        });
      });
    }
  }
}

for (const commandName of [
  "attach",
  "clear",
  "compact",
  "new",
  "status",
  "stop",
  "close",
  "allow",
]) {
  test(`Discord blocked paired user cannot execute /${commandName}`, async () => {
    await withTempHome(async (homeDir) => {
      const userId = identities[0].userId;
      await writeDiscordConfigIni(homeDir, {
        accessMode: "denylist",
        blockedUserIds: [userId],
        botToken: "tenant-token",
        pairedUserIds: [userId],
      });
      const { client, calls } = createMockClient();
      const threadStore = new ThreadStore(path.join(homeDir, "threads.json"));
      threadStore.add("thread_1");
      const handler = createChatHandler({
        authStore: new DiscordAuthStore(),
        client,
        config: { botToken: "tenant-token", profileId: "default" },
        fixedWorkspaceId: "org_a",
        orgStore: createTestOrgStore(homeDir),
        sessionStore: new SessionStore(path.join(homeDir, "sessions.json")),
        threadStore,
      });
      const interaction = createSlashInteraction({
        commandName,
        inThread: true,
        userId,
        userOption: { id: "999999999999999999" },
      });
      await handler.handleSlashCommand(interaction.interaction);
      expect(calls.createSession).toBe(0);
      expect(calls.readProfileArtifactContent).toBe(0);
      expect(interaction.fileSendCalls).toBe(0);
      expect(threadStore.hasThreadId("thread_1")).toBe(true);
      const { loadDiscordConfigFile } = await import(
        "@atlas/core/discord-config"
      );
      expect((await loadDiscordConfigFile())?.allowedUserIds).toEqual([]);
    });
  });
}

test("Discord /attach never claims a legacy registry without a sender owner", async () => {
  await withTempHome(async (homeDir) => {
    await writeDiscordConfigIni(homeDir, {
      botToken: "token",
      pairedUserIds: [identities[0].userId],
    });
    const { client, calls } = createMockClient();
    const sessionStore = new SessionStore(path.join(homeDir, "sessions.json"));
    sessionStore.set("guild_channel_1", {
      deliverableArtifacts: [
        {
          filename: "secret.txt",
          mimeType: "text/plain",
          path: "artifacts/secret.txt",
          savedAt: "2026-01-01T00:00:00.000Z",
          sharePath: null,
          shareUrl: null,
          sizeBytes: 6,
        },
      ],
      profileId: "foreign_profile",
      sessionId: "foreign_session",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const handler = createChatHandler({
      authStore: new DiscordAuthStore(),
      client,
      config: { botToken: "token", profileId: "default" },
      fixedWorkspaceId: "org_a",
      orgStore: createTestOrgStore(homeDir),
      sessionStore,
      threadStore: new ThreadStore(path.join(homeDir, "threads.json")),
    });
    const interaction = createSlashInteraction({
      commandName: "attach",
      userId: identities[0].userId,
    });
    await handler.handleSlashCommand(interaction.interaction);
    expect(interaction.fileSendCalls).toBe(0);
    expect(calls.readProfileArtifactContent).toBe(0);
    expect(calls.createSession).toBe(1);
    expect(sessionStore.get("guild_channel_1")?.channelUserId).toBeUndefined();
  });
});

test("Discord revalidates cached paired sessions before downloading or saving inbound bytes", async () => {
  await withTempHome(async (homeDir) => {
    const userId = identities[0].userId;
    await writeDiscordConfigIni(homeDir, {
      botToken: "token",
      pairedUserIds: [userId],
    });
    const { client, calls } = createMockClient();
    const authorize = spyOn(
      client,
      "authorizeChannelPrincipal"
    ).mockRejectedValue(new Error("Current principal cannot write files"));
    const download = spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Unauthorized download")
    );
    try {
      const sessionStore = new SessionStore(
        path.join(homeDir, "sessions.json")
      );
      sessionStore.set("dm_channel_1", {
        channelUserId: userId,
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      sessionStore.setHotSession(
        "dm_channel_1",
        client.createChatSession("session_test", "discord")
      );
      const handler = createChatHandler({
        authStore: new DiscordAuthStore(),
        client,
        config: { botToken: "token", profileId: "default" },
        fixedWorkspaceId: "org_a",
        orgStore: createTestOrgStore(homeDir),
        sessionStore,
        threadStore: new ThreadStore(path.join(homeDir, "threads.json")),
      });
      const message = createDmMessage({
        attachments: [
          {
            contentType: "application/pdf",
            name: "secret.pdf",
            size: 30,
            url: "https://cdn.discordapp.com/attachments/1/2/secret.pdf",
          },
        ],
        userId,
      });
      await handler.handleMessage(message.message);
      expect(authorize).toHaveBeenCalledWith({
        channel: "discord",
        channelAddressed: true,
        channelChatId: "dm_channel_1",
        channelIsGroup: false,
        channelThreadId: undefined,
        channelUserId: userId,
        intent: "files",
        profileId: "default",
        sessionId: "session_test",
      });
      expect(download).not.toHaveBeenCalled();
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

test("Discord /attach revalidates the current sender before reading cached artifacts", async () => {
  await withTempHome(async (homeDir) => {
    const userId = identities[0].userId;
    await writeDiscordConfigIni(homeDir, {
      botToken: "token",
      pairedUserIds: [userId],
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
      sessionStore.set(`guild_channel_1:sender:${userId}`, {
        channelUserId: userId,
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
        authStore: new DiscordAuthStore(),
        client,
        config: { botToken: "token", profileId: "default" },
        fixedWorkspaceId: "org_a",
        orgStore: createTestOrgStore(homeDir),
        sessionStore,
        threadStore: new ThreadStore(path.join(homeDir, "threads.json")),
      });
      const interaction = createSlashInteraction({
        commandName: "attach",
        userId,
      });
      await handler.handleSlashCommand(interaction.interaction);
      expect(authorize).toHaveBeenCalledWith({
        channel: "discord",
        channelAddressed: true,
        channelChatId: "guild_channel_1",
        channelIsGroup: true,
        channelThreadId: undefined,
        channelUserId: userId,
        intent: "read",
        profileId: "default",
        sessionId: "session_test",
      });
      expect(
        calls.readProfileArtifactContent +
          calls.publishProfileArtifactShare +
          calls.listProfileArtifacts
      ).toBe(0);
      expect(interaction.fileSendCalls).toBe(0);
      expect(interaction.replies.join("\n")).not.toContain(
        "https://private.example/secret"
      );
    } finally {
      authorize.mockRestore();
    }
  });
});

test("Discord /close leaves thread ownership and archive state intact when current principal cannot invoke", async () => {
  await withTempHome(async (homeDir) => {
    const userId = identities[0].userId;
    await writeDiscordConfigIni(homeDir, {
      botToken: "token",
      pairedUserIds: [userId],
    });
    const { client } = createMockClient();
    const authorize = spyOn(
      client,
      "authorizeChannelPrincipal"
    ).mockRejectedValue(new Error("Principal cannot invoke"));
    try {
      const threadStore = new ThreadStore(path.join(homeDir, "threads.json"));
      threadStore.add("thread_1");
      const handler = createChatHandler({
        authStore: new DiscordAuthStore(),
        client,
        config: { botToken: "token", profileId: "default" },
        fixedWorkspaceId: "org_a",
        orgStore: createTestOrgStore(homeDir),
        sessionStore: new SessionStore(path.join(homeDir, "sessions.json")),
        threadStore,
      });
      const close = createSlashInteraction({
        commandName: "close",
        inThread: true,
        userId,
      });
      await handler.handleSlashCommand(close.interaction);
      expect(authorize).toHaveBeenCalledWith({
        channel: "discord",
        channelAddressed: true,
        channelChatId: "guild_channel_1",
        channelIsGroup: true,
        channelThreadId: "thread_1",
        channelUserId: userId,
        intent: "invoke",
        profileId: undefined,
        sessionId: undefined,
      });
      expect(threadStore.hasThreadId("thread_1")).toBe(true);
      expect(
        (close.interaction.channel as { archived?: boolean }).archived
      ).toBe(false);
    } finally {
      authorize.mockRestore();
    }
  });
});

for (const inThread of [false, true]) {
  test(`Discord rejects canonical principal before ${inThread ? "claiming" : "creating"} a guild thread`, async () => {
    await withTempHome(async (homeDir) => {
      const userId = identities[0].userId;
      await writeDiscordConfigIni(homeDir, {
        botToken: "token",
        pairedUserIds: [userId],
      });
      const { client, calls } = createMockClient();
      const authorize = spyOn(
        client,
        "authorizeChannelPrincipal"
      ).mockRejectedValue(new Error("Principal cannot invoke"));
      try {
        const threadStore = new ThreadStore(path.join(homeDir, "threads.json"));
        const handler = createChatHandler({
          authStore: new DiscordAuthStore(),
          client,
          config: { botToken: "token", profileId: "default" },
          fixedWorkspaceId: "org_a",
          orgStore: createTestOrgStore(homeDir),
          sessionStore: new SessionStore(path.join(homeDir, "sessions.json")),
          threadStore,
        });
        const message = createGuildChatMessage({
          content: "<@bot_id> hello",
          inThread,
          mentionsBot: true,
          userId,
        });
        await handler.handleMessage(message.message);
        expect(authorize).toHaveBeenCalledWith({
          channel: "discord",
          channelAddressed: true,
          channelChatId: "guild_channel_1",
          channelIsGroup: true,
          channelThreadId: inThread ? "thread_1" : undefined,
          channelUserId: userId,
          intent: "invoke",
          profileId: "default",
        });
        expect(threadStore.hasThreadId("thread_1")).toBe(false);
        expect(message.startThreadCalls).toBe(0);
        expect(calls.createSession + calls.sendStream).toBe(0);
      } finally {
        authorize.mockRestore();
      }
    });
  });
}

test("Discord does not emit a cached share URL when delivery authorization is revoked after the turn", async () => {
  await withTempHome(async (homeDir) => {
    await writeDiscordConfigIni(homeDir, {
      botToken: "token",
      pairedUserIds: [identities[0].userId],
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
      sessionStore.set("dm_channel_1", {
        artifactShareUrls: { "secret.pdf": "https://private.example/secret" },
        channelUserId: identities[0].userId,
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      const handler = createChatHandler({
        authStore: new DiscordAuthStore(),
        client,
        config: { botToken: "token", profileId: "default" },
        fixedWorkspaceId: "org_a",
        orgStore: createTestOrgStore(homeDir),
        sessionStore,
        threadStore: new ThreadStore(path.join(homeDir, "threads.json")),
      });
      const message = createDmMessage({
        content: "continue",
        userId: identities[0].userId,
      });
      await handler.handleMessage(message.message);
      expect(calls.sendStream).toBe(1);
      expect(authorize).toHaveBeenCalledWith({
        channel: "discord",
        channelAddressed: true,
        channelChatId: "dm_channel_1",
        channelIsGroup: false,
        channelThreadId: undefined,
        channelUserId: identities[0].userId,
        intent: "read",
        profileId: "default",
        sessionId: "session_test",
      });
      expect(
        calls.readProfileArtifactContent + calls.publishProfileArtifactShare
      ).toBe(0);
      expect(message.fileSendCalls).toBe(0);
      expect(message.sentMessages.join("\n")).not.toContain(
        "https://private.example/secret"
      );
    } finally {
      authorize.mockRestore();
    }
  });
});

test("Discord does not persist source bytes if authorization is revoked during download", async () => {
  await withTempHome(async (homeDir) => {
    await writeDiscordConfigIni(homeDir, {
      botToken: "token",
      pairedUserIds: [identities[0].userId],
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
      Object.assign(async () => new Response(bytes), {
        preconnect: fetch.preconnect,
      })
    );
    try {
      const handler = createChatHandler({
        authStore: new DiscordAuthStore(),
        client,
        config: { botToken: "token", profileId: "default" },
        fixedWorkspaceId: "org_a",
        orgStore: createTestOrgStore(homeDir),
        sessionStore: new SessionStore(path.join(homeDir, "sessions.json")),
        threadStore: new ThreadStore(path.join(homeDir, "threads.json")),
      });
      const message = createDmMessage({
        attachments: [
          {
            contentType: "application/pdf",
            name: "source.pdf",
            size: bytes.length,
            url: "https://cdn.discordapp.com/attachments/1/2/source.pdf",
          },
        ],
        userId: identities[0].userId,
      });
      await handler.handleMessage(message.message);
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

test("Discord /allow sends requester identity to the scoped authority and does not mutate config when it denies", async () => {
  await withTempHome(async (homeDir) => {
    const userId = identities[0].userId;
    for (const orgId of ["org_a", "org_b"]) {
      await writeDiscordConfigIni(homeDir, {
        botToken: `${orgId}-token`,
        orgId,
        pairedUserIds: [userId],
      });
    }
    const { client } = createMockClient();
    const addAllowed = spyOn(client, "addDiscordAllowedUser").mockRejectedValue(
      new Error("Current org admin required")
    );
    const setOrgId = spyOn(client, "setOrgId");
    try {
      const handler = createChatHandler({
        authStore: new DiscordAuthStore("org_a"),
        client,
        config: { botToken: "org_a-token", profileId: "default" },
        fixedWorkspaceId: "org_a",
        orgStore: createTestOrgStore(homeDir),
        sessionStore: new SessionStore(path.join(homeDir, "sessions.json")),
        threadStore: new ThreadStore(path.join(homeDir, "threads.json")),
      });
      const allow = createSlashInteraction({
        commandName: "allow",
        userId,
        userOption: { id: identities[1].userId },
      });
      await handler.handleSlashCommand(allow.interaction);
      expect(setOrgId).toHaveBeenCalledWith("org_a");
      expect(addAllowed).toHaveBeenCalledWith({
        requesterChannelUserId: userId,
        targetChannelUserId: identities[1].userId,
      });
      const { loadDiscordConfigFile } = await import(
        "@atlas/core/discord-config"
      );
      expect((await loadDiscordConfigFile("org_a"))?.allowedUserIds).toEqual(
        []
      );
      expect((await loadDiscordConfigFile("org_b"))?.allowedUserIds).toEqual(
        []
      );
      expect(await loadDiscordConfigFile(null)).toBeNull();
    } finally {
      addAllowed.mockRestore();
      setOrgId.mockRestore();
    }
  });
});

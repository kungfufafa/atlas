import { beforeEach, expect, spyOn, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@atlas/client";
import {
  createWorkspaceWorkerAuthToken,
  isChannelGuestUserId,
  resolveLocalAuthToken,
} from "@atlas/core";
import type { ChannelAccessMode } from "@atlas/core/contract";
import { MAX_DOCUMENT_BYTES } from "@atlas/core/message-content";
import { createSqliteDatabase } from "@atlas/db";
import { createMinimalHonoApp } from "../../../server/src/http/test-app-helpers";
import { AgentService } from "../../../server/src/services/agent-service";
import { DiscordAuthStore } from "../../discord/src/auth-store";
import {
  createChatHandler as createDiscordHandler,
  resetChatLocksForTests as resetDiscordLocks,
  resolveDiscordSessionKey,
} from "../../discord/src/chat-handler";
import { SessionStore as DiscordSessionStore } from "../../discord/src/session-store";
import {
  createTestOrgStore as createDiscordOrgStore,
  createDmMessage,
  createSlashInteraction,
  writeDiscordConfigIni,
} from "../../discord/src/test-helpers";
import { ThreadStore } from "../../discord/src/thread-store";
import { TelegramAuthStore } from "./auth-store";
import {
  createChatHandler,
  resetChatLocksForTests,
  resolveTelegramSessionKey,
} from "./chat-handler";
import { SessionStore } from "./session-store";
import {
  createMessageContext,
  createTestOrgStore,
  TEST_BOT_INFO,
  withTempHome,
  writeTelegramConfigIni,
} from "./test-helpers";

const ORG_ID = "org_channel_matrix";
const PROFILE_ID = "profile_channel_matrix";
const ACTORS = [
  "admin",
  "member",
  "viewer",
  "removed",
  "guest",
  "blocked",
] as const;
type Actor = (typeof ACTORS)[number];
type Channel = "telegram" | "discord";
const DISCORD_SENDER = "424242424242424242";

beforeEach(() => {
  resetChatLocksForTests();
  resetDiscordLocks();
});

async function withHarness(
  input: {
    channel: Channel;
    accessMode: ChannelAccessMode;
    actor: Actor;
    group: boolean;
  },
  run: (harness: Awaited<ReturnType<typeof createHarness>>) => Promise<void>
) {
  await withTempHome(async (homeDir) => {
    const harness = await createHarness(homeDir, input);
    try {
      await run(harness);
    } finally {
      harness.database.close();
    }
  });
}

async function createHarness(
  homeDir: string,
  input: {
    channel: Channel;
    accessMode: ChannelAccessMode;
    actor: Actor;
    group: boolean;
  }
) {
  const database = await createSqliteDatabase(":memory:");
  const db = database.adapter;
  const now = new Date().toISOString();
  await db.upsertOrganization({
    createdAt: now,
    id: ORG_ID,
    name: "Channel Matrix",
    slug: "channel-matrix",
    updatedAt: now,
  });
  await db.upsertProfile({
    createdAt: now,
    id: PROFILE_ID,
    isDefault: true,
    isSuper: false,
    model: null,
    name: "Assistant",
    orgId: ORG_ID,
    systemPrompt: "",
    updatedAt: now,
  });
  const channelUserId = input.channel === "telegram" ? "42" : DISCORD_SENDER;
  if (input.actor !== "guest") {
    await db.createUser({
      createdAt: now,
      email: "channel-user@example.test",
      id: "matrix_user",
      isPlatformAdmin: false,
      name: "Channel User",
      passwordHash: "!disabled!",
      updatedAt: now,
    });
    if (input.actor !== "removed") {
      await db.upsertOrgMember({
        createdAt: now,
        orgId: ORG_ID,
        role: input.actor === "blocked" ? "member" : input.actor,
        userId: "matrix_user",
      });
    }
    await db.upsertChannelOrgMapping({
      channel: input.channel,
      channelUserId,
      createdAt: now,
      orgId: ORG_ID,
      userId: "matrix_user",
    });
  }
  const paired = input.actor !== "guest" && input.actor !== "blocked";
  if (input.channel === "telegram") {
    await writeTelegramConfigIni(homeDir, {
      accessMode: input.accessMode,
      allowedUserIds: input.actor === "blocked" ? [] : [42],
      blockedUserIds: input.actor === "blocked" ? [42] : [],
      botToken: "telegram-token",
      orgId: ORG_ID,
      pairedUserIds: paired ? [42] : [],
      profileId: PROFILE_ID,
    });
  } else {
    await writeDiscordConfigIni(homeDir, {
      accessMode: input.accessMode,
      allowedUserIds: input.actor === "blocked" ? [] : [DISCORD_SENDER],
      blockedUserIds: input.actor === "blocked" ? [DISCORD_SENDER] : [],
      botToken: "discord-token",
      orgId: ORG_ID,
      pairedUserIds: paired ? [DISCORD_SENDER] : [],
      profileId: PROFILE_ID,
    });
  }
  const agent = new AgentService(null, null, db);
  const { app } = createMinimalHonoApp({ agent, databaseAdapter: db });
  const requests: Array<{ path: string; status: number }> = [];
  const client = createClient({
    authToken: await createWorkspaceWorkerAuthToken({
      channel: input.channel,
      orgId: ORG_ID,
    }),
    baseUrl: "http://localhost:4310",
    fetch: (async (url, init) => {
      const request = new Request(url, init);
      const response = await app.fetch(request);
      requests.push({
        path: new URL(request.url).pathname,
        status: response.status,
      });
      return response;
    }) as typeof fetch,
    orgId: ORG_ID,
    tokenAuth: true,
  });
  const telegramStore = new SessionStore(
    path.join(homeDir, "telegram-sessions.json")
  );
  const discordStore = new DiscordSessionStore(
    path.join(homeDir, "discord-sessions.json")
  );
  const telegramHandler = createChatHandler({
    authStore: new TelegramAuthStore(ORG_ID),
    client,
    config: { botToken: "telegram-token", profileId: PROFILE_ID },
    fixedWorkspaceId: ORG_ID,
    getBotInfo: () => TEST_BOT_INFO,
    orgStore: createTestOrgStore(homeDir),
    sessionStore: telegramStore,
  });
  const discordHandler = createDiscordHandler({
    authStore: new DiscordAuthStore(ORG_ID),
    client,
    config: { botToken: "discord-token", profileId: PROFILE_ID },
    fixedWorkspaceId: ORG_ID,
    orgStore: createDiscordOrgStore(homeDir),
    sessionStore: discordStore,
    threadStore: new ThreadStore(path.join(homeDir, "threads.json")),
  });
  const sessionStore =
    input.channel === "telegram" ? telegramStore : discordStore;
  const conversationKey =
    input.channel === "telegram"
      ? input.group
        ? "-100"
        : "42"
      : input.group
        ? "guild_channel_1"
        : "dm_channel_1";
  const sessionKey =
    input.channel === "telegram"
      ? resolveTelegramSessionKey(conversationKey, channelUserId, input.group)
      : resolveDiscordSessionKey(conversationKey, channelUserId, input.group);
  let downloads = 0;
  const replies: string[] = [];
  const sentFileBytes: Buffer[] = [];
  async function command(name: "new" | "attach") {
    const before = sentFileBytes.length;
    if (input.channel === "telegram") {
      const message = createMessageContext({
        chatId: input.group ? -100 : 42,
        chatType: input.group ? "supergroup" : "private",
        text: `/${name}${input.group ? "@mybot" : ""}`,
        userId: 42,
      });
      Object.assign(message.ctx.api, {
        sendDocument: async (
          _chatId: unknown,
          file: { fileData: Uint8Array }
        ) => {
          sentFileBytes.push(Buffer.from(file.fileData));
          return { message_id: 1 };
        },
      });
      await telegramHandler(message.ctx);
      replies.push(...message.replies);
      return sentFileBytes.length - before;
    }
    const message = createSlashInteraction({
      channelId: conversationKey,
      commandName: name,
      userId: DISCORD_SENDER,
    });
    Object.assign(message.interaction.channel!, {
      isDMBased: () => !input.group,
      send: async (payload: { files: Array<{ attachment: Buffer }> }) => {
        for (const file of payload.files) {
          sentFileBytes.push(Buffer.from(file.attachment));
        }
        return { id: "file_sent" };
      },
    });
    await discordHandler.handleSlashCommand(message.interaction);
    replies.push(...message.replies);
    return sentFileBytes.length - before;
  }
  async function pair(code: string) {
    if (input.channel === "telegram") {
      const message = createMessageContext({ text: code, userId: 42 });
      await telegramHandler(message.ctx);
    } else {
      const message = createDmMessage({
        content: code,
        userId: DISCORD_SENDER,
      });
      await discordHandler.handleMessage(message.message);
    }
  }
  async function allow(targetChannelUserId: string) {
    const interaction = createSlashInteraction({
      commandName: "allow",
      userId: DISCORD_SENDER,
      userOption: { id: targetChannelUserId },
    });
    await discordHandler.handleSlashCommand(interaction.interaction);
    replies.push(...interaction.replies);
  }
  async function profile(selection: string) {
    if (input.channel === "telegram") {
      const message = createMessageContext({
        text: `/profile ${selection}`,
        userId: 42,
      });
      await telegramHandler(message.ctx);
      replies.push(...message.replies);
    } else {
      const message = createDmMessage({
        content: `/profile ${selection}`,
        userId: DISCORD_SENDER,
      });
      await discordHandler.handleMessage(message.message);
      replies.push(...message.sentMessages);
    }
  }
  async function document() {
    const bytes = Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 32);
    const download = spyOn(globalThis, "fetch").mockImplementation(
      Object.assign(
        async () => {
          downloads += 1;
          return new Response(bytes);
        },
        { preconnect() {} }
      )
    );
    try {
      if (input.channel === "telegram") {
        const message = createMessageContext({
          chatId: input.group ? -100 : 42,
          chatType: input.group ? "supergroup" : "private",
          replyToBot: input.group,
          userId: 42,
        });
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
          token: "telegram-token",
        });
        await telegramHandler(message.ctx);
      } else {
        const message = createDmMessage({
          attachments: [
            {
              contentType: "application/pdf",
              name: "source.pdf",
              size: bytes.length,
              url: "https://cdn.discordapp.com/attachments/1/2/source.pdf",
            },
          ],
          channelId: conversationKey,
          userId: DISCORD_SENDER,
        });
        await discordHandler.handleMessage(message.message);
      }
    } finally {
      download.mockRestore();
    }
  }
  return {
    agent,
    allow,
    channelUserId,
    client,
    command,
    database,
    db,
    document,
    downloads: () => downloads,
    homeDir,
    pair,
    profile,
    replies,
    requests,
    sentFileBytes,
    sessionKey,
    sessionStore,
  };
}

for (const channel of ["telegram", "discord"] as const) {
  for (const accessMode of [
    "pairing",
    "allowlist",
    "denylist",
    "open",
  ] as const) {
    for (const group of [false, true]) {
      for (const actor of ACTORS) {
        test(`${channel} real handler→HTTP→SQLite: ${accessMode} / ${group ? "group" : "DM"} / ${actor}`, async () => {
          await withHarness(
            { accessMode, actor, channel, group },
            async (harness) => {
              await harness.command("new");
              const allowed =
                (actor !== "blocked" || accessMode === "open") &&
                actor !== "viewer" &&
                actor !== "removed";
              const session = harness.sessionStore.get(harness.sessionKey);
              expect(Boolean(session)).toBe(allowed);
              expect(harness.downloads()).toBe(0);
              if (session) {
                const persisted = await harness.db.getSession(
                  session.sessionId
                );
                expect(persisted?.orgId).toBe(ORG_ID);
                expect(persisted?.profileId).toBe(PROFILE_ID);
                expect(
                  actor === "guest"
                    ? isChannelGuestUserId(persisted?.userId)
                    : persisted?.userId === "matrix_user"
                ).toBe(true);
              }
            }
          );
        });
      }
    }
  }
  test(`${channel} real current viewer downgrade blocks cached document persistence before download`, async () => {
    await withHarness(
      { accessMode: "pairing", actor: "member", channel, group: false },
      async (harness) => {
        await harness.command("new");
        expect(harness.sessionStore.get(harness.sessionKey)).toBeDefined();
        await harness.db.upsertOrgMember({
          createdAt: new Date().toISOString(),
          orgId: ORG_ID,
          role: "viewer",
          userId: "matrix_user",
        });
        await harness.document();
        expect(harness.downloads()).toBe(0);
        expect(
          harness.requests.map(({ path, status }) => ({ path, status }))
        ).toContainEqual({
          path:
            channel === "discord"
              ? "/v1/channel-actions/context"
              : "/v1/channel-principals/authorize",
          status: 403,
        });
        expect(
          await readdir(
            path.join(
              harness.homeDir,
              ".atlas",
              "orgs",
              ORG_ID,
              "profiles",
              PROFILE_ID,
              "artifacts"
            )
          ).catch(() => [])
        ).toEqual([]);
      }
    );
  });
}

for (const channel of ["telegram", "discord"] as const) {
  for (const selection of [
    "Support Agent",
    "profile_own_named",
    "Foreign Only",
  ]) {
    test(`${channel} fixed workspace /profile ${selection} resolves only the current tenant`, async () => {
      await withHarness(
        { accessMode: "pairing", actor: "member", channel, group: false },
        async (harness) => {
          const now = new Date().toISOString();
          await harness.db.upsertOrganization({
            createdAt: now,
            id: "org_foreign",
            name: "Foreign",
            slug: "foreign",
            updatedAt: now,
          });
          for (const [id, orgId, name] of [
            ["profile_own_named", ORG_ID, "Support Agent"],
            ["profile_foreign", "org_foreign", "Foreign Only"],
          ]) {
            await harness.db.upsertProfile({
              createdAt: now,
              id: id!,
              isDefault: false,
              isSuper: false,
              model: null,
              name: name!,
              orgId: orgId!,
              systemPrompt: "",
              updatedAt: now,
            });
          }
          await harness.profile(selection);
          const session = harness.sessionStore.get(harness.sessionKey);
          expect(session?.profileId).toBe(
            selection === "Foreign Only" ? undefined : "profile_own_named"
          );
          if (session) {
            expect(
              (await harness.db.getSession(session.sessionId))?.orgId
            ).toBe(ORG_ID);
          }
        }
      );
    });
  }
  for (const scope of ["own", "other user", "other org"] as const) {
    test(`${channel} /attach real HTTP authorizes ${scope} cached session before releasing bytes`, async () => {
      await withHarness(
        { accessMode: "pairing", actor: "member", channel, group: false },
        async (harness) => {
          await harness.command("new");
          const stored = harness.sessionStore.get(harness.sessionKey)!;
          const persisted = (await harness.db.getSession(stored.sessionId))!;
          const now = new Date().toISOString();
          const bytes = Buffer.from("%PDF-1.4\nTENANT-A-PRIVATE-CONTENT\n");
          const artifactDir = path.join(
            harness.homeDir,
            ".atlas",
            "orgs",
            ORG_ID,
            "profiles",
            PROFILE_ID,
            "artifacts"
          );
          await mkdir(artifactDir, { recursive: true });
          await writeFile(path.join(artifactDir, "private.pdf"), bytes);
          await harness.db.replaceMessagesForSession(stored.sessionId, [
            {
              createdAt: now,
              id: "write",
              payload: {
                content: "",
                role: "assistant",
                toolCalls: [
                  {
                    arguments: {
                      content: bytes.toString(),
                      path: "artifacts/private.pdf",
                    },
                    id: "write_artifact",
                    name: "write_file",
                  },
                ],
              },
              seq: 0,
              sessionId: stored.sessionId,
            },
            {
              createdAt: now,
              id: "result",
              payload: {
                content: JSON.stringify({
                  bytesWritten: bytes.length,
                  path: "artifacts/private.pdf",
                }),
                name: "write_file",
                role: "tool",
                toolCallId: "write_artifact",
              },
              seq: 1,
              sessionId: stored.sessionId,
            },
          ]);
          harness.sessionStore.set(harness.sessionKey, {
            ...stored,
            deliverableArtifacts: [
              {
                filename: "private.pdf",
                mimeType: "application/pdf",
                path: "private.pdf",
                savedAt: now,
                sharePath: null,
                shareUrl: null,
                sizeBytes: bytes.length,
              },
            ],
          });
          if (scope === "other user") {
            await harness.db.createUser({
              createdAt: now,
              email: "other@example.test",
              id: "other_user",
              isPlatformAdmin: false,
              name: "Other",
              passwordHash: "!disabled!",
              updatedAt: now,
            });
            await harness.db.upsertOrgMember({
              createdAt: now,
              orgId: ORG_ID,
              role: "member",
              userId: "other_user",
            });
            await harness.db.upsertSession({
              ...persisted,
              userId: "other_user",
            });
          }
          if (scope === "other org") {
            await harness.db.upsertOrganization({
              createdAt: now,
              id: "org_foreign",
              name: "Foreign",
              slug: "foreign",
              updatedAt: now,
            });
            await harness.db.upsertSession({
              ...persisted,
              orgId: "org_foreign",
            });
          }
          await harness.command("attach");
          if (scope === "own") {
            expect(harness.sentFileBytes).toEqual([bytes]);
            expect(
              await readFile(path.join(artifactDir, "private.pdf"))
            ).toEqual(bytes);
          } else {
            expect(harness.sentFileBytes).toEqual([]);
            expect(
              harness.requests.some((request) =>
                request.path.endsWith("/artifacts/content")
              )
            ).toBe(false);
            expect(
              harness.requests.some(
                (request) =>
                  request.path === "/v1/channel-principals/authorize" &&
                  request.status === 404
              )
            ).toBe(true);
          }
        }
      );
    });
  }
}

for (const accessMode of [
  "pairing",
  "allowlist",
  "denylist",
  "open",
] as const) {
  for (const actor of ACTORS) {
    test(`Discord /allow real canonical role: ${accessMode} / ${actor}`, async () => {
      await withHarness(
        { accessMode, actor, channel: "discord", group: false },
        async (harness) => {
          const targetId = "777777777777777777";
          await harness.allow(targetId);
          const { loadDiscordConfigFile } = await import(
            "@atlas/core/discord-config"
          );
          expect(
            (await loadDiscordConfigFile(ORG_ID))?.allowedUserIds.includes(
              targetId
            )
          ).toBe(actor === "admin");
          expect(await loadDiscordConfigFile(null)).toBeNull();
          if (actor === "admin") {
            expect(
              harness.requests.some(
                (request) =>
                  request.path === "/v1/channels/discord/allowed-users" &&
                  request.status === 200
              )
            ).toBe(true);
          }
          if (actor === "member" || actor === "viewer" || actor === "removed") {
            expect(
              harness.requests.some(
                (request) =>
                  request.path === "/v1/channels/discord/allowed-users" &&
                  request.status === 403
              )
            ).toBe(true);
          }
        }
      );
    });
  }
}

for (const channel of ["telegram", "discord"] as const) {
  test(`${channel} legacy local credentials cannot release cached channel artifact bytes`, async () => {
    await withHarness(
      { accessMode: "pairing", actor: "member", channel, group: false },
      async (harness) => {
        await harness.command("new");
        const stored = harness.sessionStore.get(harness.sessionKey)!;
        harness.sessionStore.set(harness.sessionKey, {
          ...stored,
          deliverableArtifacts: [
            {
              filename: "private.pdf",
              mimeType: "application/pdf",
              path: "private.pdf",
              savedAt: new Date().toISOString(),
              sharePath: null,
              shareUrl: null,
              sizeBytes: 100,
            },
          ],
        });
        harness.client.setAuthToken(await resolveLocalAuthToken());
        await harness.command("attach");
        expect(harness.sentFileBytes).toEqual([]);
        expect(
          harness.requests.some((request) =>
            request.path.endsWith("/artifacts/content")
          )
        ).toBe(false);
        expect(
          harness.requests.some(
            (request) =>
              request.path === "/v1/channel-principals/authorize" &&
              request.status === 403
          )
        ).toBe(true);
      }
    );
  });
}

for (const channel of ["telegram", "discord"] as const) {
  test(`${channel} blocked sender cannot consume a valid pairing code or bind its issuer`, async () => {
    await withHarness(
      { accessMode: "denylist", actor: "blocked", channel, group: false },
      async (harness) => {
        const now = new Date().toISOString();
        await harness.db.createUser({
          createdAt: now,
          email: "issuer@example.test",
          id: "issuer",
          isPlatformAdmin: false,
          name: "Issuer",
          passwordHash: "!disabled!",
          updatedAt: now,
        });
        await harness.db.upsertOrgMember({
          createdAt: now,
          orgId: ORG_ID,
          role: "admin",
          userId: "issuer",
        });
        const assertion =
          await harness.agent.identityService.issuePairingAssertion({
            channel,
            orgId: ORG_ID,
            userId: "issuer",
          });
        const code = "AB12CD34";
        if (channel === "telegram") {
          await writeTelegramConfigIni(harness.homeDir, {
            accessMode: "denylist",
            blockedUserIds: [42],
            botToken: "telegram-token",
            handshakeAssertion: assertion,
            handshakeCode: code,
            handshakeUserId: "issuer",
            orgId: ORG_ID,
            profileId: PROFILE_ID,
          });
        } else {
          await writeDiscordConfigIni(harness.homeDir, {
            accessMode: "denylist",
            blockedUserIds: [DISCORD_SENDER],
            botToken: "discord-token",
            handshakeAssertion: assertion,
            handshakeCode: code,
            handshakeUserId: "issuer",
            orgId: ORG_ID,
            profileId: PROFILE_ID,
          });
        }
        await harness.pair(code);
        expect(
          harness.requests.some(
            (request) => request.path === "/v1/channel-principals"
          )
        ).toBe(false);
        expect(
          (
            await harness.db.getChannelOrgMapping(
              ORG_ID,
              channel,
              harness.channelUserId
            )
          )?.userId
        ).toBe("matrix_user");
        const config =
          channel === "telegram"
            ? await (
                await import("@atlas/core/telegram-config")
              ).loadTelegramConfigFile(ORG_ID)
            : await (
                await import("@atlas/core/discord-config")
              ).loadDiscordConfigFile(ORG_ID);
        expect(config?.handshakeCode).toBe(code);
        expect(config?.pairedUserIds).toEqual([]);
      }
    );
  });
}

for (const channel of ["telegram", "discord"] as const) {
  test(`${channel} direct worker pairing denies blocked sender without consuming issuer assertion`, async () => {
    await withHarness(
      { accessMode: "denylist", actor: "blocked", channel, group: false },
      async (harness) => {
        const now = new Date().toISOString();
        await harness.db.createUser({
          createdAt: now,
          email: "issuer@example.test",
          id: "issuer",
          isPlatformAdmin: false,
          name: "Issuer",
          passwordHash: "!disabled!",
          updatedAt: now,
        });
        await harness.db.upsertOrgMember({
          createdAt: now,
          orgId: ORG_ID,
          role: "admin",
          userId: "issuer",
        });
        const assertion =
          await harness.agent.identityService.issuePairingAssertion({
            channel,
            orgId: ORG_ID,
            userId: "issuer",
          });
        const input = {
          channel,
          channelUserId: harness.channelUserId,
          expectedUserId: "issuer",
          pairingAssertion: assertion,
        };
        await expect(
          harness.client.bindChannelPrincipal(input)
        ).rejects.toMatchObject({ status: 403 });
        expect(
          (
            await harness.db.getChannelOrgMapping(
              ORG_ID,
              channel,
              harness.channelUserId
            )
          )?.userId
        ).toBe("matrix_user");
        if (channel === "telegram") {
          await writeTelegramConfigIni(harness.homeDir, {
            accessMode: "pairing",
            botToken: "telegram-token",
            orgId: ORG_ID,
          });
        } else {
          await writeDiscordConfigIni(harness.homeDir, {
            accessMode: "pairing",
            botToken: "discord-token",
            orgId: ORG_ID,
          });
        }
        expect(await harness.client.bindChannelPrincipal(input)).toEqual({
          orgId: ORG_ID,
          userId: "issuer",
        });
        expect(
          (
            await harness.db.getChannelOrgMapping(
              ORG_ID,
              channel,
              harness.channelUserId
            )
          )?.userId
        ).toBe("issuer");
      }
    );
  });
}

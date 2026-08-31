import { afterEach, describe, expect, spyOn, test } from "bun:test";
import path from "node:path";
import type { ChatMessage } from "@atlas/core/contract";
import { loadDiscordConfigFile } from "@atlas/core/discord-config";
import { ATTACH_COMMAND_WITH_FILE_REPLY } from "./attachments";
import { DiscordAuthStore } from "./auth-store";
import {
  chatLockOptions,
  createChatHandler,
  getChatLockCountForTests,
  resetChatLocksForTests,
  withChatLock,
} from "./chat-handler";
import { SessionStore } from "./session-store";
import {
  createDmMessage,
  createGuildChatMessage,
  createMockClient,
  createMultiTestOrgs,
  createSlashInteraction,
  createTestOrgStore,
  withTempHome,
  writeDiscordConfigIni,
} from "./test-helpers";
import { ThreadStore } from "./thread-store";

afterEach(() => {
  resetChatLocksForTests();
  chatLockOptions.waitMs = 15 * 60 * 1000;
});

describe("createChatHandler guild auth silence", () => {
  test("unlinked guild mentions stay quiet", async () => {
    await withTempHome(async (homeDir) => {
      const { handleMessage, calls } = await createPairedHandler(homeDir, {
        pairedUserIds: [],
      });
      const mention = createGuildChatMessage({
        content: "<@bot_id> hello",
        mentionsBot: true,
        userId: "555555555555555555",
      });

      await handleMessage(mention.message);

      expect(mention.channelSentMessages).toEqual([]);
      expect(calls.sendStream).toBe(0);
    });
  });

  test("unlinked guild slash deletes its deferred reply", async () => {
    await withTempHome(async (homeDir) => {
      const { handleSlashCommand } = await createPairedHandler(homeDir, {
        pairedUserIds: [],
      });
      const status = createSlashInteraction({
        commandName: "status",
        userId: "555555555555555555",
      });

      await handleSlashCommand(status.interaction);

      expect(status.replies).toEqual(["__deleted__"]);
    });
  });

  test("reloads auth only after the conversation lock is available", async () => {
    await withTempHome(async (homeDir) => {
      const { authStore, handleMessage } = await createPairedHandler(homeDir);
      const dm = createDmMessage({
        channelId: "dm_auth_lock",
        content: "hello",
      });

      let releaseHold!: () => void;
      const hold = new Promise<void>((resolve) => {
        releaseHold = resolve;
      });
      const held = withChatLock(dm.message.channel.id, async () => {
        await hold;
      });

      const reloadCalls: number[] = [];
      const originalReload = authStore.reload.bind(authStore);
      authStore.reload = async () => {
        reloadCalls.push(Date.now());
        return originalReload();
      };

      const pending = handleMessage(dm.message);
      await Bun.sleep(20);
      expect(reloadCalls).toEqual([]);

      releaseHold();
      await held;
      await pending;
      expect(reloadCalls.length).toBeGreaterThanOrEqual(1);
    });
  });
});

/**
 * Same shape as the telegram suite's helper (chat-handler.test.ts). Prefer real
 * intervals over a tight spin: under CI's concurrent workspace load, session
 * I/O can take tens of ms before sendStream runs, and a 1ms poll competes with
 * the very work it is waiting for.
 */
async function waitForCondition(
  condition: () => boolean,
  message: string,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 2000;
  const intervalMs = options.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(message);
}

async function createPairedHandler(
  homeDir: string,
  options: {
    messages?: ChatMessage[];
    onSendStream?: Parameters<typeof createMockClient>[0]["onSendStream"];
    questionnaire?: Parameters<typeof createMockClient>[0]["questionnaire"];
    orgs?: Parameters<typeof createMockClient>[0]["orgs"];
    profiles?: Parameters<typeof createMockClient>[0]["profiles"];
    profilesByOrgId?: Parameters<typeof createMockClient>[0]["profilesByOrgId"];
    listedArtifacts?: Parameters<typeof createMockClient>[0]["listedArtifacts"];
    artifactContentBytes?: Parameters<
      typeof createMockClient
    >[0]["artifactContentBytes"];
    failPublishShare?: Parameters<
      typeof createMockClient
    >[0]["failPublishShare"];
    failReadArtifact?: Parameters<
      typeof createMockClient
    >[0]["failReadArtifact"];
    configProfileId?: string;
    pairedUserIds?: string[];
    allowedUserIds?: string[];
    fixedWorkspaceId?: string;
  } = {}
) {
  await writeDiscordConfigIni(homeDir, {
    allowedUserIds: options.allowedUserIds ?? [],
    botToken: "discord-bot-token",
    pairedUserIds: options.pairedUserIds ?? ["424242424242424242"],
  });

  const authStore = new DiscordAuthStore();
  await authStore.reload();
  const { client, calls, createdSessionProfileIds } = createMockClient(options);
  const sessionStore = new SessionStore(
    path.join(homeDir, ".atlas", "discord", "chat-sessions.json")
  );
  await sessionStore.load();
  const threadStore = new ThreadStore(
    path.join(homeDir, ".atlas", "discord", "chat-threads.json")
  );
  await threadStore.load();
  const orgStore = createTestOrgStore(homeDir);
  await orgStore.load();
  const handlers = createChatHandler({
    authStore,
    client,
    config: {
      botToken: "discord-bot-token",
      profileId: options.configProfileId ?? "default",
    },
    fixedWorkspaceId: options.fixedWorkspaceId,
    orgStore,
    sessionStore,
    threadStore,
  });

  return {
    ...handlers,
    authStore,
    calls,
    client,
    createdSessionProfileIds,
    orgStore,
    sessionStore,
    threadStore,
  };
}

describe("createChatHandler artifact delivery", () => {
  const metaJson = JSON.stringify({
    mimeType: "text/markdown",
    savedAt: "2026-07-13T10:00:00.000Z",
    sizeBytes: 42,
  });

  const artifactMessages: ChatMessage[] = [
    { content: "save report", role: "user" },
    {
      content: "",
      role: "assistant",
      toolCalls: [
        {
          arguments: { content: "# Report", path: "artifacts/report.md" },
          id: "tool_1",
          name: "write_file",
        },
        {
          arguments: {
            content: metaJson,
            path: "artifacts/report.md.atlas-meta.json",
          },
          id: "tool_2",
          name: "write_file",
        },
      ],
    },
    {
      content: JSON.stringify({
        bytesWritten: 8,
        path: "/home/.atlas/orgs/org/profiles/default/artifacts/report.md",
      }),
      name: "write_file",
      role: "tool",
      toolCallId: "tool_1",
    },
    {
      content: JSON.stringify({
        bytesWritten: metaJson.length,
        path: "/home/.atlas/orgs/org/profiles/default/artifacts/report.md.atlas-meta.json",
      }),
      name: "write_file",
      role: "tool",
      toolCallId: "tool_2",
    },
    { content: "Saved the report.", role: "assistant" },
  ];

  test("auto-uploads a small artifact after a paired save-artifact turn", async () => {
    await withTempHome(async (homeDir) => {
      const { handleMessage, calls, sessionStore } = await createPairedHandler(
        homeDir,
        {
          messages: artifactMessages,
        }
      );
      sessionStore.set("dm_channel_1", {
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();

      const dm = createDmMessage({
        content: "thanks",
        userId: "424242424242424242",
      });
      await handleMessage(dm.message);

      expect(calls.publishProfileArtifactShare).toBe(1);
      expect(calls.readProfileArtifactContent).toBe(1);
      expect(dm.fileSendCalls).toBe(1);
      expect(
        dm.sentMessages.some((reply) =>
          reply.includes("https://app.example/s/tok_test")
        )
      ).toBe(true);
    });
  });

  test("sends an artifact emitted by the live agent stream", async () => {
    await withTempHome(async (homeDir) => {
      const { handleMessage, calls, sessionStore } = await createPairedHandler(
        homeDir,
        {
          artifactContentBytes: new TextEncoder().encode("%PDF-1.4"),
          messages: [],
          onSendStream: async (_input, handlers) => {
            handlers?.onArtifactCreated?.({
              createdAt: "2026-08-25T10:00:00.000Z",
              filename: "live-report.pdf",
              id: "artifact_live",
              mimeType: "application/pdf",
              path: "artifacts/live-report.pdf",
              size: 8,
              type: "pdf",
            });
            return "Report ready";
          },
        }
      );
      sessionStore.set("dm_channel_1", {
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();
      const dm = createDmMessage({
        content: "make a report",
        userId: "424242424242424242",
      });

      await handleMessage(dm.message);

      expect(calls.publishProfileArtifactShare).toBe(1);
      expect(calls.readProfileArtifactContent).toBe(1);
      expect(dm.fileSendCalls).toBe(1);
    });
  });

  test("still uploads the file when share publishing fails", async () => {
    await withTempHome(async (homeDir) => {
      const { handleMessage, calls, sessionStore } = await createPairedHandler(
        homeDir,
        {
          failPublishShare: true,
          messages: artifactMessages,
        }
      );
      sessionStore.set("dm_channel_1", {
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();

      const dm = createDmMessage({
        content: "thanks",
        userId: "424242424242424242",
      });
      await handleMessage(dm.message);

      expect(calls.publishProfileArtifactShare).toBe(1);
      expect(calls.readProfileArtifactContent).toBe(1);
      expect(dm.fileSendCalls).toBe(1);
      expect(
        dm.sentMessages.some((reply) =>
          reply.includes("https://app.example/s/tok_test")
        )
      ).toBe(false);
    });
  });

  test("tells the user when a saved artifact is too large and has no share link", async () => {
    await withTempHome(async (homeDir) => {
      const { handleMessage, calls, sessionStore } = await createPairedHandler(
        homeDir,
        {
          failPublishShare: true,
          messages: [
            { content: "save", role: "user" },
            {
              content: "",
              role: "assistant",
              toolCalls: [
                {
                  arguments: { content: "huge", path: "artifacts/huge.md" },
                  id: "tool_1",
                  name: "write_file",
                },
              ],
            },
            {
              content: JSON.stringify({
                bytesWritten: 9 * 1024 * 1024,
                path: "/home/.atlas/orgs/org/profiles/default/artifacts/huge.md",
              }),
              name: "write_file",
              role: "tool",
              toolCallId: "tool_1",
            },
          ],
        }
      );
      sessionStore.set("dm_channel_1", {
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();

      const dm = createDmMessage({
        content: "thanks",
        userId: "424242424242424242",
      });
      await handleMessage(dm.message);

      expect(calls.readProfileArtifactContent).toBe(0);
      expect(dm.fileSendCalls).toBe(0);
      expect(
        dm.sentMessages.some((reply) =>
          reply.includes("File is too large for Discord")
        )
      ).toBe(true);
    });
  });

  test("auto-uploads a PDF artifact after a paired save-artifact turn", async () => {
    await withTempHome(async (homeDir) => {
      const pdfMeta = JSON.stringify({
        mimeType: "application/pdf",
        savedAt: "2026-07-13T10:00:00.000Z",
        sizeBytes: 270_000,
      });
      const pdfMessages: ChatMessage[] = [
        { content: "save pitch deck", role: "user" },
        {
          content: "",
          role: "assistant",
          toolCalls: [
            {
              arguments: {
                content: "%PDF-1.4",
                path: "artifacts/atlas-pitch-deck.pdf",
              },
              id: "tool_1",
              name: "write_file",
            },
            {
              arguments: {
                content: pdfMeta,
                path: "artifacts/atlas-pitch-deck.pdf.atlas-meta.json",
              },
              id: "tool_2",
              name: "write_file",
            },
          ],
        },
        {
          content: JSON.stringify({
            bytesWritten: 270_000,
            path: "/home/.atlas/orgs/org/profiles/default/artifacts/atlas-pitch-deck.pdf",
          }),
          name: "write_file",
          role: "tool",
          toolCallId: "tool_1",
        },
        {
          content: JSON.stringify({
            bytesWritten: pdfMeta.length,
            path: "/home/.atlas/orgs/org/profiles/default/artifacts/atlas-pitch-deck.pdf.atlas-meta.json",
          }),
          name: "write_file",
          role: "tool",
          toolCallId: "tool_2",
        },
        { content: "Saved the pitch deck.", role: "assistant" },
      ];

      const { handleMessage, calls, sessionStore } = await createPairedHandler(
        homeDir,
        {
          artifactContentBytes: new TextEncoder().encode("%PDF-1.4"),
          messages: pdfMessages,
        }
      );
      sessionStore.set("dm_channel_1", {
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();

      const dm = createDmMessage({
        content: "thanks",
        userId: "424242424242424242",
      });
      await handleMessage(dm.message);

      expect(calls.publishProfileArtifactShare).toBe(1);
      expect(calls.readProfileArtifactContent).toBe(1);
      expect(dm.fileSendCalls).toBe(1);
    });
  });

  test("auto-uploads a CSV artifact after a paired save-artifact turn", async () => {
    await withTempHome(async (homeDir) => {
      const csvMeta = JSON.stringify({
        mimeType: "text/csv",
        savedAt: "2026-07-13T10:00:00.000Z",
        sizeBytes: 24,
      });
      const csvMessages: ChatMessage[] = [
        { content: "export csv", role: "user" },
        {
          content: "",
          role: "assistant",
          toolCalls: [
            {
              arguments: {
                content: "a,b\n1,2\n",
                path: "artifacts/export.csv",
              },
              id: "tool_1",
              name: "write_file",
            },
            {
              arguments: {
                content: csvMeta,
                path: "artifacts/export.csv.atlas-meta.json",
              },
              id: "tool_2",
              name: "write_file",
            },
          ],
        },
        {
          content: JSON.stringify({
            bytesWritten: 8,
            path: "/home/.atlas/orgs/org/profiles/default/artifacts/export.csv",
          }),
          name: "write_file",
          role: "tool",
          toolCallId: "tool_1",
        },
        {
          content: JSON.stringify({
            bytesWritten: csvMeta.length,
            path: "/home/.atlas/orgs/org/profiles/default/artifacts/export.csv.atlas-meta.json",
          }),
          name: "write_file",
          role: "tool",
          toolCallId: "tool_2",
        },
        { content: "Saved the CSV.", role: "assistant" },
      ];

      const { handleMessage, calls, sessionStore } = await createPairedHandler(
        homeDir,
        {
          artifactContentBytes: new TextEncoder().encode("a,b\n1,2\n"),
          messages: csvMessages,
        }
      );
      sessionStore.set("dm_channel_1", {
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();

      const dm = createDmMessage({
        content: "thanks",
        userId: "424242424242424242",
      });
      await handleMessage(dm.message);

      expect(calls.publishProfileArtifactShare).toBe(1);
      expect(calls.readProfileArtifactContent).toBe(1);
      expect(dm.fileSendCalls).toBe(1);
    });
  });

  test("falls back to a share link when the artifact exceeds the Discord attachment cap", async () => {
    await withTempHome(async (homeDir) => {
      const oversizedMeta = JSON.stringify({
        mimeType: "video/mp4",
        savedAt: "2026-07-13T10:00:00.000Z",
        sizeBytes: 9 * 1024 * 1024,
      });
      const oversizedMessages: ChatMessage[] = [
        { content: "save video", role: "user" },
        {
          content: "",
          role: "assistant",
          toolCalls: [
            {
              arguments: { content: "binary", path: "artifacts/clip.mp4" },
              id: "tool_1",
              name: "write_file",
            },
            {
              arguments: {
                content: oversizedMeta,
                path: "artifacts/clip.mp4.atlas-meta.json",
              },
              id: "tool_2",
              name: "write_file",
            },
          ],
        },
        {
          content: JSON.stringify({
            bytesWritten: 9 * 1024 * 1024,
            path: "/home/.atlas/orgs/org/profiles/default/artifacts/clip.mp4",
          }),
          name: "write_file",
          role: "tool",
          toolCallId: "tool_1",
        },
        {
          content: JSON.stringify({
            bytesWritten: oversizedMeta.length,
            path: "/home/.atlas/orgs/org/profiles/default/artifacts/clip.mp4.atlas-meta.json",
          }),
          name: "write_file",
          role: "tool",
          toolCallId: "tool_2",
        },
        { content: "Saved the clip.", role: "assistant" },
      ];

      const { handleMessage, calls, sessionStore } = await createPairedHandler(
        homeDir,
        {
          messages: oversizedMessages,
        }
      );
      sessionStore.set("dm_channel_1", {
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();

      const dm = createDmMessage({
        content: "thanks",
        userId: "424242424242424242",
      });
      await handleMessage(dm.message);

      expect(calls.publishProfileArtifactShare).toBe(1);
      expect(calls.readProfileArtifactContent).toBe(0);
      expect(dm.fileSendCalls).toBe(0);
      expect(
        dm.sentMessages.some((reply) =>
          reply.includes("https://app.example/s/tok_test")
        )
      ).toBe(true);
    });
  });

  test("publishes and sends when write_file saved an artifact without sidecar", async () => {
    await withTempHome(async (homeDir) => {
      const { handleMessage, calls, sessionStore } = await createPairedHandler(
        homeDir,
        {
          artifactContentBytes: new TextEncoder().encode("draft"),
          messages: [
            { content: "save", role: "user" },
            {
              content: "",
              role: "assistant",
              toolCalls: [
                {
                  arguments: { content: "draft", path: "artifacts/draft.md" },
                  id: "tool_1",
                  name: "write_file",
                },
              ],
            },
            {
              content: JSON.stringify({
                bytesWritten: 5,
                path: "/home/.atlas/orgs/org/profiles/default/artifacts/draft.md",
              }),
              name: "write_file",
              role: "tool",
              toolCallId: "tool_1",
            },
          ],
        }
      );
      sessionStore.set("dm_channel_1", {
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();

      const dm = createDmMessage({
        content: "thanks",
        userId: "424242424242424242",
      });
      await handleMessage(dm.message);

      expect(calls.publishProfileArtifactShare).toBe(1);
      expect(calls.readProfileArtifactContent).toBe(1);
      expect(dm.fileSendCalls).toBe(1);
      expect(
        dm.sentMessages.some((reply) =>
          reply.includes("https://app.example/s/tok_test")
        )
      ).toBe(true);
    });
  });

  test("publishes and sends a spreadsheet created in the turn", async () => {
    await withTempHome(async (homeDir) => {
      const { handleMessage, calls, sessionStore } = await createPairedHandler(
        homeDir,
        {
          artifactContentBytes: new TextEncoder().encode("xlsx-bytes"),
          messages: [
            { content: "make a sheet", role: "user" },
            {
              content: "",
              role: "assistant",
              toolCalls: [
                {
                  arguments: {
                    action: "create",
                    path: "artifacts/sales.xlsx",
                  },
                  id: "tool_1",
                  name: "spreadsheet",
                },
              ],
            },
            {
              content: JSON.stringify({
                path: "artifacts/sales.xlsx",
                status: "created",
              }),
              name: "spreadsheet",
              role: "tool",
              toolCallId: "tool_1",
            },
            { content: "Saved the sheet.", role: "assistant" },
          ],
        }
      );
      sessionStore.set("dm_channel_1", {
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();

      const dm = createDmMessage({
        content: "thanks",
        userId: "424242424242424242",
      });
      await handleMessage(dm.message);

      expect(calls.publishProfileArtifactShare).toBe(1);
      expect(calls.readProfileArtifactContent).toBe(1);
      expect(dm.fileSendCalls).toBe(1);
    });
  });

  test("does not publish when the turn wrote nothing under artifacts/", async () => {
    await withTempHome(async (homeDir) => {
      const { handleMessage, calls, sessionStore } = await createPairedHandler(
        homeDir,
        {
          messages: [
            { content: "hello", role: "user" },
            { content: "hi", role: "assistant" },
          ],
        }
      );
      sessionStore.set("dm_channel_1", {
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();

      const { message, sentMessages } = createDmMessage({
        content: "thanks",
        userId: "424242424242424242",
      });
      await handleMessage(message);

      expect(calls.publishProfileArtifactShare).toBe(0);
      expect(sentMessages.some((reply) => reply.includes("/s/"))).toBe(false);
    });
  });

  test("uploads when the agent calls send_discord_artifact", async () => {
    await withTempHome(async (homeDir) => {
      const { calls, handleMessage, sessionStore } = await createPairedHandler(
        homeDir,
        {
          artifactContentBytes: new TextEncoder().encode("%PDF-1.4"),
          onSendStream: async (_input, handlers) => {
            handlers?.onToolStart?.({
              input: { path: "atlas-pitch-deck.pdf" },
              tool: "send_discord_artifact",
              toolCallId: "tool_1",
            });
            handlers?.onToolEnd?.({
              result: {
                filename: "atlas-pitch-deck.pdf",
                mimeType: "application/pdf",
                ok: true,
                path: "atlas-pitch-deck.pdf",
                sizeBytes: 8,
              },
              tool: "send_discord_artifact",
              toolCallId: "tool_1",
            });
            handlers?.onChunk?.("Here's the pitch deck.");
            return "Here's the pitch deck.";
          },
        }
      );
      sessionStore.set("dm_channel_1", {
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();

      const dm = createDmMessage({
        content: "can you send the pitch deck pdf file to me",
        userId: "424242424242424242",
      });
      await handleMessage(dm.message);

      expect(calls.sendStream).toBe(1);
      expect(calls.readProfileArtifactContent).toBe(1);
      expect(dm.fileSendCalls).toBe(1);
      expect(dm.sentMessages.at(-1)).toBe("Here's the pitch deck.");
    });
  });

  test("does not upload the same file twice when write_file and send_discord_artifact run together", async () => {
    await withTempHome(async (homeDir) => {
      const { calls, handleMessage, sessionStore } = await createPairedHandler(
        homeDir,
        {
          artifactContentBytes: new TextEncoder().encode("%PDF-1.4"),
          messages: [
            { content: "make the deck", role: "user" },
            {
              content: "",
              role: "assistant",
              toolCalls: [
                {
                  arguments: {
                    content: "%PDF-1.4",
                    path: "artifacts/atlas-pitch-deck.pdf",
                  },
                  id: "tool_write",
                  name: "write_file",
                },
                {
                  arguments: { path: "artifacts/atlas-pitch-deck.pdf" },
                  id: "tool_send",
                  name: "send_discord_artifact",
                },
              ],
            },
            {
              content: JSON.stringify({
                bytesWritten: 8,
                path: "/home/.atlas/orgs/org/profiles/default/artifacts/atlas-pitch-deck.pdf",
              }),
              name: "write_file",
              role: "tool",
              toolCallId: "tool_write",
            },
            {
              content: JSON.stringify({
                filename: "atlas-pitch-deck.pdf",
                mimeType: "application/pdf",
                ok: true,
                path: "atlas-pitch-deck.pdf",
                sizeBytes: 8,
              }),
              name: "send_discord_artifact",
              role: "tool",
              toolCallId: "tool_send",
            },
          ],
          onSendStream: async (_input, handlers) => {
            handlers?.onToolStart?.({
              input: { path: "atlas-pitch-deck.pdf" },
              tool: "send_discord_artifact",
              toolCallId: "tool_send",
            });
            handlers?.onToolEnd?.({
              result: {
                filename: "atlas-pitch-deck.pdf",
                mimeType: "application/pdf",
                ok: true,
                path: "atlas-pitch-deck.pdf",
                sizeBytes: 8,
              },
              tool: "send_discord_artifact",
              toolCallId: "tool_send",
            });
            handlers?.onChunk?.("Here's the pitch deck.");
            return "Here's the pitch deck.";
          },
        }
      );
      sessionStore.set("dm_channel_1", {
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();

      const dm = createDmMessage({
        content: "make the deck and send it",
        userId: "424242424242424242",
      });
      await handleMessage(dm.message);

      expect(calls.sendStream).toBe(1);
      expect(calls.readProfileArtifactContent).toBe(1);
      expect(dm.fileSendCalls).toBe(1);
    });
  });

  test("typed /attach still sends without an agent turn", async () => {
    await withTempHome(async (homeDir) => {
      const { calls, handleMessage, sessionStore } = await createPairedHandler(
        homeDir,
        {
          artifactContentBytes: new TextEncoder().encode("%PDF-1.4"),
          listedArtifacts: [
            {
              filename: "atlas-pitch-deck.pdf",
              mimeType: "application/pdf",
              path: "/tmp/artifacts/atlas-pitch-deck.pdf",
              sizeBytes: 8,
              updatedAt: "2026-08-08T12:51:00.000Z",
            },
          ],
        }
      );
      sessionStore.set("dm_channel_1", {
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();

      const dm = createDmMessage({
        content: "/attach",
        userId: "424242424242424242",
      });
      await handleMessage(dm.message);

      expect(dm.fileSendCalls).toBe(1);
      expect(calls.sendStream).toBe(0);
      expect(calls.listProfileArtifacts).toBe(1);
      expect(
        dm.sentMessages.some((reply) =>
          /Use slash commands from Discord/i.test(reply)
        )
      ).toBe(false);
    });
  });

  test("typed /attach reports when no artifact is available", async () => {
    await withTempHome(async (homeDir) => {
      const { handleMessage, sessionStore } =
        await createPairedHandler(homeDir);
      sessionStore.set("dm_channel_1", {
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();

      const dm = createDmMessage({
        content: "/attach",
        userId: "424242424242424242",
      });
      await handleMessage(dm.message);

      expect(dm.fileSendCalls).toBe(0);
      expect(
        dm.sentMessages.some((reply) =>
          /No saved artifact to attach/i.test(reply)
        )
      ).toBe(true);
    });
  });

  test("returns a clear error when /attach targets an unsupported type", async () => {
    await withTempHome(async (homeDir) => {
      const { handleMessage, sessionStore } = await createPairedHandler(
        homeDir,
        {
          artifactContentBytes: new Uint8Array([0x4d, 0x5a]),
        }
      );
      sessionStore.set("dm_channel_1", {
        deliverableArtifacts: [
          {
            filename: "payload.exe",
            mimeType: "application/octet-stream",
            path: "payload.exe",
            savedAt: "2026-07-13T10:00:00.000Z",
            sharePath: "/s/tok_exe",
            shareUrl: "https://app.example/s/tok_exe",
            sizeBytes: 2,
          },
        ],
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();

      const dm = createDmMessage({
        content: "/attach",
        userId: "424242424242424242",
      });
      await handleMessage(dm.message);

      expect(dm.fileSendCalls).toBe(0);
      expect(
        dm.sentMessages.some((reply) => /unsupported file type/i.test(reply))
      ).toBe(true);
    });
  });
});
describe("createChatHandler early ack", () => {
  async function setupAckHandler(
    homeDir: string,
    onSendStream: NonNullable<
      Parameters<typeof createMockClient>[0]
    >["onSendStream"]
  ) {
    await writeDiscordConfigIni(homeDir, {
      botToken: "discord-bot-token",
      pairedUserIds: ["424242424242424242"],
    });

    const authStore = new DiscordAuthStore();
    await authStore.reload();
    const { client } = createMockClient({ onSendStream });
    const sessionStore = new SessionStore(
      path.join(homeDir, ".atlas", "discord", "chat-sessions.json")
    );
    await sessionStore.load();
    sessionStore.set("dm_channel_1", {
      profileId: "default",
      sessionId: "session_test",
      updatedAt: new Date().toISOString(),
    });
    await sessionStore.save();
    const orgStore = createTestOrgStore(homeDir);
    await orgStore.load();
    return createChatHandler({
      authStore,
      client,
      config: { botToken: "discord-bot-token", profileId: "default" },
      orgStore,
      sessionStore,
    });
  }

  test("posts the streamed status before tools, then the final outcome", async () => {
    await withTempHome(async (homeDir) => {
      const { handleMessage } = await setupAckHandler(
        homeDir,
        async (_input, handlers) => {
          handlers?.onChunk("Checking the repo first.");
          handlers?.onToolStart?.({
            input: { command: "ls" },
            tool: "bash",
            toolCallId: "tool_1",
          });
          handlers?.onToolEnd?.({
            result: { exitCode: 0 },
            tool: "bash",
            toolCallId: "tool_1",
          });
          handlers?.onChunk("Done — branch is clean.");
          return "Done — branch is clean.";
        }
      );

      const dm = createDmMessage({
        content: "check the repo",
        userId: "424242424242424242",
      });
      await handleMessage(dm.message);

      expect(dm.sentMessages[0]).toBe("Checking the repo first.");
      expect(dm.sentMessages.at(-1)).toBe("Done — branch is clean.");
      expect(dm.sentMessages).toHaveLength(2);
    });
  });

  test("posts a fallback ack when tools start with no streamed text", async () => {
    await withTempHome(async (homeDir) => {
      const { handleMessage } = await setupAckHandler(
        homeDir,
        async (_input, handlers) => {
          handlers?.onToolStart?.({
            input: { command: "ls" },
            tool: "bash",
            toolCallId: "tool_1",
          });
          handlers?.onToolEnd?.({
            result: { exitCode: 0 },
            tool: "bash",
            toolCallId: "tool_1",
          });
          return "All set.";
        }
      );

      const dm = createDmMessage({
        content: "do the thing",
        userId: "424242424242424242",
      });
      await handleMessage(dm.message);

      expect(dm.sentMessages[0]).toBe("On it.");
      expect(dm.sentMessages.at(-1)).toBe("All set.");
    });
  });

  test("does not post an early ack when the turn uses no tools", async () => {
    await withTempHome(async (homeDir) => {
      const { handleMessage } = await setupAckHandler(
        homeDir,
        async (_input, handlers) => {
          handlers?.onChunk("Hello.");
          return "Hello.";
        }
      );

      const dm = createDmMessage({
        content: "hi",
        userId: "424242424242424242",
      });
      await handleMessage(dm.message);

      expect(dm.sentMessages).toEqual(["Hello."]);
    });
  });
});

describe("createChatHandler questionnaire delivery", () => {
  const questionnaire = {
    id: "qset_1",
    questions: [
      {
        allowCustomAnswer: true,
        choices: [
          { id: "playwright", label: "Build Playwright e2e" },
          { id: "manual", label: "Manual steps only" },
        ],
        id: "how-to-run",
        prompt: "How should I run this?",
      },
    ],
    title: "Need input",
  };

  test("posts the questionnaire when ask_user_question fires and skips empty reply", async () => {
    await withTempHome(async (homeDir) => {
      const { handleMessage } = await createPairedHandler(homeDir, {
        onSendStream: async (_input, handlers) => {
          handlers?.onQuestionnaireUpdated?.(questionnaire);
          return "";
        },
      });
      const { message, sentMessages } = createDmMessage({
        content: "help me ship this",
        userId: "424242424242424242",
      });
      await handleMessage(message);

      expect(sentMessages.some((reply) => reply.includes("Need input"))).toBe(
        true
      );
      expect(
        sentMessages.some((reply) => reply.includes("a) Build Playwright e2e"))
      ).toBe(true);
      expect(
        sentMessages.some((reply) => reply.includes("(empty reply)"))
      ).toBe(false);
    });
  });

  test("forwards the next Discord reply to the agent without parsing questionnaire answers", async () => {
    await withTempHome(async (homeDir) => {
      const streamedInputs: unknown[] = [];
      const { handleMessage, sessionStore } = await createPairedHandler(
        homeDir,
        {
          onSendStream: async (input) => {
            streamedInputs.push(input);
            return "Got it.";
          },
          questionnaire,
        }
      );
      sessionStore.set("dm_channel_1", {
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();

      const { message, sentMessages } = createDmMessage({
        content: "a",
        userId: "424242424242424242",
      });
      await handleMessage(message);

      expect(streamedInputs[0]).toEqual({ message: "a" });
      expect(sentMessages).toContain("Got it.");
      expect(
        sentMessages.some((reply) => reply.includes("Couldn't parse that"))
      ).toBe(false);
    });
  });
});

describe("createChatHandler guild thread routing", () => {
  test("mention in a guild channel creates a thread and replies inside it", async () => {
    await withTempHome(async (homeDir) => {
      const streamedInputs: unknown[] = [];
      const { handleMessage, threadStore } = await createPairedHandler(
        homeDir,
        {
          onSendStream: async (input) => {
            streamedInputs.push(input);
            return "Thread reply";
          },
        }
      );

      const guild = createGuildChatMessage({
        content: "<@bot_id> summarize this",
        mentionsBot: true,
      });
      await handleMessage(guild.message);

      expect(guild.startThreadCalls).toBe(1);
      expect(guild.lastThreadName).toBe("summarize this");
      expect(guild.threadSentMessages).toContain("Thread reply");
      expect(guild.channelSentMessages).not.toContain("Thread reply");
      expect(threadStore.hasThreadId(guild.createdThreadId!)).toBe(true);
      expect(streamedInputs[0]).toEqual({ message: "summarize this" });
    });
  });

  test("email and username-prefix substrings do not start a guild thread", async () => {
    await withTempHome(async (homeDir) => {
      const { handleMessage, calls } = await createPairedHandler(homeDir);

      const email = createGuildChatMessage({
        content: "ping ops@atlasbot.com",
      });
      await handleMessage(email.message);

      const prefix = createGuildChatMessage({
        content: "@atlasbotify can you help",
      });
      await handleMessage(prefix.message);

      expect(email.startThreadCalls).toBe(0);
      expect(prefix.startThreadCalls).toBe(0);
      expect(calls.sendStream).toBe(0);
      expect(calls.createSession).toBe(0);
    });
  });

  test("role mention of a role the bot holds creates a thread", async () => {
    await withTempHome(async (homeDir) => {
      const streamedInputs: unknown[] = [];
      const { handleMessage, threadStore } = await createPairedHandler(
        homeDir,
        {
          onSendStream: async (input) => {
            streamedInputs.push(input);
            return "Role mention reply";
          },
        }
      );

      const roleId = "1525964112708894884";
      const guild = createGuildChatMessage({
        botHeldRoleIds: [roleId],
        content: `<@&${roleId}> pull the latest main branch`,
        mentionedRoleIds: [roleId],
      });
      await handleMessage(guild.message);

      expect(guild.startThreadCalls).toBe(1);
      expect(guild.lastThreadName).toBe("pull the latest main branch");
      expect(guild.threadSentMessages).toContain("Role mention reply");
      expect(threadStore.hasThreadId(guild.createdThreadId!)).toBe(true);
      expect(streamedInputs[0]).toEqual({
        message: "pull the latest main branch",
      });
    });
  });

  test("second mention in the same channel creates a new thread", async () => {
    await withTempHome(async (homeDir) => {
      const { handleMessage, threadStore } = await createPairedHandler(
        homeDir,
        {
          onSendStream: async () => "Again",
        }
      );

      const first = createGuildChatMessage({
        content: "<@bot_id> first question",
        mentionsBot: true,
      });
      await handleMessage(first.message);
      const firstThreadId = first.createdThreadId;
      expect(firstThreadId).toBeTruthy();
      expect(first.startThreadCalls).toBe(1);
      expect(threadStore.hasThreadId(firstThreadId!)).toBe(true);

      const second = createGuildChatMessage({
        content: "<@bot_id> follow up topic",
        mentionsBot: true,
      });
      await handleMessage(second.message);

      expect(second.startThreadCalls).toBe(1);
      const secondThreadId = second.createdThreadId;
      expect(secondThreadId).toBeTruthy();
      expect(secondThreadId).not.toBe(firstThreadId);
      expect(threadStore.hasThreadId(firstThreadId!)).toBe(true);
      expect(threadStore.hasThreadId(secondThreadId!)).toBe(true);
      expect(second.threadSentMessages).toContain("Again");
      expect(second.channelSentMessages).not.toContain("Again");
    });
  });

  test("first thread stays independent after a second mention creates another thread", async () => {
    await withTempHome(async (homeDir) => {
      const streamedByThread: string[] = [];
      const { handleMessage, threadStore, sessionStore } =
        await createPairedHandler(homeDir, {
          onSendStream: async (input) => {
            streamedByThread.push(
              String((input as { message?: string }).message ?? "")
            );
            return "ok";
          },
        });

      const first = createGuildChatMessage({
        content: "<@bot_id> topic one",
        mentionsBot: true,
      });
      await handleMessage(first.message);
      const firstThreadId = first.createdThreadId!;

      const second = createGuildChatMessage({
        content: "<@bot_id> topic two",
        mentionsBot: true,
      });
      await handleMessage(second.message);

      const followUp = createGuildChatMessage({
        content: "continue topic one",
        inThread: true,
        parentId: "guild_channel_1",
        threadId: firstThreadId,
      });
      await handleMessage(followUp.message);

      expect(followUp.startThreadCalls).toBe(0);
      expect(followUp.threadSentMessages).toContain("ok");
      expect(threadStore.hasThreadId(firstThreadId)).toBe(true);
      expect(
        sessionStore.get(`g:guild_channel_1:t:${firstThreadId}`)
      ).toBeTruthy();
      expect(streamedByThread).toContain("continue topic one");
    });
  });

  test("overlapping parent mentions run agent turns concurrently", async () => {
    await withTempHome(async (homeDir) => {
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let entered = 0;
      let maxInFlight = 0;
      let inFlight = 0;

      const { handleMessage } = await createPairedHandler(homeDir, {
        onSendStream: async () => {
          entered += 1;
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          if (entered === 1) {
            await firstGate;
          }
          inFlight -= 1;
          return "done";
        },
      });

      const first = createGuildChatMessage({
        content: "<@bot_id> slow",
        mentionsBot: true,
      });
      const second = createGuildChatMessage({
        content: "<@bot_id> fast",
        mentionsBot: true,
      });

      const firstTurn = handleMessage(first.message);
      await waitForCondition(
        () => entered >= 1,
        "first turn never reached onSendStream"
      );
      const secondTurn = handleMessage(second.message);
      await waitForCondition(
        () => entered >= 2,
        "second turn never reached onSendStream; turns are not concurrent"
      );

      expect(entered).toBe(2);
      expect(maxInFlight).toBeGreaterThanOrEqual(2);

      releaseFirst();
      await Promise.all([firstTurn, secondTurn]);
    });
  });

  test("thread message without mention is answered in a bot-owned thread", async () => {
    await withTempHome(async (homeDir) => {
      const streamedInputs: unknown[] = [];
      const { handleMessage, threadStore } = await createPairedHandler(
        homeDir,
        {
          onSendStream: async (input) => {
            streamedInputs.push(input);
            return "In-thread answer";
          },
        }
      );

      threadStore.add("thread_42");
      await threadStore.save();

      const guild = createGuildChatMessage({
        content: "keep going",
        inThread: true,
        parentId: "guild_channel_1",
        threadId: "thread_42",
      });
      await handleMessage(guild.message);

      expect(guild.startThreadCalls).toBe(0);
      expect(guild.threadSentMessages).toContain("In-thread answer");
      expect(streamedInputs[0]).toEqual({ message: "keep going" });
    });
  });

  test("ignores unmentioned messages in threads the agent did not start", async () => {
    await withTempHome(async (homeDir) => {
      const streamedInputs: unknown[] = [];
      const { handleMessage } = await createPairedHandler(homeDir, {
        onSendStream: async (input) => {
          streamedInputs.push(input);
          return "Should not reply";
        },
      });

      const guild = createGuildChatMessage({
        content: "please join this thread",
        inThread: true,
        parentId: "guild_channel_1",
        threadId: "user_thread_9",
      });
      await handleMessage(guild.message);

      expect(guild.startThreadCalls).toBe(0);
      expect(guild.threadSentMessages).toHaveLength(0);
      expect(guild.channelSentMessages).toHaveLength(0);
      expect(streamedInputs).toHaveLength(0);
    });
  });

  test("claims a foreign thread on @mention and replies inside it", async () => {
    await withTempHome(async (homeDir) => {
      const { handleMessage, threadStore } = await createPairedHandler(
        homeDir,
        {
          onSendStream: async () => "Joined the thread",
        }
      );

      expect(threadStore.hasThreadId("user_thread_9")).toBe(false);

      const guild = createGuildChatMessage({
        content: "<@bot_id> please join this thread",
        inThread: true,
        mentionsBot: true,
        parentId: "guild_channel_1",
        threadId: "user_thread_9",
      });
      await handleMessage(guild.message);

      expect(guild.startThreadCalls).toBe(0);
      expect(threadStore.hasThreadId("user_thread_9")).toBe(true);
      expect(guild.threadSentMessages).toContain("Joined the thread");
      expect(guild.channelSentMessages).toHaveLength(0);

      const followUp = createGuildChatMessage({
        content: "keep going",
        inThread: true,
        parentId: "guild_channel_1",
        threadId: "user_thread_9",
      });
      await handleMessage(followUp.message);

      expect(followUp.threadSentMessages.length).toBeGreaterThan(0);
    });
  });

  test("unpaired mention does not claim a foreign thread for later paired follow-up", async () => {
    await withTempHome(async (homeDir) => {
      const streamCalls: string[] = [];
      const { handleMessage, threadStore } = await createPairedHandler(
        homeDir,
        {
          onSendStream: async () => {
            streamCalls.push("invoked");
            return "should not run after unpaired claim";
          },
        }
      );

      const stranger = createGuildChatMessage({
        content: "<@bot_id> please join this thread",
        inThread: true,
        mentionsBot: true,
        parentId: "guild_channel_1",
        threadId: "user_thread_busy",
        userId: "555555555555555555",
      });
      await handleMessage(stranger.message);

      expect(threadStore.hasThreadId("user_thread_busy")).toBe(false);
      expect(streamCalls).toEqual([]);

      const followUp = createGuildChatMessage({
        content: "just chatting in this human thread",
        inThread: true,
        parentId: "guild_channel_1",
        threadId: "user_thread_busy",
      });
      await handleMessage(followUp.message);

      expect(streamCalls).toEqual([]);
    });
  });

  test("thread messages reuse the parent channel org selection", async () => {
    await withTempHome(async (homeDir) => {
      const streamedInputs: unknown[] = [];
      const { handleMessage, orgStore, threadStore } =
        await createPairedHandler(homeDir, {
          onSendStream: async (input) => {
            streamedInputs.push(input);
            return "In-thread answer";
          },
          orgs: createMultiTestOrgs(),
        });

      orgStore.set("g:guild_channel_1", "org_a");
      await orgStore.save();
      threadStore.add("thread_42");
      await threadStore.save();

      const guild = createGuildChatMessage({
        content: "keep going",
        inThread: true,
        parentId: "guild_channel_1",
        threadId: "thread_42",
      });
      await handleMessage(guild.message);

      expect(
        guild.threadSentMessages.some((text) =>
          text.includes("Choose an organization")
        )
      ).toBe(false);
      expect(guild.threadSentMessages).toContain("In-thread answer");
      expect(streamedInputs).toHaveLength(1);
      expect(orgStore.get("g:thread_42")).toBeUndefined();
      expect(orgStore.get("g:guild_channel_1")?.orgId).toBe("org_a");
    });
  });

  test("new threads inherit the parent channel profile", async () => {
    await withTempHome(async (homeDir) => {
      const { handleMessage, sessionStore, createdSessionProfileIds } =
        await createPairedHandler(homeDir, {
          configProfileId: "default",
          onSendStream: async () => "Thread reply",
          profiles: [
            { id: "default", name: "Default" },
            { id: "support", name: "Support" },
          ],
        });

      sessionStore.set("guild_channel_1", {
        profileId: "support",
        sessionId: "channel_session",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();

      const guild = createGuildChatMessage({
        content: "<@bot_id> help a customer",
        mentionsBot: true,
      });
      await handleMessage(guild.message);

      const threadId = guild.createdThreadId;
      expect(threadId).toBeTruthy();
      expect(createdSessionProfileIds).toContain("support");
      expect(
        sessionStore.get(`g:guild_channel_1:t:${threadId}`)?.profileId
      ).toBe("support");
      expect(sessionStore.get("guild_channel_1")?.profileId).toBe("support");
    });
  });

  test("thread-specific profile override is kept for that thread only", async () => {
    await withTempHome(async (homeDir) => {
      const {
        handleMessage,
        sessionStore,
        threadStore,
        createdSessionProfileIds,
      } = await createPairedHandler(homeDir, {
        configProfileId: "default",
        onSendStream: async () => "ok",
        profiles: [
          { id: "default", name: "Default" },
          { id: "support", name: "Support" },
          { id: "sales", name: "Sales" },
        ],
      });

      sessionStore.set("guild_channel_1", {
        profileId: "support",
        sessionId: "channel_session",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();
      threadStore.add("thread_42");
      await threadStore.save();

      const switchProfile = createGuildChatMessage({
        content: "/profile sales",
        inThread: true,
        parentId: "guild_channel_1",
        threadId: "thread_42",
      });
      await handleMessage(switchProfile.message);

      expect(sessionStore.get("g:guild_channel_1:t:thread_42")?.profileId).toBe(
        "sales"
      );
      expect(sessionStore.get("guild_channel_1")?.profileId).toBe("support");
      expect(createdSessionProfileIds.at(-1)).toBe("sales");
    });
  });

  test("slash commands in threads reuse the parent channel org selection", async () => {
    await withTempHome(async (homeDir) => {
      const { handleSlashCommand, orgStore } = await createPairedHandler(
        homeDir,
        {
          orgs: createMultiTestOrgs(),
        }
      );

      orgStore.set("g:guild_channel_1", "org_b");
      await orgStore.save();

      const clearCmd = createSlashInteraction({
        commandName: "clear",
        inThread: true,
        parentId: "guild_channel_1",
        threadId: "thread_1",
      });
      await handleSlashCommand(clearCmd.interaction);

      expect(
        clearCmd.replies.some((text) => text.includes("Choose an organization"))
      ).toBe(false);
      expect(clearCmd.replies).toContain("History cleared.");
      expect(orgStore.get("g:thread_1")).toBeUndefined();
    });
  });

  test("thread creation failure falls back to channel reply", async () => {
    await withTempHome(async (homeDir) => {
      const { handleMessage } = await createPairedHandler(homeDir, {
        onSendStream: async (input) => {
          // Fallback path still uses the public-channel prefix.
          expect(input).toEqual({
            message:
              "[Discord channel — your reply is visible to everyone in this channel.]\nhello",
          });
          return "Channel fallback";
        },
      });

      const guild = createGuildChatMessage({
        content: "<@bot_id> hello",
        mentionsBot: true,
        startThreadError: new Error("Missing Permissions"),
      });
      await handleMessage(guild.message);

      expect(guild.startThreadCalls).toBe(1);
      expect(guild.channelSentMessages).toContain("Channel fallback");
      expect(guild.threadSentMessages).toHaveLength(0);
    });
  });

  test("slash commands in threads still clear and start new sessions", async () => {
    await withTempHome(async (homeDir) => {
      const { handleSlashCommand, sessionStore } =
        await createPairedHandler(homeDir);
      const conversationKey = "g:guild_channel_1:t:thread_1";
      sessionStore.set(conversationKey, {
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();

      const clearCmd = createSlashInteraction({
        commandName: "clear",
        inThread: true,
        parentId: "guild_channel_1",
        threadId: "thread_1",
      });
      await handleSlashCommand(clearCmd.interaction);
      expect(clearCmd.replies).toContain("History cleared.");

      const newCmd = createSlashInteraction({
        commandName: "new",
        inThread: true,
        parentId: "guild_channel_1",
        threadId: "thread_1",
      });
      await handleSlashCommand(newCmd.interaction);
      expect(newCmd.replies).toContain("Started a new conversation.");

      const stopCmd = createSlashInteraction({
        commandName: "stop",
        inThread: true,
        parentId: "guild_channel_1",
        threadId: "thread_1",
      });
      await handleSlashCommand(stopCmd.interaction);
      expect(stopCmd.replies).toContain("Nothing to stop.");
    });
  });

  test("close archives a bot-owned thread and clears ownership for that thread only", async () => {
    await withTempHome(async (homeDir) => {
      const { handleSlashCommand, threadStore, handleMessage } =
        await createPairedHandler(homeDir);
      threadStore.add("thread_1");
      threadStore.add("thread_sibling");
      await threadStore.save();

      const closeCmd = createSlashInteraction({
        commandName: "close",
        inThread: true,
        parentId: "guild_channel_1",
        threadId: "thread_1",
      });
      await handleSlashCommand(closeCmd.interaction);

      expect(closeCmd.replies).toContain("Thread closed.");
      expect(
        (closeCmd.interaction.channel as { archived?: boolean }).archived
      ).toBe(true);
      expect(threadStore.hasThreadId("thread_1")).toBe(false);
      expect(threadStore.hasThreadId("thread_sibling")).toBe(true);

      const sibling = createGuildChatMessage({
        content: "still here",
        inThread: true,
        parentId: "guild_channel_1",
        threadId: "thread_sibling",
      });
      await handleMessage(sibling.message);
      expect(sibling.threadSentMessages.length).toBeGreaterThan(0);
    });
  });

  test("close rejects non-thread channels and foreign threads", async () => {
    await withTempHome(async (homeDir) => {
      const { handleSlashCommand, threadStore } =
        await createPairedHandler(homeDir);
      threadStore.add("thread_owned");
      await threadStore.save();

      const channelClose = createSlashInteraction({
        channelId: "guild_channel_1",
        commandName: "close",
      });
      await handleSlashCommand(channelClose.interaction);
      expect(channelClose.replies).toContain(
        "Use /close inside a bot conversation thread."
      );

      const foreignClose = createSlashInteraction({
        commandName: "close",
        inThread: true,
        parentId: "guild_channel_1",
        threadId: "user_thread_9",
      });
      await handleSlashCommand(foreignClose.interaction);
      expect(foreignClose.replies).toContain(
        "I can only close threads I started."
      );
      expect(threadStore.hasThreadId("thread_owned")).toBe(true);
    });
  });

  test("denies non-paired users", async () => {
    await withTempHome(async (homeDir) => {
      const { handleSlashCommand } = await createPairedHandler(homeDir, {
        pairedUserIds: [],
      });
      const allowCmd = createSlashInteraction({
        commandName: "allow",
        userId: "555555555555555555",
        userOption: { id: "999999999999999999" },
      });
      await handleSlashCommand(allowCmd.interaction);

      expect(
        allowCmd.replies.some((reply) => /not authorized/i.test(reply))
      ).toBe(true);
      expect((await loadDiscordConfigFile())?.allowedUserIds ?? []).toEqual([]);
    });
  });

  test("adds a mentioned user", async () => {
    await withTempHome(async (homeDir) => {
      const { handleSlashCommand } = await createPairedHandler(homeDir);
      const targetUserId = "777777777777777777";
      const allowCmd = createSlashInteraction({
        commandName: "allow",
        userOption: { id: targetUserId, username: "alice" },
      });
      await handleSlashCommand(allowCmd.interaction);

      expect(
        allowCmd.replies.some((reply) => reply.includes(`<@${targetUserId}>`))
      ).toBe(true);
      expect((await loadDiscordConfigFile())?.allowedUserIds).toContain(
        targetUserId
      );
    });
  });

  test("reports already-allowed users", async () => {
    await withTempHome(async (homeDir) => {
      const targetUserId = "888888888888888888";
      const { handleSlashCommand } = await createPairedHandler(homeDir, {
        allowedUserIds: [targetUserId],
      });
      const allowCmd = createSlashInteraction({
        commandName: "allow",
        userOption: { id: targetUserId },
      });
      await handleSlashCommand(allowCmd.interaction);

      expect(allowCmd.replies.some((reply) => /already/i.test(reply))).toBe(
        true
      );
    });
  });

  test("threadStore save failure still tracks the created Discord thread", async () => {
    await withTempHome(async (homeDir) => {
      const streamedInputs: unknown[] = [];
      const { handleMessage, threadStore } = await createPairedHandler(
        homeDir,
        {
          onSendStream: async (input) => {
            streamedInputs.push(input);
            return "Tracked despite save failure";
          },
        }
      );

      const originalSave = threadStore.save.bind(threadStore);
      let saveCalls = 0;
      threadStore.save = async () => {
        saveCalls += 1;
        throw new Error("ENOSPC");
      };

      const mention = createGuildChatMessage({
        content: "<@bot_id> start me",
        mentionsBot: true,
      });
      await handleMessage(mention.message);

      const threadId = mention.createdThreadId;
      expect(threadId).toBeTruthy();
      expect(saveCalls).toBeGreaterThan(0);
      expect(threadStore.hasThreadId(threadId!)).toBe(true);
      expect(mention.threadSentMessages).toContain(
        "Tracked despite save failure"
      );
      expect(mention.channelSentMessages).not.toContain(
        "Tracked despite save failure"
      );

      threadStore.save = originalSave;

      const followUp = createGuildChatMessage({
        content: "still here",
        inThread: true,
        parentId: "guild_channel_1",
        threadId: threadId!,
      });
      await handleMessage(followUp.message);

      expect(followUp.threadSentMessages).toContain(
        "Tracked despite save failure"
      );
      expect(streamedInputs).toHaveLength(2);
    });
  });

  test("claim-thread save failure still tracks ownership for follow-ups", async () => {
    await withTempHome(async (homeDir) => {
      const { handleMessage, threadStore } = await createPairedHandler(
        homeDir,
        {
          onSendStream: async () => "Claimed despite save failure",
        }
      );

      threadStore.save = async () => {
        throw new Error("EACCES");
      };

      const claim = createGuildChatMessage({
        content: "<@bot_id> join please",
        inThread: true,
        mentionsBot: true,
        parentId: "guild_channel_1",
        threadId: "user_thread_claim",
      });
      await handleMessage(claim.message);

      expect(threadStore.hasThreadId("user_thread_claim")).toBe(true);
      expect(claim.threadSentMessages).toContain(
        "Claimed despite save failure"
      );

      const followUp = createGuildChatMessage({
        content: "keep going",
        inThread: true,
        parentId: "guild_channel_1",
        threadId: "user_thread_claim",
      });
      await handleMessage(followUp.message);

      expect(followUp.threadSentMessages.length).toBeGreaterThan(0);
    });
  });

  test("partial thread hydrates parentId via channel.fetch so org keys stay correct", async () => {
    await withTempHome(async (homeDir) => {
      const streamedByKey: string[] = [];
      const { handleMessage, threadStore, orgStore, sessionStore } =
        await createPairedHandler(homeDir, {
          onSendStream: async (input) => {
            streamedByKey.push(
              String((input as { message?: string }).message ?? "")
            );
            return "Partial ok";
          },
          orgs: createMultiTestOrgs(),
        });

      orgStore.set("g:guild_channel_1", "org_a");
      await orgStore.save();
      threadStore.add("thread_partial");
      await threadStore.save();

      const followUp = createGuildChatMessage({
        content: "hello from partial",
        fetchParentId: "guild_channel_1",
        inThread: true,
        parentId: null,
        threadId: "thread_partial",
      });
      await handleMessage(followUp.message);

      expect(followUp.threadSentMessages).toContain("Partial ok");
      expect(streamedByKey).toEqual(["hello from partial"]);
      expect(orgStore.get("g:thread_partial")).toBeUndefined();
      expect(
        sessionStore.get("g:guild_channel_1:t:thread_partial")
      ).toBeTruthy();
      expect(
        sessionStore.get("g:thread_partial:t:thread_partial")
      ).toBeUndefined();
    });
  });

  test("slash commands in partial threads hydrate parentId via channel.fetch", async () => {
    await withTempHome(async (homeDir) => {
      const { handleSlashCommand, orgStore, sessionStore } =
        await createPairedHandler(homeDir, {
          orgs: createMultiTestOrgs(),
        });

      orgStore.set("g:guild_channel_1", "org_b");
      await orgStore.save();
      sessionStore.set("g:guild_channel_1:t:thread_partial_slash", {
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();

      const clearCmd = createSlashInteraction({
        commandName: "clear",
        fetchParentId: "guild_channel_1",
        inThread: true,
        parentId: null,
        threadId: "thread_partial_slash",
      });
      await handleSlashCommand(clearCmd.interaction);

      expect(
        clearCmd.replies.some((text) => text.includes("Choose an organization"))
      ).toBe(false);
      expect(clearCmd.replies).toContain("History cleared.");
      expect(orgStore.get("g:thread_partial_slash")).toBeUndefined();
    });
  });

  test("wedged chat lock recovers so follow-ups are not silenced forever", async () => {
    chatLockOptions.waitMs = 40;

    let releaseHang!: () => void;
    const hang = new Promise<void>((resolve) => {
      releaseHang = resolve;
    });

    const order: string[] = [];
    const first = withChatLock("g:channel:t:thread_wedge", async () => {
      order.push("first-start");
      await hang;
      order.push("first-end");
    });

    await Bun.sleep(5);
    const secondStarted = Date.now();
    const second = withChatLock("g:channel:t:thread_wedge", async () => {
      order.push("second");
    });

    await second;
    const waitedMs = Date.now() - secondStarted;
    expect(waitedMs).toBeGreaterThanOrEqual(35);
    expect(order).toEqual(["first-start", "second"]);

    releaseHang();
    await first;
    expect(order).toEqual(["first-start", "second", "first-end"]);
  });

  test("releases completed and failed chat locks from memory", async () => {
    await withChatLock("chat-success", async () => undefined);
    expect(getChatLockCountForTests()).toBe(0);

    await expect(
      withChatLock("chat-failure", async () => {
        throw new Error("turn failed");
      })
    ).rejects.toThrow("turn failed");
    expect(getChatLockCountForTests()).toBe(0);
  });

  test("locks chat to fixedWorkspaceId and prevents switching workspaces", async () => {
    await withTempHome(async (homeDir) => {
      const { handleMessage, calls, client, orgStore } =
        await createPairedHandler(homeDir, {
          fixedWorkspaceId: "org_b",
          orgs: createMultiTestOrgs(),
          profilesByOrgId: {
            org_a: [{ id: "gary", isDefault: true, name: "Gary Vee" }],
            org_b: [{ id: "default", isDefault: true, name: "Default Agent" }],
          },
        });

      const dm = createDmMessage({
        content: "hello",
        userId: "424242424242424242",
      });
      await handleMessage(dm.message);

      expect(calls.createSession).toBe(1);
      expect(calls.sendStream).toBe(1);
      expect(
        dm.sentMessages.some((reply) =>
          reply.includes("Choose an organization")
        )
      ).toBe(false);

      const orgCmd = createDmMessage({
        content: "/org",
        userId: "424242424242424242",
      });
      await handleMessage(orgCmd.message);

      expect(
        orgCmd.sentMessages.some((reply) =>
          reply.includes(
            "belongs to one workspace and cannot switch workspaces"
          )
        )
      ).toBe(true);

      const profileCmd = createDmMessage({
        content: "/profile garry-vee",
        userId: "424242424242424242",
      });
      await handleMessage(profileCmd.message);

      expect(orgStore.get("u:424242424242424242")?.orgId).toBe("org_b");
      expect(
        profileCmd.sentMessages.some((reply) =>
          reply.includes("Unknown profile. Send /profile to see the list.")
        )
      ).toBe(true);
      expect(calls.createSession).toBe(1);
    });
  });
});

describe("createChatHandler inbound files", () => {
  let fetchSpy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  test("forwards a pdf attachment to sendStream", async () => {
    await withTempHome(async (homeDir) => {
      fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("pdf-content", {
          headers: { "content-type": "application/pdf" },
        })
      );

      let lastInput: unknown;
      const { handleMessage, calls } = await createPairedHandler(homeDir, {
        onSendStream: async (input) => {
          lastInput = input;
          return "Agent reply";
        },
      });

      const dm = createDmMessage({
        attachments: [
          {
            contentType: "application/pdf",
            name: "report.pdf",
          },
        ],
        content: "Summarize",
        userId: "424242424242424242",
      });
      await handleMessage(dm.message);

      expect(calls.sendStream).toBe(1);
      expect(lastInput).toEqual({
        documents: [
          expect.objectContaining({
            filename: "report.pdf",
            mediaType: "application/pdf",
          }),
        ],
        images: undefined,
        message: "Summarize",
      });
    });
  });

  test("forwards a captionless pdf attachment to sendStream", async () => {
    await withTempHome(async (homeDir) => {
      fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("pdf-content", {
          headers: { "content-type": "application/pdf" },
        })
      );

      let lastInput: unknown;
      const { handleMessage, calls } = await createPairedHandler(homeDir, {
        onSendStream: async (input) => {
          lastInput = input;
          return "Agent reply";
        },
      });

      const dm = createDmMessage({
        attachments: [
          {
            contentType: "application/pdf",
            name: "report.pdf",
          },
        ],
        userId: "424242424242424242",
      });
      await handleMessage(dm.message);

      expect(calls.sendStream).toBe(1);
      expect(lastInput).toEqual({
        documents: [
          expect.objectContaining({
            filename: "report.pdf",
            mediaType: "application/pdf",
          }),
        ],
        images: undefined,
        message: "",
      });
    });
  });

  test("forwards an xlsx attachment to sendStream", async () => {
    await withTempHome(async (homeDir) => {
      fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("xlsx-content", {
          headers: {
            "content-type":
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          },
        })
      );

      let lastInput: unknown;
      const { handleMessage, calls } = await createPairedHandler(homeDir, {
        onSendStream: async (input) => {
          lastInput = input;
          return "Agent reply";
        },
      });

      const dm = createDmMessage({
        attachments: [
          {
            contentType:
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            name: "sales.xlsx",
          },
        ],
        content: "Analyze",
        userId: "424242424242424242",
      });
      await handleMessage(dm.message);

      expect(calls.sendStream).toBe(1);
      expect(lastInput).toEqual({
        documents: [
          expect.objectContaining({
            filename: "sales.xlsx",
            mediaType:
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          }),
        ],
        images: undefined,
        message: "Analyze",
      });
    });
  });

  test("transcribes a voice attachment and forwards text to the agent", async () => {
    await withTempHome(async (homeDir) => {
      fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("ogg-bytes", {
          headers: { "content-type": "audio/ogg" },
        })
      );

      let lastInput: unknown;
      const { handleMessage, calls } = await createPairedHandler(homeDir, {
        onSendStream: async (input) => {
          lastInput = input;
          return "Agent reply";
        },
      });

      const dm = createDmMessage({
        attachments: [
          {
            contentType: "audio/ogg",
            name: "voice-message.ogg",
          },
        ],
        userId: "424242424242424242",
      });
      await handleMessage(dm.message);

      expect(calls.transcribeAudio).toBe(1);
      expect(calls.sendStream).toBe(1);
      expect(lastInput).toEqual({
        documents: undefined,
        images: undefined,
        message: "Transcribed voice message",
      });
    });
  });

  test("runs /org even when the same message has an unsupported file", async () => {
    await withTempHome(async (homeDir) => {
      const { handleMessage, calls } = await createPairedHandler(homeDir, {
        orgs: createMultiTestOrgs(),
      });

      const dm = createDmMessage({
        attachments: [
          {
            contentType: "application/zip",
            name: "bundle.zip",
          },
        ],
        content: "/org",
        userId: "424242424242424242",
      });
      await handleMessage(dm.message);

      expect(calls.sendStream).toBe(0);
      expect(
        dm.sentMessages.some((reply) => /unsupported file type/i.test(reply))
      ).toBe(false);
      expect(
        dm.sentMessages.some((reply) =>
          /Choose an organization|organization/i.test(reply)
        )
      ).toBe(true);
    });
  });

  test("does not drop an inbound file silently on /attach", async () => {
    await withTempHome(async (homeDir) => {
      fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("pdf-content", {
          headers: { "content-type": "application/pdf" },
        })
      );

      const { handleMessage, calls, sessionStore } = await createPairedHandler(
        homeDir,
        {
          listedArtifacts: [
            {
              filename: "atlas-pitch-deck.pdf",
              mimeType: "application/pdf",
              path: "/tmp/artifacts/atlas-pitch-deck.pdf",
              sizeBytes: 8,
              updatedAt: "2026-08-08T12:51:00.000Z",
            },
          ],
        }
      );
      sessionStore.set("dm_channel_1", {
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();

      const dm = createDmMessage({
        attachments: [
          {
            contentType: "application/pdf",
            name: "report.pdf",
          },
        ],
        content: "/attach",
        userId: "424242424242424242",
      });
      await handleMessage(dm.message);

      expect(calls.sendStream).toBe(0);
      expect(dm.fileSendCalls).toBe(0);
      expect(dm.sentMessages).toEqual([ATTACH_COMMAND_WITH_FILE_REPLY]);
    });
  });
});

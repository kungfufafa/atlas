import { expect, test } from "bun:test";
import path from "node:path";
import type { AtlasClient } from "@atlas/client";
import type { ChannelNativeActionRequest } from "@atlas/core/channel-native-actions";
import type {
  AgentQuestionnaire,
  SendMessageInput,
} from "@atlas/core/contract";
import { ChannelType, type Client } from "discord.js";
import { DiscordAuthStore } from "./auth-store";
import { createChatHandler } from "./chat-handler";
import type { DiscordNativeInteraction } from "./native-questionnaire";
import { SessionStore } from "./session-store";
import {
  createDmMessage,
  createMockClient,
  createTestOrgStore,
  withTempHome,
  writeDiscordConfigIni,
} from "./test-helpers";
import { ThreadStore } from "./thread-store";
import { discordPcmToWav } from "./voice-session";

const sender = "424242424242424242";
const question: AgentQuestionnaire = {
  id: "questionnaire",
  questions: [
    {
      allowCustomAnswer: false,
      choices: [{ id: "a", label: "First path" }],
      id: "q1",
      prompt: "Choose a path",
    },
  ],
  title: "Choose",
};

async function fixture(
  homeDir: string,
  options: Parameters<typeof createMockClient>[0] = {}
) {
  await writeDiscordConfigIni(homeDir, {
    botToken: "synthetic-token",
    pairedUserIds: [sender],
  });
  const authStore = new DiscordAuthStore();
  await authStore.reload();
  const state = createMockClient(options);
  const dm = createDmMessage({
    content: "Make the requested artifact",
    userId: sender,
  });
  const channel = Object.assign(dm.message.channel, {
    isSendable: () => true,
    recipientId: sender,
    type: ChannelType.DM,
  });
  const sessionStore = new SessionStore(path.join(homeDir, "sessions.json"));
  const handler = createChatHandler({
    authStore,
    client: state.client,
    config: { botToken: "synthetic-token", profileId: "default" },
    fixedWorkspaceId: "org_test",
    getDiscordClient: () => discord,
    orgStore: createTestOrgStore(homeDir),
    sessionStore,
    threadStore: new ThreadStore(path.join(homeDir, "threads.json")),
  });
  const uploads: unknown[] = [];
  const discord = {
    channels: { fetch: async () => channel },
    rest: {
      post: async (_route: string, payload: unknown) => {
        uploads.push(payload);
        return { id: "voice-receipt" };
      },
    },
    user: { id: "bot_id" },
  } as unknown as Client<true>;
  return { ...state, channel, discord, dm, handler, sessionStore, uploads };
}

function control(state: Awaited<ReturnType<typeof fixture>>, index = 0) {
  const payload = JSON.parse(JSON.stringify(state.dm.componentMessages[0])) as {
    content: string;
    components: { components: { custom_id: string }[] }[];
  };
  const responses: unknown[] = [];
  const value = {
    channelId: "dm_channel_1",
    customId: payload.components[0]!.components[index]!.custom_id,
    deferReply: async () => {
      value.deferred = true;
    },
    deferred: false,
    editReply: async (response: unknown) => {
      responses.push(response);
    },
    guildId: null,
    isButton: () => true,
    isModalSubmit: () => false,
    isStringSelectMenu: () => false,
    message: { id: String(state.dm.sentMessages.indexOf(payload.content) + 1) },
    replied: false,
    reply: async (response: unknown) => {
      responses.push(response);
    },
    user: { id: sender },
  };
  return {
    interaction: value as unknown as DiscordNativeInteraction,
    responses,
  };
}

test.each(["accepted", "unknown"] as const)(
  "native voice %s receipt prevents final artifact duplicate while retaining the file registry",
  async (status) => {
    await withTempHome(async (homeDir) => {
      const request: ChannelNativeActionRequest = {
        action: {
          kind: "send_media",
          mode: "voice",
          path: "artifacts/reply.wav",
        },
        channel: "discord",
        channelAddressed: true,
        channelChatId: "dm_channel_1",
        channelIsGroup: false,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        id: "native-request",
        orgId: "org_test",
        profileId: "default",
        sessionId: "session_test",
      };
      const state = await fixture(homeDir, {
        onSendStream: async (_input, handlers) => {
          handlers?.onArtifactCreated?.({
            createdAt: new Date().toISOString(),
            filename: "reply.wav",
            id: "artifact",
            mimeType: "audio/wav",
            path: "artifacts/reply.wav",
            size: 3884,
            type: "file",
          });
          handlers?.onChannelActionRequested?.(request);
          return "Voice ready";
        },
      });
      const receipts: unknown[] = [];
      const authorization: unknown[] = [];
      state.client.claimChannelAction = async (actor) => {
        expect(actor).toEqual({
          channel: "discord",
          channelAddressed: true,
          channelChatId: "dm_channel_1",
          channelIsGroup: false,
          channelThreadId: undefined,
          channelUserId: sender,
          requestId: request.id,
          sessionId: request.sessionId,
        });
        return request;
      };
      state.client.completeChannelAction = async (input) => {
        receipts.push(input.receipt);
        return { recorded: true };
      };
      state.client.authorizeChannelPrincipal = async (input) => {
        authorization.push(input);
        return {
          isPlatformAdmin: false,
          orgId: "org_test",
          orgRole: "member",
          userId: "user_test",
        };
      };
      state.client.readProfileArtifactContent = async (
        profileId,
        filePath,
        input
      ) => {
        expect(profileId).toBe("default");
        expect(filePath).toBe("artifacts/reply.wav");
        expect(input).toEqual({ sessionId: "session_test" });
        return {
          contentType: "audio/wav",
          data: Uint8Array.from(discordPcmToWav(Buffer.alloc(3840))).buffer,
        };
      };
      if (status === "unknown") {
        state.discord.rest.post = async (_route, payload) => {
          state.uploads.push(payload);
          throw new Error("receipt lost after transport accepted bytes");
        };
      }
      await state.handler.handleMessage(state.dm.message);
      expect(receipts).toEqual([
        status === "accepted"
          ? { messageId: "voice-receipt", status }
          : expect.objectContaining({ status }),
      ]);
      expect(state.uploads).toHaveLength(1);
      expect(state.dm.fileSendCalls).toBe(0);
      expect(
        state.sessionStore.getDeliverableArtifacts("dm_channel_1")
      ).toEqual([expect.objectContaining({ path: "reply.wav" })]);
      expect(state.calls.publishProfileArtifactShare).toBe(1);
      expect(authorization).toContainEqual(
        expect.objectContaining({
          channelChatId: "dm_channel_1",
          channelIsGroup: false,
          channelUserId: sender,
          nativeAction: "send_media",
        })
      );
    });
  }
);

test.each(["accepted", "superseded", "revoked", "atomic-conflict"] as const)(
  "native questionnaire handler %s enforces current snapshot and single submission",
  async (boundary) => {
    await withTempHome(async (homeDir) => {
      const submitted: unknown[] = [];
      let invocation = 0;
      const state = await fixture(homeDir, {
        onSendStream: async (input, handlers) => {
          invocation += 1;
          if (invocation === 1) {
            handlers?.onQuestionnaireUpdated?.(question);
            return "";
          }
          submitted.push(input);
          if (boundary === "atomic-conflict") {
            throw new Error("HTTP 409: questionnaire changed after validation");
          }
          return "Answer processed";
        },
        questionnaire: question,
      });
      await state.handler.handleMessage(state.dm.message);
      const button = control(state);
      if (boundary === "superseded") {
        const original = state.client.getSessionMessages;
        state.client.getSessionMessages = async (...args) => ({
          ...(await original(...args)),
          questionnaire: {
            ...question,
            questions: [
              {
                ...question.questions[0]!,
                prompt: "Replacement under same id",
              },
            ],
          },
        });
      }
      if (boundary === "revoked") {
        state.client.authorizeChannelPrincipal = async () => {
          throw new Error("role revoked");
        };
      }
      await state.handler.handleNativeInteraction(button.interaction);
      await state.handler.handleNativeInteraction(button.interaction);
      const expectedCount =
        boundary === "accepted" || boundary === "atomic-conflict" ? 1 : 0;
      expect(submitted).toHaveLength(expectedCount);
      if (expectedCount) {
        expect(
          (submitted[0] as SendMessageInput).expectedQuestionnaire
        ).toEqual(question);
      }
      expect(state.calls.sendStream).toBe(1 + expectedCount);
      expect(state.dm.sentMessages.includes("Answers submitted.")).toBe(
        boundary === "accepted"
      );
    });
  }
);

test.each(["approved", "denied", "revoked"] as const)(
  "native approval handler %s binds current sender and original approval",
  async (decision) => {
    await withTempHome(async (homeDir) => {
      const state = await fixture(homeDir, {
        onSendStream: async (_input, handlers) => {
          handlers?.onApprovalRequested?.({
            consequenceSummary: "Modify a synthetic file",
            createdAt: new Date().toISOString(),
            id: "approval",
            status: "pending",
            title: "File edit",
            tool: "write_file",
            toolCallId: "tool-call",
          });
          return "";
        },
      });
      const decisions: Parameters<AtlasClient["decideChannelApproval"]>[0][] =
        [];
      state.client.decideChannelApproval = async (input) => {
        decisions.push(input);
        return {} as Awaited<ReturnType<AtlasClient["decideChannelApproval"]>>;
      };
      await state.handler.handleMessage(state.dm.message);
      const button = control(state, decision === "denied" ? 1 : 0);
      if (decision === "revoked") {
        state.client.authorizeChannelPrincipal = async () => {
          throw new Error("membership removed");
        };
      }
      await state.handler.handleNativeInteraction(button.interaction);
      await state.handler.handleNativeInteraction(button.interaction);
      expect(decisions).toEqual(
        decision === "revoked"
          ? []
          : [
              {
                approvalId: "approval",
                channel: "discord",
                channelAddressed: true,
                channelChatId: "dm_channel_1",
                channelIsGroup: false,
                channelThreadId: undefined,
                channelUserId: sender,
                decision,
                profileId: "default",
                sessionId: "session_test",
              },
            ]
      );
    });
  }
);

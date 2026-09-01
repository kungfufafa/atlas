import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AtlasClient, StreamHandlers } from "@atlas/client";
import type { Artifact } from "@atlas/core/artifact-types";
import {
  assertBridgeClientMethods,
  parseListProfilesResponse,
  parseListUserOrgsResponse,
} from "@atlas/core/bridge-api";
import { ChannelOrgStore } from "@atlas/core/channel-org";
import type {
  AgentTodo,
  ChatMessage,
  UserOrgSummary,
} from "@atlas/core/contract";
import { withIsolatedAtlasHome } from "@atlas/core/testing/atlas-home";
import type { Context } from "grammy";
import type { TelegramBotInfo } from "./group-message";

export const TEST_BOT_INFO: TelegramBotInfo = { id: 999, username: "mybot" };

export interface MockMessageContext {
  ctx: Context;
  readonly documentSends: number;
  editOptions: unknown[];
  edits: Array<{ chatId: number; messageId: number; text: string }>;
  readonly photoSends: number;
  replies: string[];
  replyOptions: unknown[];
}

export function createMessageContext(options: {
  userId?: number;
  chatId?: number;
  text?: string;
  chatType?: "private" | "group" | "supergroup";
  entities?: Array<{ type: "mention"; offset: number; length: number }>;
  replyToBot?: boolean;
  replyToBotId?: number;
  failRichReply?: boolean;
  failRichEdit?: boolean;
  messageThreadId?: number;
}): MockMessageContext {
  const replies: string[] = [];
  const replyOptions: unknown[] = [];
  const edits: Array<{ chatId: number; messageId: number; text: string }> = [];
  const editOptions: unknown[] = [];
  let documentSends = 0;
  let photoSends = 0;
  let nextMessageId = 1;
  const replyFrom =
    options.replyToBot || options.replyToBotId !== undefined
      ? {
          id: options.replyToBotId ?? 999,
          is_bot: true as const,
        }
      : undefined;
  const ctx = {
    api: {
      editMessageText: async (
        chatId: number,
        messageId: number,
        text: string,
        editOptionsArg?: unknown
      ) => {
        if (isHtmlParseMode(editOptionsArg) && options.failRichEdit) {
          throw new Error("Rich edit failed");
        }

        edits.push({ chatId, messageId, text });
        editOptions.push(editOptionsArg);
      },
      sendDocument: async () => {
        documentSends += 1;
        return { message_id: nextMessageId++ };
      },
      sendPhoto: async () => {
        photoSends += 1;
        return { message_id: nextMessageId++ };
      },
    },
    chat: options.chatType
      ? { id: options.chatId ?? -100, type: options.chatType }
      : { id: options.chatId ?? options.userId ?? 1, type: "private" as const },
    from: options.userId === undefined ? undefined : { id: options.userId },
    message: {
      ...(options.text === undefined ? {} : { text: options.text }),
      ...(options.entities ? { entities: options.entities } : {}),
      ...(options.messageThreadId === undefined
        ? {}
        : { message_thread_id: options.messageThreadId }),
      ...(replyFrom ? { reply_to_message: { from: replyFrom } } : {}),
    },
    reply: async (text: string, replyOptionsArg?: unknown) => {
      if (isHtmlParseMode(replyOptionsArg) && options.failRichReply) {
        throw new Error("Rich reply failed");
      }

      replies.push(text);
      replyOptions.push(replyOptionsArg);
      return { message_id: nextMessageId++ };
    },
    replyWithChatAction: async () => {},
  } as unknown as Context;

  return {
    ctx,
    get documentSends() {
      return documentSends;
    },
    editOptions,
    edits,
    get photoSends() {
      return photoSends;
    },
    replies,
    replyOptions,
  };
}

function isHtmlParseMode(options: unknown): options is { parse_mode: "HTML" } {
  return Boolean(
    options &&
      typeof options === "object" &&
      "parse_mode" in options &&
      options.parse_mode === "HTML"
  );
}

export interface MockStreamControl {
  complete(reply?: string): void;
  fail(error?: Error): void;
  readonly signal: AbortSignal | undefined;
}

type StreamStep =
  | { type: "artifact"; artifact: Artifact }
  | { type: "todos"; todos: AgentTodo[] }
  | { type: "chunk"; delta: string }
  | { type: "thinking"; delta?: string }
  | { type: "tool_start" }
  | { type: "tool_end" }
  | { type: "error"; message: string }
  | { type: "resolve"; reply?: string };

export function createMultiTestOrgs(): UserOrgSummary[] {
  const now = new Date().toISOString();
  return [
    {
      createdAt: now,
      id: "org_a",
      name: "Acme",
      role: "admin",
      slug: "acme",
      updatedAt: now,
    },
    {
      createdAt: now,
      id: "org_b",
      name: "Beta",
      role: "member",
      slug: "beta",
      updatedAt: now,
    },
  ];
}

export function createDefaultTestOrgs(): UserOrgSummary[] {
  const now = new Date().toISOString();
  return [
    {
      createdAt: now,
      id: "org_test",
      name: "Test Org",
      role: "admin",
      slug: "test-org",
      updatedAt: now,
    },
  ];
}

export function createMockClient(
  options: {
    streaming?: boolean;
    steps?: StreamStep[];
    autoComplete?: boolean;
    providerConfigured?: boolean;
    profiles?: Array<{
      id: string;
      name?: string;
      model?: string | null;
      isDefault?: boolean;
      isSuper?: boolean;
    }>;
    orgs?: UserOrgSummary[];
    profilesByOrgId?: Record<
      string,
      Array<{
        id: string;
        name?: string;
        model?: string | null;
        isDefault?: boolean;
        isSuper?: boolean;
      }>
    >;
    messages?: ChatMessage[];
    artifactContentBytes?: Uint8Array;
    failCreateSession?: Error;
    failPublishShare?: boolean;
    failReadArtifact?: boolean;
  } = {}
) {
  const calls = {
    bindChannelPrincipal: 0,
    compact: 0,
    createSession: 0,
    listProfiles: 0,
    listUserOrgs: 0,
    publishProfileArtifactShare: 0,
    readProfileArtifactContent: 0,
    sendStream: 0,
    setOrgId: 0,
    transcribeAudio: 0,
  };
  const orgIds: string[] = [];
  const createSessionOrgIds: Array<string | null> = [];
  let lastCreateSessionProfileId: string | undefined;
  let lastCreateSessionExternalPrincipal: { channelUserId: string } | undefined;
  let lastStreamInput: unknown;
  const orgIdScope = new AsyncLocalStorage<{ orgId: string | null }>();

  let streamControl: MockStreamControl | null = null;
  const streamControls: MockStreamControl[] = [];

  const sendStream = async (
    input: unknown,
    handlers: unknown,
    streamOptions?: { signal?: AbortSignal }
  ) => {
    calls.sendStream += 1;
    lastStreamInput = input;

    if (!options.streaming) {
      return "Agent reply";
    }

    const streamHandlers = handlers as StreamHandlers;

    return new Promise<string>((resolve, reject) => {
      let settled = false;

      streamControl = {
        complete(reply = "Agent reply") {
          if (settled) {
            return;
          }
          settled = true;
          resolve(reply);
        },
        fail(error = new Error("Stream failed")) {
          if (settled) {
            return;
          }
          settled = true;
          reject(error);
        },
        get signal() {
          return streamOptions?.signal;
        },
      };
      streamControls.push(streamControl);

      streamOptions?.signal?.addEventListener(
        "abort",
        () => {
          if (settled) {
            return;
          }
          settled = true;
          reject(new DOMException("Aborted", "AbortError"));
        },
        { once: true }
      );

      queueMicrotask(() => {
        for (const step of options.steps ?? []) {
          if (settled) {
            break;
          }

          switch (step.type) {
            case "artifact":
              streamHandlers.onArtifactCreated?.(step.artifact);
              break;
            case "todos":
              streamHandlers.onTodosUpdated?.(step.todos);
              break;
            case "chunk":
              streamHandlers.onChunk(step.delta);
              break;
            case "thinking":
              streamHandlers.onThinking?.(step.delta ?? "");
              break;
            case "tool_start":
              streamHandlers.onToolStart?.({
                input: {},
                tool: "todo_write",
                toolCallId: "tool_call_1",
              });
              break;
            case "tool_end":
              streamHandlers.onToolEnd?.({
                result: {},
                tool: "todo_write",
                toolCallId: "tool_call_1",
              });
              break;
            case "error":
              streamControl?.fail(new Error(step.message));
              break;
            case "resolve":
              streamControl?.complete(step.reply);
              break;
          }
        }

        if (
          !settled &&
          options.steps?.length &&
          options.autoComplete !== false
        ) {
          streamControl?.complete("Agent reply");
        }
      });
    });
  };

  const session = {
    clear: async () => {},
    compact: async () => {
      calls.compact += 1;
      return {
        action: "summarized" as const,
        messagesAfter: 4,
        messagesBefore: 10,
      };
    },
    createAutomation: async () => ({}),
    getMessages: async () => options.messages ?? [],
    id: "session_test",
    purge: async () => {},
    send: async () => "ok",
    sendStream,
  };

  const profiles = options.profiles ?? [{ id: "default", model: null }];
  const orgs = options.orgs ?? createDefaultTestOrgs();
  let activeOrgId: string | null = orgs[0]?.id ?? null;

  const currentOrgId = () => orgIdScope.getStore()?.orgId ?? activeOrgId;

  const client = {
    bindChannelPrincipal: async () => {
      calls.bindChannelPrincipal += 1;
      return {
        orgId: currentOrgId() ?? "org_test",
        userId: "user_test",
      };
    },
    createChatSession: () => session,
    createSession: async (
      _channel: string,
      input?: {
        profileId?: string;
        externalPrincipal?: { channelUserId: string };
      }
    ) => {
      calls.createSession += 1;
      if (options.failCreateSession) {
        throw options.failCreateSession;
      }
      lastCreateSessionProfileId = input?.profileId;
      lastCreateSessionExternalPrincipal = input?.externalPrincipal;
      createSessionOrgIds.push(currentOrgId());
      return session;
    },
    getModels: async () => ({
      currentProviderId: null,
      displayName: null,
      models: [],
      provider: null,
      providers: [],
    }),
    health: async () => ({
      ok: true,
      providerConfigured: options.providerConfigured ?? false,
    }),
    isolateOrgId: <T>(fn: () => T | Promise<T>) =>
      orgIdScope.run({ orgId: activeOrgId }, fn),
    listProfiles: async (orgIdOverride?: string) => {
      calls.listProfiles += 1;
      const orgId = orgIdOverride ?? currentOrgId();
      const scopedProfiles =
        (orgId ? options.profilesByOrgId?.[orgId] : undefined) ?? profiles;

      return parseListProfilesResponse({
        profiles: scopedProfiles.map((profile) => ({
          id: profile.id,
          isDefault: profile.isDefault ?? false,
          isSuper: profile.isSuper ?? false,
          model: profile.model ?? null,
          name: profile.name ?? profile.id,
        })),
      });
    },
    listUserOrgs: async () => {
      calls.listUserOrgs += 1;
      return parseListUserOrgsResponse({ orgs });
    },
    publishProfileArtifactShare: async () => {
      calls.publishProfileArtifactShare += 1;
      if (options.failPublishShare) {
        throw new Error("publish failed");
      }
      return {
        id: "share_test",
        refreshed: false,
        sharePath: "/s/tok_test",
        shareUrl: "https://app.example/s/tok_test",
        token: "tok_test",
        webPublicUrlConfigured: true,
      };
    },
    readProfileArtifactContent: async () => {
      calls.readProfileArtifactContent += 1;
      if (options.failReadArtifact) {
        throw new Error("Failed to read the saved file.");
      }
      const data =
        options.artifactContentBytes ?? new TextEncoder().encode("# Report");
      return {
        contentType: "text/markdown",
        data: data.buffer,
      };
    },
    setOrgId: (orgId: string | null) => {
      calls.setOrgId += 1;
      const next = orgId?.trim() || null;
      const scope = orgIdScope.getStore();
      if (scope) {
        scope.orgId = next;
      } else {
        activeOrgId = next;
      }
      orgIds.push(next ?? "");
    },
    transcribeAudio: async () => {
      calls.transcribeAudio += 1;
      return { text: "Transcribed voice message" };
    },
  } as unknown as AtlasClient;

  assertBridgeClientMethods(client);

  return {
    calls,
    client,
    getCreateSessionOrgIds: () => createSessionOrgIds,
    getLastCreateSessionExternalPrincipal: () =>
      lastCreateSessionExternalPrincipal,
    getLastCreateSessionProfileId: () => lastCreateSessionProfileId,
    getLastStreamInput: () => lastStreamInput,
    getStreamControl: () => streamControl,
    getStreamControls: () => streamControls,
    orgIds,
  };
}

export async function writeTelegramConfigIni(
  homeDir: string,
  config: {
    botToken: string;
    profileId?: string;
    handshakeCode?: string | null;
    handshakeAssertion?: string | null;
    pairedUserIds?: number[];
    allowedUserIds?: number[];
  }
): Promise<void> {
  const dir = path.join(homeDir, ".atlas", "telegram");
  await mkdir(dir, { recursive: true });

  const lines = [
    "# Atlas Telegram bridge",
    `bot_token=${config.botToken}`,
    `profile_id=${config.profileId ?? "default"}`,
  ];

  if (config.handshakeCode) {
    lines.push(`handshake_code=${config.handshakeCode}`);
  }

  if (config.handshakeAssertion) {
    lines.push(`handshake_assertion=${config.handshakeAssertion}`);
  }

  if (config.pairedUserIds?.length) {
    lines.push(`paired_user_ids=${config.pairedUserIds.join(",")}`);
  }

  if (config.allowedUserIds?.length) {
    lines.push(`allowed_user_ids=${config.allowedUserIds.join(",")}`);
  }

  lines.push("");
  await writeFile(path.join(dir, "config.ini"), lines.join("\n"), "utf8");
}

export function createTestOrgStore(homeDir: string): ChannelOrgStore {
  return new ChannelOrgStore(
    path.join(homeDir, ".atlas", "telegram", "org-selection.json")
  );
}

export async function withTempHome<T>(
  run: (homeDir: string) => Promise<T>
): Promise<T> {
  return withIsolatedAtlasHome("atlas-telegram-home-", run);
}

import { beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage, ProfileSummary } from "@atlas/core/contract";
import { MAX_DOCUMENT_BYTES } from "@atlas/core/message-content";
import { resetActiveStreamsForTests } from "./active-stream";
import { formatSavedWhatsAppDocumentMessage } from "./attachments";
import { WhatsAppAuthStore } from "./auth-store";
import {
  createChatHandler,
  isTransientWhatsAppSendError,
  resetChatLocksForTests,
  resolveWhatsAppSessionKey,
  WhatsAppChatBusyError,
  WhatsAppDeliveryRetryableError,
  withChatLock,
} from "./chat-handler";
import { WhatsAppInboundReplaySafeError } from "./delivery-error";
import { parseInboundWhatsAppMessage } from "./inbound-message";
import { SessionStore } from "./session-store";
import { runClaimedInboundDelivery } from "./socket";
import {
  createMockClient,
  createMultiTestOrgs,
  createTestOrgStore,
  waitForStreamControl,
  withTempHome,
  writeWhatsAppConfigIni,
} from "./test-helpers";

const PAIRED_JID = "1234567890@s.whatsapp.net";
const GROUP_JID = "120363042000000000@g.us";
const OTHER_GROUP_JID = "120363043000000000@g.us";
const TINY_JPEG_BYTES = Buffer.from(
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMQD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABLAAEBAAAAAAAAAAAAAAAAAAAABwEBAAAAAAAAAAAAAAAAAAAAABABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAIAAgMBIgACEQADEQD/2gAMAwEAAhEDEQA/AL+AD//Z",
  "base64"
);
const BOT_ME = {
  id: "628100000000:12@s.whatsapp.net",
  lid: "236283431522503:0@lid",
};

function createProfileSummary(input: {
  id: string;
  isDefault?: boolean;
  isSuper?: boolean;
  name: string;
}): ProfileSummary {
  const now = new Date().toISOString();
  return {
    createdAt: now,
    hasAvatar: false,
    id: input.id,
    isDefault: input.isDefault ?? false,
    isSuper: input.isSuper ?? false,
    mcpServerCount: 0,
    model: null,
    name: input.name,
    soulActive: false,
    toolCount: 0,
    updatedAt: now,
  };
}

function groupInbound(options: {
  jid?: string;
  mentionedJids?: string[];
  quotedParticipant?: string | null;
  quotedText?: string | null;
  quotedMessageId?: string | null;
  senderJid?: string;
  senderJids?: string[];
  senderPn?: string | null;
  text: string;
}) {
  const senderJid = options.senderJid ?? PAIRED_JID;
  return {
    isGroup: true,
    jid: options.jid ?? GROUP_JID,
    me: BOT_ME,
    mentionedJids: options.mentionedJids ?? [],
    quotedMessageId: options.quotedMessageId ?? null,
    quotedParticipant: options.quotedParticipant ?? null,
    quotedText: options.quotedText ?? null,
    senderJid,
    senderJids: options.senderJids ?? [senderJid],
    senderPn: options.senderPn ?? null,
    text: options.text,
  };
}

function createMockSocket(options?: {
  failDocumentSend?: boolean;
  failTextSend?: boolean;
  hangTextSend?: boolean;
}) {
  const sent: Array<{
    document?: unknown;
    fileName?: string;
    image?: unknown;
    jid: string;
    mimetype?: string;
    quoted?: unknown;
    text?: string;
  }> = [];
  const sentIndexById = new Map<string, number>();
  let nextMessageId = 1;

  const socket = {
    end: () => {},
    ev: {
      off: () => {},
      on: () => {},
    },
    sendMessage: async (
      jid: string,
      content: {
        document?: unknown;
        edit?: { id?: string | null };
        fileName?: string;
        image?: unknown;
        mimetype?: string;
        text?: string;
      },
      sendOptions?: { quoted?: unknown }
    ) => {
      if (content.document && options?.failDocumentSend) {
        throw new Error("WhatsApp document send failed");
      }

      if (content.text && options?.failTextSend) {
        throw new Error("WhatsApp socket disconnected");
      }

      if (content.text && options?.hangTextSend) {
        await new Promise<void>(() => undefined);
      }

      const editedMessageId = content.edit?.id?.trim();
      if (editedMessageId) {
        const index = sentIndexById.get(editedMessageId);
        if (index !== undefined) {
          const previous = sent[index];
          if (previous) {
            sent[index] = { ...previous, text: content.text };
          }
        }
        return { key: content.edit };
      }

      sent.push({
        document: content.document,
        fileName: content.fileName,
        image: content.image,
        jid,
        mimetype: content.mimetype,
        quoted: sendOptions?.quoted,
        text: content.text,
      });
      const id = String(nextMessageId);
      nextMessageId += 1;
      sentIndexById.set(id, sent.length - 1);
      return { key: { fromMe: true, id, remoteJid: jid } };
    },
    sendPresenceUpdate: async () => {},
  };

  return { sent, socket };
}

beforeEach(() => {
  resetActiveStreamsForTests();
  resetChatLocksForTests();
});

async function waitForCondition(
  condition: () => boolean,
  message: string
): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(message);
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

describe("withChatLock", () => {
  test("times out queued turns without running them or releasing the active holder", async () => {
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      signalFirstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstRuns = 0;
    const first = withChatLock("same-chat", async () => {
      firstRuns += 1;
      signalFirstStarted();
      await firstGate;
    });
    await firstStarted;

    let secondRuns = 0;
    const secondError = await captureError(
      withChatLock(
        "same-chat",
        async () => {
          secondRuns += 1;
        },
        10
      )
    );

    expect(secondError).toBeInstanceOf(WhatsAppChatBusyError);
    expect(secondError).toMatchObject({
      code: "WHATSAPP_CHAT_BUSY",
      retryable: true,
    });
    expect(secondRuns).toBe(0);

    let thirdRuns = 0;
    const thirdError = await captureError(
      withChatLock(
        "same-chat",
        async () => {
          thirdRuns += 1;
        },
        10
      )
    );

    expect(thirdError).toBeInstanceOf(WhatsAppChatBusyError);
    expect(thirdRuns).toBe(0);
    expect(firstRuns).toBe(1);

    releaseFirst();
    await first;
    await Promise.resolve();
    expect(secondRuns).toBe(0);
    expect(thirdRuns).toBe(0);

    let nextRuns = 0;
    await withChatLock(
      "same-chat",
      async () => {
        nextRuns += 1;
      },
      10
    );
    expect(nextRuns).toBe(1);
  });
});

describe("WhatsApp outbound retry classification", () => {
  test("retries only errors that identify a transient connection failure", () => {
    expect(
      isTransientWhatsAppSendError(
        Object.assign(new Error("connection reset"), { code: "ECONNRESET" })
      )
    ).toBe(true);
    expect(isTransientWhatsAppSendError({ output: { statusCode: 503 } })).toBe(
      true
    );
    expect(isTransientWhatsAppSendError(new Error("invalid recipient"))).toBe(
      false
    );
  });
});
interface GroupHarness {
  clientMock: ReturnType<typeof createMockClient>;
  handleMessage: ReturnType<typeof createChatHandler>;
  orgStore: ReturnType<typeof createTestOrgStore>;
  recreateHandler: () => ReturnType<typeof createChatHandler>;
  sent: ReturnType<typeof createMockSocket>["sent"];
  sessionStore: SessionStore;
}

type DirectArtifact = ReturnType<
  SessionStore["getDeliverableArtifacts"]
>[number];

interface DirectArtifactHarness {
  clientMock: ReturnType<typeof createMockClient>;
  getDownloadCalls: () => number;
  handleMessage: ReturnType<typeof createChatHandler>;
  sent: ReturnType<typeof createMockSocket>["sent"];
  sessionStore: SessionStore;
}

async function withDirectArtifactHarness(
  options: {
    artifacts?: DirectArtifact[];
    client?: NonNullable<Parameters<typeof createMockClient>[0]>;
    failDocumentSend?: boolean;
  },
  run: (harness: DirectArtifactHarness) => Promise<void>
): Promise<void> {
  await withTempHome(async (homeDir) => {
    await writeWhatsAppConfigIni(homeDir, {
      pairedJid: PAIRED_JID,
      phoneNumber: "1234567890",
    });
    const authStore = new WhatsAppAuthStore();
    await authStore.reload();
    const clientMock = createMockClient(options.client);
    const sessionStore = new SessionStore(
      path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
    );
    await sessionStore.load();
    sessionStore.set(PAIRED_JID, {
      deliverableArtifacts: options.artifacts ?? [],
      profileId: "default",
      sessionId: "session_test",
      updatedAt: new Date().toISOString(),
    });
    await sessionStore.save();
    const orgStore = createTestOrgStore(homeDir);
    await orgStore.load();
    const { socket, sent } = createMockSocket({
      failDocumentSend: options.failDocumentSend,
    });
    let downloadCalls = 0;
    const handleMessage = createChatHandler({
      authStore,
      client: clientMock.client,
      config: { phoneNumber: "1234567890", profileId: "default" },
      downloadMedia: async () => {
        downloadCalls += 1;
        return Buffer.from("incoming");
      },
      getSocket: () => socket as any,
      orgStore,
      sessionStore,
    });

    await run({
      clientMock,
      getDownloadCalls: () => downloadCalls,
      handleMessage,
      sent,
      sessionStore,
    });
  });
}

async function withGroupHarness(
  options: {
    accessMode?: string;
    allowedNumbers?: string[];
    failCreateSession?: Error;
    fixedWorkspaceId?: string;
    downloadMedia?: Parameters<typeof createChatHandler>[0]["downloadMedia"];
    orgs?: ReturnType<typeof createMultiTestOrgs>;
    pairingCode?: string | null;
    pairedJid?: string | null;
    profiles?: ProfileSummary[];
    streaming?: boolean;
  },
  run: (harness: GroupHarness) => Promise<void>
): Promise<void> {
  await withTempHome(async (homeDir) => {
    await writeWhatsAppConfigIni(homeDir, {
      accessMode: options.accessMode,
      allowedNumbers: options.allowedNumbers,
      pairedJid:
        options.pairedJid === undefined ? PAIRED_JID : options.pairedJid,
      pairingCode: options.pairingCode,
      phoneNumber: "1234567890",
    });
    const authStore = new WhatsAppAuthStore();
    await authStore.reload();
    const clientMock = createMockClient({
      failCreateSession: options.failCreateSession,
      orgs: options.orgs,
      profiles: options.profiles,
      streaming: options.streaming,
    });
    const sessionStore = new SessionStore(
      path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
    );
    await sessionStore.load();
    const orgStore = createTestOrgStore(homeDir);
    await orgStore.load();
    const { socket, sent } = createMockSocket();
    const recreateHandler = () =>
      createChatHandler({
        authStore,
        client: clientMock.client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        downloadMedia: options.downloadMedia,
        fixedWorkspaceId: options.fixedWorkspaceId,
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

    const handleMessage = recreateHandler();
    await run({
      clientMock,
      handleMessage,
      orgStore,
      recreateHandler,
      sent,
      sessionStore,
    });
  });
}

describe("createChatHandler", () => {
  test("marks config-read failures before the rate limiter as replay safe", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        phoneNumber: "1234567890",
      });
      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const failure = new Error("config read failed");
      authStore.reload = async () => {
        throw failure;
      };
      const clientMock = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      await sessionStore.load();
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client: clientMock.client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      const error = await captureError(
        handleMessage({
          jid: "628199999999@s.whatsapp.net",
          text: "hello",
        })
      );

      expect(error).toBeInstanceOf(WhatsAppInboundReplaySafeError);
      expect((error as Error).cause).toBe(failure);
    });
  });

  test("does not replay an unmarked failure after the rate-limit boundary", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });
      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const originalReload = authStore.reload.bind(authStore);
      const failure = new Error("post-rate-limit config read failed");
      let reloadCalls = 0;
      authStore.reload = async () => {
        reloadCalls += 1;
        if (reloadCalls === 2) {
          throw failure;
        }
        await originalReload();
      };
      const clientMock = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      await sessionStore.load();
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client: clientMock.client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });
      const completed: string[] = [];
      let handlerCalls = 0;

      const result = await runClaimedInboundDelivery({
        deliver: async () => {
          handlerCalls += 1;
          await handleMessage({
            fromMe: true,
            jid: PAIRED_JID,
            text: "hello",
          });
        },
        deliveryId: "post-rate-limit-failure",
        ledger: {
          complete: async (id) => {
            completed.push(id);
          },
          release: () => undefined,
        },
        retryBaseDelayMs: 0,
      });

      expect(result).toEqual({
        attempts: 1,
        disposition: "delivery-error-recorded",
        error: failure,
      });
      expect(handlerCalls).toBe(1);
      expect(reloadCalls).toBe(2);
      expect(completed).toEqual(["post-rate-limit-failure"]);
    });
  });

  test("blocks unauthorized JID from chatting", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairingCode: "ABCD1234",
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient({
        profiles: [
          {
            createdAt: new Date().toISOString(),
            hasAvatar: false,
            id: "default",
            isSuper: false,
            mcpServerCount: 0,
            model: null,
            name: "Default",
            soulActive: false,
            toolCount: 0,
            updatedAt: new Date().toISOString(),
          },
          {
            createdAt: new Date().toISOString(),
            hasAvatar: false,
            id: "profile_tensetutor",
            isSuper: false,
            mcpServerCount: 0,
            model: null,
            name: "Tense Tutor",
            soulActive: false,
            toolCount: 0,
            updatedAt: new Date().toISOString(),
          },
        ],
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();

      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({ jid: "9999999999@s.whatsapp.net", text: "hello" });

      expect(sent.length).toBeGreaterThanOrEqual(1);
      expect(calls.createSession).toBe(0);
      expect(calls.sendStream).toBe(0);
    });
  });

  test("stays silent for unauthorized private chats when no access code exists", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      await sessionStore.load();
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({
        jid: "628199999999@s.whatsapp.net",
        text: "/start",
      });
      await handleMessage({
        jid: "628199999999@s.whatsapp.net",
        text: "hello",
      });

      expect(sent).toEqual([]);
      expect(calls.createSession).toBe(0);
      expect(calls.sendStream).toBe(0);
    });
  });

  test("rejects invalid chat access codes", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairingCode: "ABCD1234",
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient({
        profiles: [
          {
            createdAt: new Date().toISOString(),
            hasAvatar: false,
            id: "default",
            isSuper: false,
            mcpServerCount: 0,
            model: null,
            name: "Default",
            soulActive: false,
            toolCount: 0,
            updatedAt: new Date().toISOString(),
          },
          {
            createdAt: new Date().toISOString(),
            hasAvatar: false,
            id: "profile_tensetutor",
            isSuper: false,
            mcpServerCount: 0,
            model: null,
            name: "Tense Tutor",
            soulActive: false,
            toolCount: 0,
            updatedAt: new Date().toISOString(),
          },
        ],
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();

      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({ jid: "9999999999@s.whatsapp.net", text: "WRONG" });

      expect(sent.length).toBe(1);
      expect(sent[0].text).toContain("chat access code is invalid");
      expect(calls.sendStream).toBe(0);
    });
  });

  test("pairs a JID with a valid code and allows chatting", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairingAssertion: "assertion_valid",
        pairingCode: "ABCD1234",
        pairingUserId: "user_admin",
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient({
        boundPrincipalUserId: "user_admin",
        profiles: [
          {
            createdAt: new Date().toISOString(),
            hasAvatar: false,
            id: "default",
            isSuper: false,
            mcpServerCount: 0,
            model: null,
            name: "Default",
            soulActive: false,
            toolCount: 0,
            updatedAt: new Date().toISOString(),
          },
          {
            createdAt: new Date().toISOString(),
            hasAvatar: false,
            id: "profile_tensetutor",
            isSuper: false,
            mcpServerCount: 0,
            model: null,
            name: "Tense Tutor",
            soulActive: false,
            toolCount: 0,
            updatedAt: new Date().toISOString(),
          },
        ],
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();

      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        fixedWorkspaceId: "org_test",
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      const pairJid = "1234567890@s.whatsapp.net";
      await handleMessage({ jid: pairJid, text: "ABCD1234" });

      expect(sent.length).toBe(1);
      expect(sent[0]!.text).toContain("Chat authorized");
      expect(calls.bindChannelPrincipal).toBe(1);
      expect(calls.bindExpectedUserIds).toEqual(["user_admin"]);
      expect(calls.bindPairingAssertions).toEqual(["assertion_valid"]);
      expect(authStore.isAuthorized(pairJid)).toBe(true);

      await handleMessage({ jid: pairJid, text: "hello agent" });
      expect(calls.createSession).toBe(1);
      expect(calls.sendStream).toBe(1);
    });
  });

  test("does not authorize or consume local pairing state when principal binding fails", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairingAssertion: "assertion_retryable",
        pairingCode: "ABCD1234",
        pairingUserId: "user_admin",
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient({
        boundPrincipalUserId: "user_admin",
        failBindChannelPrincipal: new Error("binding unavailable"),
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        fixedWorkspaceId: "org_test",
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({ jid: PAIRED_JID, text: "ABCD1234" });

      expect(calls.bindChannelPrincipal).toBe(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.text).not.toContain("Chat authorized");
      expect(sent[0]?.text).toContain("still active");
      expect(authStore.isAuthorized(PAIRED_JID)).toBe(false);
      expect(authStore.getConfig()).toMatchObject({
        pairedJid: null,
        pairingAssertion: "assertion_retryable",
        pairingCode: "ABCD1234",
        pairingUserId: "user_admin",
      });
    });
  });

  test("re-pairing A to B drops every cached session for that WhatsApp identity", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        pairingAssertion: "assertion_user_b",
        pairingCode: "ABCD1234",
        pairingUserId: "user_b",
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient({
        boundPrincipalUserId: "user_b",
      });
      const sessionPath = path.join(
        homeDir,
        ".atlas",
        "whatsapp",
        "chat-sessions.json"
      );
      const sessionStore = new SessionStore(sessionPath);
      const oldSession = {
        channelUserId: PAIRED_JID,
        profileId: "default",
        sessionId: "session_user_a",
        updatedAt: new Date().toISOString(),
      };
      const groupSessionKey = resolveWhatsAppSessionKey(GROUP_JID, PAIRED_JID);
      sessionStore.set(PAIRED_JID, oldSession);
      sessionStore.set(groupSessionKey, oldSession);
      await sessionStore.save();

      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        fixedWorkspaceId: "org_test",
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({ jid: PAIRED_JID, text: "ABCD1234" });

      expect(sent.at(-1)?.text).toContain("Chat authorized");
      expect(calls.bindChannelPrincipal).toBe(1);
      expect(sessionStore.get(PAIRED_JID)).toBeUndefined();
      expect(sessionStore.get(groupSessionKey)).toBeUndefined();

      const persistedStore = new SessionStore(sessionPath);
      await persistedStore.load();
      expect(persistedStore.get(PAIRED_JID)).toBeUndefined();
      expect(persistedStore.get(groupSessionKey)).toBeUndefined();

      await handleMessage({ jid: PAIRED_JID, text: "hello as user B" });

      expect(calls.createSession).toBe(1);
      expect(calls.externalPrincipalIds).toEqual([PAIRED_JID]);
      expect(sessionStore.get(PAIRED_JID)?.sessionId).toBe("session_test");
    });
  });

  test("auto-pairs owner LID when fromMe is true and pairedJid is linked", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        pairedLid: "stale_device:1@lid",
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient({
        profiles: [
          {
            createdAt: new Date().toISOString(),
            hasAvatar: false,
            id: "default",
            isSuper: false,
            mcpServerCount: 0,
            model: null,
            name: "Default",
            soulActive: false,
            toolCount: 0,
            updatedAt: new Date().toISOString(),
          },
        ],
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket } = createMockSocket();

      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      const realAccountLid = "154352568283178@lid";
      await handleMessage({ fromMe: true, jid: realAccountLid, text: "hello" });

      expect(calls.createSession).toBe(1);
      expect(calls.sendStream).toBe(1);

      await authStore.reload();
      expect(authStore.getConfig()?.pairedLid).toBe(realAccountLid);
    });
  });

  test("allows pre-paired JID to chat directly", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient({
        profiles: [
          {
            createdAt: new Date().toISOString(),
            hasAvatar: false,
            id: "default",
            isSuper: false,
            mcpServerCount: 0,
            model: null,
            name: "Default",
            soulActive: false,
            toolCount: 0,
            updatedAt: new Date().toISOString(),
          },
          {
            createdAt: new Date().toISOString(),
            hasAvatar: false,
            id: "profile_tensetutor",
            isSuper: false,
            mcpServerCount: 0,
            model: null,
            name: "Tense Tutor",
            soulActive: false,
            toolCount: 0,
            updatedAt: new Date().toISOString(),
          },
        ],
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket } = createMockSocket();

      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({ jid: PAIRED_JID, text: "hello agent" });

      expect(calls.createSession).toBe(1);
      expect(calls.sendStream).toBe(1);
    });
  });

  test("quotes the inbound message on the first reply bubble", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      const inbound = {
        key: { fromMe: false, id: "m1", remoteJid: PAIRED_JID },
        message: { conversation: "hello agent" },
      };

      await handleMessage({
        inbound,
        jid: PAIRED_JID,
        text: "hello agent",
      });

      expect(
        sent.find((message) => message.text === "Agent reply")?.quoted
      ).toBe(inbound);
    });
  });

  test("allows device-suffixed inbound JID for a paired phone JID", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: "6281379292556@s.whatsapp.net",
        phoneNumber: "6281379292556",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient({
        profiles: [
          {
            createdAt: new Date().toISOString(),
            hasAvatar: false,
            id: "default",
            isSuper: false,
            mcpServerCount: 0,
            model: null,
            name: "Default",
            soulActive: false,
            toolCount: 0,
            updatedAt: new Date().toISOString(),
          },
          {
            createdAt: new Date().toISOString(),
            hasAvatar: false,
            id: "profile_tensetutor",
            isSuper: false,
            mcpServerCount: 0,
            model: null,
            name: "Tense Tutor",
            soulActive: false,
            toolCount: 0,
            updatedAt: new Date().toISOString(),
          },
        ],
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket } = createMockSocket();

      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "6281379292556", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({
        jid: "6281379292556:12@s.whatsapp.net",
        text: "hello agent",
      });

      expect(calls.createSession).toBe(1);
      expect(calls.sendStream).toBe(1);

      await handleMessage({
        jid: "6281379292556@s.whatsapp.net",
        text: "follow up",
      });

      expect(calls.createSession).toBe(1);
      expect(calls.sendStream).toBe(2);
      expect(
        sessionStore.get("6281379292556:12@s.whatsapp.net")?.sessionId
      ).toBe(sessionStore.get("6281379292556@s.whatsapp.net")?.sessionId);
    });
  });

  test("pairs when an unauthorized photo caption is the access code", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairingAssertion: "assertion_photo",
        pairingCode: "ABCD1234",
        pairingUserId: "user_admin",
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient({
        boundPrincipalUserId: "user_admin",
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        fixedWorkspaceId: "org_test",
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({
        inbound: {
          key: { fromMe: false, remoteJid: "6282000000001@s.whatsapp.net" },
          message: {
            imageMessage: {
              caption: "ABCD1234",
              mimetype: "image/jpeg",
            },
          },
        } as never,
        jid: "6282000000001@s.whatsapp.net",
        text: "ABCD1234",
      });

      expect(calls.sendStream).toBe(0);
      expect(authStore.isAuthorized("6282000000001@s.whatsapp.net")).toBe(true);
      expect(
        sent.some((message) => message.text?.includes("Chat authorized"))
      ).toBe(true);
    });
  });

  test("handles /help as an unauthorized photo caption", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairingCode: "ABCD1234",
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });
      const jid = "6282000000001@s.whatsapp.net";

      await handleMessage({
        inbound: {
          key: { fromMe: false, remoteJid: jid },
          message: {
            imageMessage: {
              caption: "/help",
              mimetype: "image/jpeg",
            },
          },
        } as never,
        jid,
        text: "/help",
      });

      expect(calls.sendStream).toBe(0);
      expect(authStore.isAuthorized(jid)).toBe(false);
      const reply = sent.map((message) => message.text ?? "").join("\n");
      expect(reply).toContain("has not authorized");
      expect(reply).toContain("/help");
    });
  });

  test("handles /help command for authorized JID", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();

      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({ jid: PAIRED_JID, text: "/help" });

      expect(sent.some((message) => message.text?.includes("/help"))).toBe(
        true
      );
      expect(calls.sendStream).toBe(0);
    });
  });

  test("handles /help even when the same message includes a photo", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        downloadMedia: async () => Buffer.from("image-bytes"),
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({
        inbound: {
          key: { fromMe: false, id: "img-1", remoteJid: PAIRED_JID },
          message: {
            imageMessage: {
              caption: "/help",
              mimetype: "image/jpeg",
            },
          },
        },
        jid: PAIRED_JID,
        text: "/help",
      });

      expect(calls.sendStream).toBe(0);
      expect(sent.some((message) => message.text?.includes("/help"))).toBe(
        true
      );
    });
  });

  test("handles /clear command", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();

      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({ jid: PAIRED_JID, text: "/clear" });

      expect(calls.compact).toBe(0);
      expect(sent.length).toBe(1);
      expect(sent[0].text).toBe("History cleared.");
    });
  });

  test("handles /compact command", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();

      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({ jid: PAIRED_JID, text: "/compact" });

      expect(calls.compact).toBe(1);
      expect(sent.length).toBe(1);
      expect(sent[0].text).toContain("Compacted");
    });
  });

  test("replaces live work updates with one terminal reply", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client } = createMockClient({
        steps: [
          { type: "thinking" },
          { type: "tool_start" },
          { delta: "Finished.", type: "chunk" },
          { reply: "Finished.", type: "resolve" },
        ],
        streaming: true,
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({ jid: PAIRED_JID, text: "do the work" });

      expect(sent.map((message) => message.text)).toEqual(["Finished."]);

      const errorClient = createMockClient({
        steps: [
          { type: "thinking" },
          { message: "tool failed", type: "error" },
        ],
        streaming: true,
      });
      const errorSocket = createMockSocket();
      const errorSessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "error-chat-sessions.json")
      );
      const errorHandler = createChatHandler({
        authStore,
        client: errorClient.client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => errorSocket.socket as any,
        orgStore,
        sessionStore: errorSessionStore,
      });

      await errorHandler({ jid: PAIRED_JID, text: "fail the work" });

      expect(errorSocket.sent.map((message) => message.text)).toEqual([
        "⚠️ tool failed",
      ]);
    });
  });

  test("/stop aborts an in-flight stream without waiting for the chat lock", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls, getStreamControl } = createMockClient({
        autoComplete: false,
        steps: [{ type: "thinking" }],
        streaming: true,
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();

      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      const chatPromise = handleMessage({
        jid: PAIRED_JID,
        text: "hello agent",
      });

      await waitForStreamControl(getStreamControl);

      await handleMessage({ jid: PAIRED_JID, text: "/stop" });

      await chatPromise;

      expect(calls.sendStream).toBe(1);
      expect(sent.map((message) => message.text)).toEqual(["Stopped."]);
    });
  });

  test("/stop cancels media preprocessing before the agent turn", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();
      let downloadStarted = false;
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        downloadMedia: async () => {
          downloadStarted = true;
          return await new Promise<Buffer>(() => {});
        },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      const pending = handleMessage({
        inbound: {
          key: { fromMe: false, id: "image-stall", remoteJid: PAIRED_JID },
          message: { imageMessage: { mimetype: "image/jpeg" } },
        },
        jid: PAIRED_JID,
        text: "",
      });
      await waitForCondition(
        () => downloadStarted,
        "Expected the media download to start"
      );
      await handleMessage({ jid: PAIRED_JID, text: "/stop" });
      await pending;

      expect(calls.sendStream).toBe(0);
      expect(sent.map((message) => message.text)).toEqual(["Stopped."]);
    });
  });

  test("/stop with no active stream replies nothing to stop", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();

      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({ jid: PAIRED_JID, text: "/stop" });

      expect(sent.length).toBe(1);
      expect(sent[0].text).toBe("Nothing to stop.");
    });
  });

  test("throws retryable delivery errors when the socket is unavailable or disconnected", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();

      const unavailableHandler = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => null,
        orgStore,
        sendRetryAttempts: 1,
        sessionStore,
      });
      const unavailableError = await captureError(
        unavailableHandler({ jid: PAIRED_JID, text: "/stop" })
      );

      expect(unavailableError).toBeInstanceOf(WhatsAppDeliveryRetryableError);
      expect(unavailableError).toMatchObject({
        code: "WHATSAPP_DELIVERY_RETRYABLE",
        retryable: true,
      });

      const { socket } = createMockSocket({ failTextSend: true });
      const disconnectedHandler = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sendRetryAttempts: 1,
        sessionStore,
      });
      const disconnectedError = await captureError(
        disconnectedHandler({ jid: PAIRED_JID, text: "/stop" })
      );

      expect(disconnectedError).toBeInstanceOf(WhatsAppDeliveryRetryableError);
      expect(disconnectedError).toMatchObject({
        cause: expect.any(Error),
        code: "WHATSAPP_DELIVERY_RETRYABLE",
        retryable: true,
      });
      expect(calls.sendStream).toBe(0);
    });
  });

  test("times out a stalled socket send without holding the chat forever", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket } = createMockSocket({ hangTextSend: true });
      const handler = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sendTimeoutMs: 5,
        sessionStore,
      });

      const error = await captureError(
        handler({ jid: PAIRED_JID, text: "/stop" })
      );

      expect(error).toBeInstanceOf(WhatsAppDeliveryRetryableError);
      expect(error).toMatchObject({
        cause: expect.objectContaining({ message: "WhatsApp send timed out." }),
        retryable: true,
      });
    });
  });

  test("retries only the transiently failed reply chunk", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const firstChunk = "A".repeat(400);
      const secondChunk = "B".repeat(400);
      const reply = `${firstChunk} ${secondChunk}`;
      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient({
        steps: [{ reply, type: "resolve" }],
        streaming: true,
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const textAttempts: string[] = [];
      let transientFailureInjected = false;
      const socket = {
        sendMessage: async (
          _jid: string,
          content: { text?: string }
        ): Promise<void> => {
          if (!content.text) {
            return;
          }
          textAttempts.push(content.text);
          if (content.text === secondChunk && !transientFailureInjected) {
            transientFailureInjected = true;
            throw Object.assign(new Error("socket disconnected"), {
              code: "ECONNRESET",
            });
          }
        },
        sendPresenceUpdate: async (): Promise<void> => undefined,
      };
      const handler = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sendRetryBaseDelayMs: 0,
        sessionStore,
      });

      await handler({ jid: PAIRED_JID, text: "hello" });

      expect(calls.sendStream).toBe(1);
      expect(textAttempts).toEqual([firstChunk, secondChunk, secondChunk]);
    });
  });

  test("unknown commands return help text", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();

      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({ jid: PAIRED_JID, text: "/unknown" });

      expect(sent.length).toBe(1);
      expect(sent[0].text).toContain("Unknown command");
      expect(calls.sendStream).toBe(0);
    });
  });

  test("falls back to an existing profile when config points to a missing one", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
        profileId: "missing_profile",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient({
        profiles: [
          {
            createdAt: new Date().toISOString(),
            hasAvatar: false,
            id: "profile_tensetutor",
            isSuper: false,
            mcpServerCount: 0,
            model: null,
            name: "Tense Tutor",
            soulActive: false,
            toolCount: 0,
            updatedAt: new Date().toISOString(),
          },
        ],
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();

      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({ jid: PAIRED_JID, text: "/new" });

      expect(calls.listProfiles).toBe(1);
      expect(calls.profileIds).toEqual(["profile_tensetutor"]);
      expect(sent[0]?.text).toContain("Started a new conversation.");
    });
  });
});

describe("bridge API integration", () => {
  test("calls org and profile APIs before creating a chat session", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls, orgIds } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({ jid: PAIRED_JID, text: "hello" });

      expect(calls.listUserOrgs).toBeGreaterThanOrEqual(1);
      expect(calls.setOrgId).toBeGreaterThanOrEqual(1);
      expect(orgIds).toContain("org_test");
      expect(calls.listProfiles).toBeGreaterThanOrEqual(1);
      expect(calls.createSession).toBe(1);
      expect(calls.sendStream).toBe(1);
    });
  });

  test("auto-selects a single org without prompting", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({ jid: PAIRED_JID, text: "hello" });

      expect(
        sent.some((message) => message.text.includes("Choose an organization"))
      ).toBe(false);
      expect(orgStore.get(PAIRED_JID)?.orgId).toBe("org_test");
    });
  });

  test("prompts for org selection when multiple orgs exist", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient({
        orgs: createMultiTestOrgs(),
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({ jid: PAIRED_JID, text: "hello" });

      expect(
        sent.some((message) => message.text.includes("Choose an organization"))
      ).toBe(true);
      expect(calls.createSession).toBe(0);
      expect(calls.sendStream).toBe(0);
    });
  });

  test("continues chatting after the user selects an org", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls, orgIds } = createMockClient({
        orgs: createMultiTestOrgs(),
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({ jid: PAIRED_JID, text: "2" });
      expect(orgIds).toContain("org_b");
      expect(
        sent.some((message) => message.text.includes("Now using Beta"))
      ).toBe(true);

      await handleMessage({ jid: PAIRED_JID, text: "hello" });
      expect(calls.createSession).toBe(1);
      expect(calls.sendStream).toBe(1);
    });
  });

  test("locks chat to fixedWorkspaceId and prevents switching workspaces", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls, orgIds } = createMockClient({
        orgs: createMultiTestOrgs(),
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        fixedWorkspaceId: "org_b",
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({ jid: PAIRED_JID, text: "hello" });
      expect(orgIds).toContain("org_b");
      expect(calls.createSession).toBe(1);
      expect(calls.sendStream).toBe(1);
      expect(
        sent.some((message) => message.text.includes("Choose an organization"))
      ).toBe(false);

      await handleMessage({ jid: PAIRED_JID, text: "/org" });
      expect(
        sent.some((message) =>
          message.text.includes(
            "belongs to one workspace and cannot switch workspaces."
          )
        )
      ).toBe(true);
    });
  });

  test("forwards a supported pdf document to sendStream", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls, getLastStreamInput } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();
      const pdfBytes = Buffer.from("pdf-content");
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        downloadMedia: async () => pdfBytes,
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({
        inbound: {
          key: { fromMe: false, id: "doc-1", remoteJid: PAIRED_JID },
          message: {
            documentMessage: {
              caption: "Summarize",
              fileName: "report.pdf",
              mimetype: "application/pdf",
            },
          },
        },
        jid: PAIRED_JID,
        text: "Summarize",
      });

      expect(calls.sendStream).toBe(1);
      expect(getLastStreamInput()).toEqual({
        message: formatSavedWhatsAppDocumentMessage({
          caption: "Summarize",
          filename: "report.pdf",
          mediaType: "application/pdf",
          relativePath: "artifacts/report.pdf",
          sizeBytes: pdfBytes.byteLength,
        }),
      });
      expect(sent.at(-1)?.text).toBe("Agent reply");
    });
  });

  test("forwards a captionless pdf to sendStream", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls, getLastStreamInput } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket } = createMockSocket();
      const pdfBytes = Buffer.from("pdf-content");
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        downloadMedia: async () => pdfBytes,
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({
        inbound: {
          key: { fromMe: false, id: "doc-2", remoteJid: PAIRED_JID },
          message: {
            documentMessage: {
              fileName: "report.pdf",
              mimetype: "application/pdf",
            },
          },
        },
        jid: PAIRED_JID,
        text: "",
      });

      expect(calls.sendStream).toBe(1);
      expect(getLastStreamInput()).toEqual({
        message: formatSavedWhatsAppDocumentMessage({
          caption: "",
          filename: "report.pdf",
          mediaType: "application/pdf",
          relativePath: "artifacts/report.pdf",
          sizeBytes: pdfBytes.byteLength,
        }),
      });
    });
  });

  test("forwards an xlsx document to sendStream", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls, getLastStreamInput } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket } = createMockSocket();
      const xlsxBytes = Buffer.from("xlsx-content");
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        downloadMedia: async () => xlsxBytes,
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({
        inbound: {
          key: { fromMe: false, id: "xlsx-1", remoteJid: PAIRED_JID },
          message: {
            documentMessage: {
              caption: "Analyze",
              fileName: "sales.xlsx",
              mimetype:
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            },
          },
        },
        jid: PAIRED_JID,
        text: "Analyze",
      });

      expect(calls.sendStream).toBe(1);
      expect(getLastStreamInput()).toEqual({
        message: formatSavedWhatsAppDocumentMessage({
          caption: "Analyze",
          filename: "sales.xlsx",
          mediaType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          relativePath: "artifacts/sales.xlsx",
          sizeBytes: xlsxBytes.byteLength,
        }),
      });
    });
  });

  test("saves oversized WhatsApp xlsx files to artifacts instead of rejecting", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls, getLastStreamInput } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket } = createMockSocket();
      const xlsxBytes = Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 1);
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        downloadMedia: async () => xlsxBytes,
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({
        inbound: {
          key: { fromMe: false, id: "xlsx-large", remoteJid: PAIRED_JID },
          message: {
            documentMessage: {
              caption: "Analyze",
              fileName: "sales.xlsx",
              mimetype:
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            },
          },
        },
        jid: PAIRED_JID,
        text: "Analyze",
      });

      expect(calls.sendStream).toBe(1);
      expect(getLastStreamInput()).toEqual({
        message: formatSavedWhatsAppDocumentMessage({
          caption: "Analyze",
          filename: "sales.xlsx",
          mediaType:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          relativePath: "artifacts/sales.xlsx",
          sizeBytes: xlsxBytes.byteLength,
        }),
      });

      const saved = await readFile(
        path.join(
          homeDir,
          ".atlas",
          "orgs",
          "org_test",
          "profiles",
          "default",
          "artifacts",
          "sales.xlsx"
        )
      );
      expect(saved.byteLength).toBe(xlsxBytes.byteLength);
    });
  });

  test("saves authorized open-mode files without requiring paired identity", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        accessMode: "open",
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls, getLastStreamInput } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket } = createMockSocket();
      const guestJid = "628555555555@s.whatsapp.net";
      const textBytes = Buffer.alloc(MAX_DOCUMENT_BYTES + 1, 97);
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        downloadMedia: async () => textBytes,
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({
        inbound: {
          key: { fromMe: false, id: "guest-text-large", remoteJid: guestJid },
          message: {
            documentMessage: {
              caption: "Summarize",
              fileName: "notes.txt",
              mimetype: "text/plain",
            },
          },
        },
        jid: guestJid,
        text: "Summarize",
      });

      expect(calls.sendStream).toBe(1);
      expect(JSON.stringify(getLastStreamInput())).toContain(
        "artifacts/notes.txt"
      );
      expect(JSON.stringify(getLastStreamInput())).toContain("read_file");
      expect(JSON.stringify(getLastStreamInput())).not.toContain("[File:");
      await expect(
        readFile(
          path.join(
            homeDir,
            ".atlas",
            "orgs",
            "org_test",
            "profiles",
            "default",
            "artifacts",
            "notes.txt"
          )
        )
      ).resolves.toEqual(textBytes);
    });
  });

  test("forwards a captionless photo to sendStream", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls, getLastStreamInput } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket } = createMockSocket();
      const imageBytes = TINY_JPEG_BYTES;
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        downloadMedia: async () => imageBytes,
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({
        inbound: {
          key: { fromMe: false, id: "img-1", remoteJid: PAIRED_JID },
          message: { imageMessage: { mimetype: "image/jpeg" } },
        },
        jid: PAIRED_JID,
        text: "",
      });

      expect(calls.sendStream).toBe(1);
      expect(getLastStreamInput()).toEqual({
        images: [
          { data: imageBytes.toString("base64"), mediaType: "image/jpeg" },
        ],
        message: formatSavedWhatsAppDocumentMessage({
          caption: "",
          filename: "image.jpg",
          mediaType: "image/jpeg",
          relativePath: "artifacts/image.jpg",
          sizeBytes: imageBytes.byteLength,
        }),
      });
    });
  });

  test.each([
    { accessMode: "pairing" as const, jid: PAIRED_JID },
    { accessMode: "open" as const, jid: "628555555555@s.whatsapp.net" },
  ])(
    "saves authorized $accessMode audio before transcription",
    async ({ accessMode, jid }) => {
      await withTempHome(async (homeDir) => {
        await writeWhatsAppConfigIni(homeDir, {
          accessMode,
          pairedJid: PAIRED_JID,
          phoneNumber: "1234567890",
        });

        const authStore = new WhatsAppAuthStore();
        await authStore.reload();
        const { client, calls, getLastStreamInput } = createMockClient();
        const sessionStore = new SessionStore(
          path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
        );
        const orgStore = createTestOrgStore(homeDir);
        await orgStore.load();
        const { socket } = createMockSocket();
        const audioBytes = Buffer.from([0, 255, 79, 103, 103, 83, 0, 33]);
        const audioPath = path.join(
          homeDir,
          ".atlas",
          "orgs",
          "org_test",
          "profiles",
          "default",
          "artifacts",
          "voice.ogg"
        );
        const transcribe = client.transcribeAudio.bind(client);
        client.transcribeAudio = async (input) => {
          expect(await readFile(audioPath)).toEqual(audioBytes);
          return transcribe(input);
        };
        let fileAuthorizations = 0;
        const authorize = client.authorizeChannelPrincipal.bind(client);
        client.authorizeChannelPrincipal = async (input) => {
          if (input.intent === "files") {
            fileAuthorizations += 1;
            expect(input).toMatchObject({
              channelChatId: jid,
              channelUserId: jid,
              profileId: "default",
              sessionId: "session_test",
            });
          }
          return authorize(input);
        };
        const handleMessage = createChatHandler({
          authStore,
          client,
          config: { phoneNumber: "1234567890", profileId: "default" },
          downloadMedia: async () => {
            expect(fileAuthorizations).toBe(1);
            return audioBytes;
          },
          getSocket: () => socket as any,
          orgStore,
          sessionStore,
        });

        await handleMessage({
          inbound: {
            key: { fromMe: false, id: "voice-1", remoteJid: jid },
            message: { audioMessage: { mimetype: "audio/ogg", ptt: true } },
          },
          jid,
          text: "",
        });

        expect(calls.transcribeAudio).toBe(1);
        expect(calls.transcribeInputs[0]).toMatchObject({
          data: audioBytes.toString("base64"),
          filename: "voice.ogg",
          sessionId: "session_test",
        });
        expect(fileAuthorizations).toBe(2);
        expect(calls.sendStream).toBe(1);
        const { message } = getLastStreamInput() as { message: string };
        expect(message).toContain("artifacts/voice.ogg");
        expect(message.startsWith("Transcribed voice message\n\n")).toBe(true);
      });
    }
  );

  test.each(["download", "save", "unauthorized", "revoked"] as const)(
    "stops audio before transcription and model completion on %s failure",
    async (failure) => {
      await withTempHome(async (homeDir) => {
        await writeWhatsAppConfigIni(homeDir, {
          pairedJid: PAIRED_JID,
          phoneNumber: "1234567890",
        });
        const authStore = new WhatsAppAuthStore();
        await authStore.reload();
        const { client, calls } = createMockClient();
        const sessionStore = new SessionStore(
          path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
        );
        const orgStore = createTestOrgStore(homeDir);
        await orgStore.load();
        const { socket, sent } = createMockSocket();
        const artifactsPath = path.join(
          homeDir,
          ".atlas",
          "orgs",
          "org_test",
          "profiles",
          "default",
          "artifacts"
        );
        if (failure === "save") {
          await mkdir(path.dirname(artifactsPath), { recursive: true });
          await writeFile(artifactsPath, "not a directory");
        }
        let fileAuthorizations = 0;
        const authorize = client.authorizeChannelPrincipal.bind(client);
        client.authorizeChannelPrincipal = async (input) => {
          if (input.intent === "files") {
            fileAuthorizations += 1;
            if (
              failure === "unauthorized" ||
              (failure === "revoked" && fileAuthorizations === 2)
            ) {
              throw new Error("File access denied");
            }
          }
          return authorize(input);
        };
        let downloads = 0;
        const handleMessage = createChatHandler({
          authStore,
          client,
          config: { phoneNumber: "1234567890", profileId: "default" },
          downloadMedia: async () => {
            downloads += 1;
            if (failure === "download") {
              throw new Error("Media unavailable");
            }
            return Buffer.from("original audio");
          },
          getSocket: () => socket as any,
          orgStore,
          sessionStore,
        });

        await handleMessage({
          inbound: {
            key: { fromMe: false, id: "voice-1", remoteJid: PAIRED_JID },
            message: { audioMessage: { mimetype: "audio/ogg", ptt: true } },
          },
          jid: PAIRED_JID,
          text: "",
        });

        expect(downloads).toBe(failure === "unauthorized" ? 0 : 1);
        expect(calls.transcribeAudio).toBe(0);
        expect(calls.sendStream).toBe(0);
        expect(sent.length).toBeGreaterThan(0);
        await expect(
          readFile(path.join(artifactsPath, "voice.ogg"))
        ).rejects.toThrow();
      });
    }
  );

  test("rejects unsupported documents without calling sendStream", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        downloadMedia: async () => Buffer.from("zip"),
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({
        inbound: {
          key: { fromMe: false, id: "zip-1", remoteJid: PAIRED_JID },
          message: {
            documentMessage: {
              fileName: "archive.zip",
              mimetype: "application/zip",
            },
          },
        },
        jid: PAIRED_JID,
        text: "",
      });

      expect(calls.sendStream).toBe(0);
      expect(sent[0]?.text).toContain("Unsupported file type");
    });
  });

  test("allowlist drops LID chats that cannot resolve to a listed phone number", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        accessMode: "allowlist",
        allowedNumbers: ["6281234567890"],
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      const lid = "236283431522503@lid";
      await handleMessage({ jid: lid, text: "hello agent" });
      expect(calls.sendStream).toBe(0);
      expect(sent).toEqual([]);

      await handleMessage({ jid: lid, text: "/help" });
      expect(calls.sendStream).toBe(0);
      expect(sent[0]?.text).toContain("not authorized for this chat");
    });
  });

  test("allowlist authorizes a LID chat after resolving senderPn", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        accessMode: "allowlist",
        allowedNumbers: ["6281234567890"],
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      const lid = "236283431522503@lid";
      await handleMessage({
        jid: lid,
        senderPn: "6281234567890@s.whatsapp.net",
        text: "hello agent",
      });
      expect(calls.createSession).toBe(1);
      expect(calls.sendStream).toBe(1);
      expect(calls.externalPrincipalIds).toEqual([lid]);
      expect(calls.externalPrincipalAliases).toEqual([
        ["6281234567890@s.whatsapp.net"],
      ]);

      await handleMessage({ jid: lid, text: "follow up" });
      expect(calls.sendStream).toBe(2);
    });
  });

  test("allowlist still authorizes the owner LID without senderPn", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        accessMode: "allowlist",
        allowedNumbers: ["6281234567890"],
        pairedJid: PAIRED_JID,
        pairedLid: "154352568283178@lid",
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({
        jid: "154352568283178@lid",
        text: "hello from owner",
      });
      expect(calls.createSession).toBe(1);
      expect(calls.sendStream).toBe(1);
    });
  });

  test("auto-authorizes incoming callers in open mode without pairing code", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        accessMode: "open",
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        fixedWorkspaceId: "org_a",
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({
        jid: "6289999999@s.whatsapp.net",
        text: "Customer question",
      });
      expect(calls.createSession).toBe(1);
      expect(calls.sendStream).toBe(1);
    });
  });

  test("never binds a stale pairing assertion from an authorized open-mode message", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        accessMode: "open",
        pairingAssertion: "assertion_stale",
        pairingUserId: "user_admin",
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        fixedWorkspaceId: "org_a",
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({
        jid: "6289999999@s.whatsapp.net",
        text: "Customer question",
      });

      expect(calls.bindChannelPrincipal).toBe(0);
      expect(calls.createSession).toBe(1);
    });
  });

  test("replies when creating a chat session fails instead of staying silent", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        accessMode: "open",
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient({
        failCreateSession: new Error(
          "No canonical user mapping for whatsapp:6289999999@s.whatsapp.net. Re-pair the channel."
        ),
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        fixedWorkspaceId: "org_a",
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({
        jid: "6289999999@s.whatsapp.net",
        text: "Hello",
      });
      expect(calls.sendStream).toBe(0);
      expect(sent.at(-1)?.text).toContain("not linked to an Atlas user");
      expect(sent.at(-1)?.text).not.toContain("canonical user mapping");
    });
  });

  test("rejects messages exceeding max character length", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        accessMode: "open",
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        fixedWorkspaceId: "org_a",
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      const longMessage = "a".repeat(2001);
      await handleMessage({
        jid: "6289999999@s.whatsapp.net",
        text: longMessage,
      });
      expect(calls.sendStream).toBe(0);
      expect(sent.some((m) => m.text.includes("Message is too long"))).toBe(
        true
      );
    });
  });
});

describe("createChatHandler group chats", () => {
  test.each([
    {
      message: { stickerMessage: { mimetype: "image/webp" } },
      name: "sticker",
    },
    { message: { imageMessage: { mimetype: "image/jpeg" } }, name: "photo" },
    {
      message: { imageMessage: { caption: " \n ", mimetype: "image/jpeg" } },
      name: "photo with blank caption",
    },
    { message: { videoMessage: { mimetype: "video/mp4" } }, name: "video" },
    {
      message: { audioMessage: { mimetype: "audio/ogg", ptt: true } },
      name: "voice note",
    },
    { message: { audioMessage: { mimetype: "audio/mpeg" } }, name: "audio" },
  ])("stays silent for an unaddressed group $name", async ({ message }) => {
    const downloads: unknown[] = [];
    await withGroupHarness(
      {
        downloadMedia: async (inbound) => {
          downloads.push(inbound);
          return Buffer.from("unused");
        },
        fixedWorkspaceId: "org_test",
        pairingCode: "ABCD1234",
      },
      async ({ clientMock, handleMessage, sent, sessionStore }) => {
        for (const senderJid of [PAIRED_JID, "628199999999@s.whatsapp.net"]) {
          await handleMessage({
            ...groupInbound({ senderJid, text: "" }),
            inbound: {
              key: {
                id: "chat-media",
                participant: senderJid,
                remoteJid: GROUP_JID,
              },
              message,
            },
          });
          expect(
            sessionStore.get(resolveWhatsAppSessionKey(GROUP_JID, senderJid))
          ).toBeUndefined();
        }
        expect(sent).toEqual([]);
        expect(downloads).toEqual([]);
        expect(clientMock.calls.createSession).toBe(0);
        expect(clientMock.calls.sendStream).toBe(0);
        expect(clientMock.calls.authorizeChannelPrincipal).toEqual([]);
      }
    );
  });

  test.each([
    {
      message: {
        documentMessage: {
          fileName: "report.pdf",
          mimetype: "application/pdf",
        },
      },
      name: "PDF",
    },
    {
      message: {
        documentMessage: {
          fileName: "report.xlsx",
          mimetype:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        },
      },
      name: "spreadsheet",
    },
    {
      message: {
        documentMessage: {
          fileName: "scan.jpg",
          mimetype: "application/octet-stream",
        },
      },
      name: "image sent as a document",
    },
    {
      message: {
        imageMessage: { caption: "Read this", mimetype: "image/jpeg" },
      },
      name: "captioned photo",
    },
  ])(
    "keeps the mention reminder for an unaddressed group $name",
    async ({ message }) => {
      const downloads: unknown[] = [];
      await withGroupHarness(
        {
          downloadMedia: async (inbound) => {
            downloads.push(inbound);
            return Buffer.from("unused");
          },
          fixedWorkspaceId: "org_test",
        },
        async ({ clientMock, handleMessage, sent, sessionStore }) => {
          const inbound = {
            key: {
              id: "work-file",
              participant: PAIRED_JID,
              remoteJid: GROUP_JID,
            },
            message,
          };
          const parsed = parseInboundWhatsAppMessage(inbound, BOT_ME);
          if (!parsed) {
            throw new Error("Expected work media to reach the handler");
          }
          await handleMessage({ ...parsed, inbound });
          expect(sent).toHaveLength(1);
          expect(sent[0]).toMatchObject({
            jid: GROUP_JID,
            quoted: inbound,
            text: expect.any(String),
          });
          expect(downloads).toEqual([]);
          expect(clientMock.calls.createSession).toBe(0);
          expect(clientMock.calls.sendStream).toBe(0);
          expect(
            sessionStore.get(resolveWhatsAppSessionKey(GROUP_JID, PAIRED_JID))
          ).toBeUndefined();
        }
      );
    }
  );

  test.each([
    {
      contextInfo: { mentionedJid: [BOT_ME.id] },
      jid: GROUP_JID,
      name: "group mention",
    },
    {
      contextInfo: { participant: BOT_ME.lid },
      jid: GROUP_JID,
      name: "group reply",
    },
    { contextInfo: undefined, jid: PAIRED_JID, name: "direct chat" },
  ])("processes a sticker in a $name", async ({ jid, contextInfo }) => {
    const sticker = Buffer.from(
      "UklGRkgAAABXRUJQVlA4IDwAAAAQAwCdASogACAAPm00lkekIyIhKAgAgA2JZQB2AACAoKAA/vkd2//+QH/+QH/+QH/8gP/+IXeyAwAAAAA=",
      "base64"
    );
    const downloads: unknown[] = [];
    await withGroupHarness(
      {
        downloadMedia: async (inbound) => {
          downloads.push(inbound);
          return sticker;
        },
        fixedWorkspaceId: "org_test",
      },
      async ({ clientMock, handleMessage }) => {
        const inbound = {
          key: {
            id: "addressed-sticker",
            participant: PAIRED_JID,
            remoteJid: jid,
          },
          message: {
            stickerMessage: {
              contextInfo,
              fileLength: sticker.length,
              mimetype: "image/webp",
            },
          },
        };
        const parsed = parseInboundWhatsAppMessage(inbound, BOT_ME);
        if (!parsed) {
          throw new Error(
            "Expected addressed or direct sticker to reach the handler"
          );
        }
        await handleMessage({ ...parsed, inbound });
        expect(downloads).toEqual([inbound]);
        expect(clientMock.calls.createSession).toBe(1);
        expect(clientMock.calls.sendStream).toBe(1);
        expect(clientMock.getLastStreamInput()).toMatchObject({
          images: [{ data: expect.any(String), mediaType: "image/png" }],
        });
      }
    );
  });

  test.each(["source-file", "1"])(
    "recovers ignored original media when replying to %s",
    async (quotedMessageId) => {
      const downloads: unknown[] = [];
      await withGroupHarness(
        {
          downloadMedia: async (message) => {
            downloads.push(message);
            return Buffer.from("asset,total\nLaptop,3");
          },
          fixedWorkspaceId: "org_test",
        },
        async ({ clientMock, handleMessage, sent }) => {
          const original = {
            key: {
              id: "source-file",
              participant: PAIRED_JID,
              remoteJid: GROUP_JID,
            },
            message: {
              documentMessage: {
                fileLength: 20,
                fileName: "assets.csv",
                mimetype: "text/csv",
              },
            },
          };
          await handleMessage({
            ...groupInbound({ text: "" }),
            inbound: original,
          });
          expect(downloads).toEqual([]);
          expect(clientMock.calls.createSession).toBe(0);
          expect(sent[0]?.quoted).toEqual(original);
          await handleMessage(
            groupInbound({
              mentionedJids: [BOT_ME.id],
              quotedMessageId,
              quotedParticipant:
                quotedMessageId === "1" ? BOT_ME.id : PAIRED_JID,
              quotedText: sent[0]?.text,
              text: "@Atlas summarize the assets",
            })
          );
          expect(downloads).toEqual([original]);
          expect(clientMock.calls.sendStream).toBe(1);
          const input = clientMock.getLastStreamInput() as { message: string };
          expect(input.message).toContain("assets.csv");
          expect(input.message).toContain("summarize the assets");
          expect(clientMock.calls.authorizeChannelPrincipal).toContainEqual(
            expect.objectContaining({
              channelAddressed: true,
              channelUserId: PAIRED_JID,
              intent: "files",
            })
          );
        }
      );
    }
  );

  test("recovery rechecks current file authorization before downloading", async () => {
    let downloads = 0;
    await withGroupHarness(
      {
        downloadMedia: async () => {
          downloads += 1;
          return Buffer.from("private");
        },
        fixedWorkspaceId: "org_test",
      },
      async ({ clientMock, handleMessage }) => {
        await handleMessage({
          ...groupInbound({ text: "" }),
          inbound: {
            key: {
              id: "private-source",
              participant: PAIRED_JID,
              remoteJid: GROUP_JID,
            },
            message: {
              documentMessage: {
                fileName: "private.txt",
                mimetype: "text/plain",
              },
            },
          },
        });
        const authorize = clientMock.client.authorizeChannelPrincipal;
        clientMock.client.authorizeChannelPrincipal = async (input) => {
          if (input.intent === "files") {
            throw new Error("Access revoked");
          }
          return await authorize(input);
        };
        await handleMessage(
          groupInbound({
            quotedMessageId: "1",
            quotedParticipant: BOT_ME.id,
            text: "read this file",
          })
        );
        expect(downloads).toBe(0);
        expect(clientMock.calls.sendStream).toBe(0);
      }
    );
  });

  test("natural pause aborts active work, discards backlog, persists and requires resume", async () => {
    await withGroupHarness(
      { streaming: true },
      async ({
        clientMock,
        handleMessage,
        sessionStore,
        sent,
        recreateHandler,
      }) => {
        const work = groupInbound({
          mentionedJids: [BOT_ME.id],
          text: "@Atlas work on this",
        });
        const running = handleMessage(work);
        const stream = await waitForStreamControl(clientMock.getStreamControl);
        const queued = handleMessage({ ...work, receivedAt: 1 });
        await handleMessage(
          groupInbound({
            mentionedJids: [BOT_ME.id],
            text: "@Atlas bisa diem dulu ga?",
          })
        );
        await Promise.all([running, queued]);
        expect(stream.signal?.aborted).toBe(true);
        expect(clientMock.calls.sendStream).toBe(1);
        const sessionKey = resolveWhatsAppSessionKey(GROUP_JID, PAIRED_JID);
        await sessionStore.load();
        expect(sessionStore.get(sessionKey)?.paused).toBe(true);
        const restartedHandler = recreateHandler();
        const sentCount = sent.length;
        await restartedHandler(work);
        expect(clientMock.calls.sendStream).toBe(1);
        expect(sent.length).toBe(sentCount);
        await restartedHandler(groupInbound({ text: "/resume" }));
        expect(sessionStore.get(sessionKey)?.paused).toBe(false);
        await restartedHandler({ ...work, receivedAt: 1 });
        expect(clientMock.calls.sendStream).toBe(1);
        const resumed = restartedHandler(work);
        await waitForCondition(
          () => clientMock.calls.sendStream === 2,
          "Resume did not start a new turn"
        );
        clientMock.getStreamControl()?.complete();
        await resumed;
      }
    );
  });

  test("revoked sender cannot pause an active authorized session", async () => {
    await withGroupHarness(
      { streaming: true },
      async ({ clientMock, handleMessage, sessionStore }) => {
        const running = handleMessage(
          groupInbound({ mentionedJids: [BOT_ME.id], text: "@Atlas work" })
        );
        const stream = await waitForStreamControl(clientMock.getStreamControl);
        clientMock.client.authorizeChannelPrincipal = async () => {
          throw new Error("Access revoked");
        };
        await handleMessage(groupInbound({ text: "/pause" }));
        expect(stream.signal?.aborted).toBe(false);
        expect(
          sessionStore.get(resolveWhatsAppSessionKey(GROUP_JID, PAIRED_JID))
            ?.paused
        ).not.toBe(true);
        stream.complete();
        await running;
      }
    );
  });

  test("pause remains scoped to the requesting sender and chat", async () => {
    await withGroupHarness(
      { accessMode: "open" },
      async ({ clientMock, handleMessage, sessionStore }) => {
        await handleMessage(groupInbound({ text: "/pause" }));
        const pausedKey = resolveWhatsAppSessionKey(GROUP_JID, PAIRED_JID);
        expect(sessionStore.get(pausedKey)?.paused).toBe(true);
        await handleMessage(
          groupInbound({
            mentionedJids: [BOT_ME.id],
            senderJid: "628199999999@s.whatsapp.net",
            text: "@Atlas answer me",
          })
        );
        await handleMessage(
          groupInbound({
            jid: OTHER_GROUP_JID,
            mentionedJids: [BOT_ME.id],
            text: "@Atlas answer here",
          })
        );
        expect(clientMock.calls.sendStream).toBe(2);
        expect(sessionStore.get(pausedKey)?.paused).toBe(true);
      }
    );
  });

  test("ignores unaddressed group messages", async () => {
    await withGroupHarness({}, async ({ clientMock, handleMessage, sent }) => {
      await handleMessage(groupInbound({ text: "hello everyone" }));

      expect(sent).toEqual([]);
      expect(clientMock.calls.createSession).toBe(0);
      expect(clientMock.calls.sendStream).toBe(0);
    });
  });

  test("handles a normalized bot mention and preserves other mentions", async () => {
    await withGroupHarness(
      {
        accessMode: "allowlist",
        allowedNumbers: ["628122222222"],
      },
      async ({ clientMock, handleMessage, sent }) => {
        await handleMessage(
          groupInbound({
            mentionedJids: [
              "628133333333@s.whatsapp.net",
              "628100000000@s.whatsapp.net",
            ],
            senderJid: "104784384290844@lid",
            senderJids: ["628122222222@s.whatsapp.net", "104784384290844@lid"],
            senderPn: "628122222222@s.whatsapp.net",
            text: "@Alice @Atlas please compare these",
          })
        );

        expect(clientMock.calls.sendStream).toBe(1);
        expect(clientMock.getLastStreamInput()).toEqual({
          message:
            "[WhatsApp group — your reply is visible to everyone in this group.]\n@Alice please compare these",
        });
        expect(clientMock.calls.externalPrincipalIds).toEqual([
          "104784384290844@lid",
        ]);
        expect(clientMock.calls.externalPrincipalAliases).toEqual([
          ["628122222222@s.whatsapp.net"],
        ]);
        expect(sent.at(-1)?.jid).toBe(GROUP_JID);
      }
    );
  });

  test("includes same-group quoted text when replying to the bot", async () => {
    await withGroupHarness({}, async ({ clientMock, handleMessage }) => {
      await handleMessage(
        groupInbound({
          quotedParticipant: BOT_ME.lid,
          quotedText: "Update Daily Well PHSS\nSFT-01 Unload flow",
          text: "use this for the next report",
        })
      );

      expect(clientMock.calls.sendStream).toBe(1);
      expect(clientMock.getLastStreamInput()).toEqual({
        message:
          "[WhatsApp group — your reply is visible to everyone in this group.]\n[Quoted message]\nUpdate Daily Well PHSS\nSFT-01 Unload flow\n\nuse this for the next report",
      });
    });
  });

  test("handles supported group commands and ignores unknown commands", async () => {
    await withGroupHarness({}, async ({ clientMock, handleMessage, sent }) => {
      await handleMessage(groupInbound({ text: "/new" }));
      expect(clientMock.calls.createSession).toBe(1);
      expect(sent.at(-1)?.text).toBe("Started a new conversation.");

      const sentCount = sent.length;
      await handleMessage(groupInbound({ text: "/unknown" }));
      expect(clientMock.calls.createSession).toBe(1);
      expect(sent).toHaveLength(sentCount);
    });
  });

  test("/profile lists selectable profiles without Super Agent", async () => {
    const profiles = [
      createProfileSummary({
        id: "default",
        isDefault: true,
        name: "Default Agent",
      }),
      createProfileSummary({ id: "research", name: "Research" }),
      createProfileSummary({
        id: "super_agent",
        isSuper: true,
        name: "Super Agent",
      }),
    ];

    await withGroupHarness(
      { profiles },
      async ({ clientMock, handleMessage, sent }) => {
        await handleMessage(groupInbound({ text: "/profile" }));

        const reply = sent.at(-1)?.text ?? "";
        expect(reply).toContain("Default Agent");
        expect(reply).toContain("Research");
        expect(reply).not.toContain("Super Agent");
        expect(reply).not.toContain("super_agent");
        expect(clientMock.calls.createSession).toBe(0);
      }
    );
  });

  test("/profile override survives /new and stays scoped to its group", async () => {
    const profiles = [
      createProfileSummary({
        id: "default",
        isDefault: true,
        name: "Default Agent",
      }),
      createProfileSummary({ id: "research", name: "Research" }),
    ];

    await withGroupHarness(
      { profiles },
      async ({ clientMock, handleMessage, sessionStore }) => {
        const groupSessionKey = resolveWhatsAppSessionKey(
          GROUP_JID,
          PAIRED_JID
        );
        const otherGroupSessionKey = resolveWhatsAppSessionKey(
          OTHER_GROUP_JID,
          PAIRED_JID
        );
        await handleMessage(groupInbound({ text: "/profile research" }));

        expect(clientMock.calls.profileIds).toEqual(["research"]);
        expect(sessionStore.get(groupSessionKey)).toMatchObject({
          profileId: "research",
          profileOverride: true,
        });

        await handleMessage(groupInbound({ text: "/new" }));

        expect(clientMock.calls.profileIds).toEqual(["research", "research"]);
        expect(sessionStore.get(groupSessionKey)).toMatchObject({
          profileId: "research",
          profileOverride: true,
        });

        await handleMessage(
          groupInbound({ jid: OTHER_GROUP_JID, text: "/new" })
        );

        expect(clientMock.calls.profileIds).toEqual([
          "research",
          "research",
          "default",
        ]);
        expect(sessionStore.get(otherGroupSessionKey)).toMatchObject({
          profileId: "default",
        });
        expect(
          sessionStore.get(otherGroupSessionKey)?.profileOverride
        ).toBeUndefined();
      }
    );
  });

  test("handles /attach from the current group without crossing group state", async () => {
    await withGroupHarness(
      {},
      async ({ clientMock, handleMessage, sent, sessionStore }) => {
        sessionStore.set(resolveWhatsAppSessionKey(GROUP_JID, PAIRED_JID), {
          channelUserId: PAIRED_JID,
          deliverableArtifacts: [
            {
              filename: "group-report.md",
              mimeType: "text/markdown",
              path: "artifacts/group-report.md",
              savedAt: "2026-08-27T10:00:00.000Z",
              sharePath: null,
              shareUrl: null,
              sizeBytes: 12,
            },
          ],
          profileId: "default",
          sessionId: "session_group",
          updatedAt: new Date().toISOString(),
        });
        await sessionStore.save();

        await handleMessage(groupInbound({ text: "/attach" }));

        expect(clientMock.calls.sendStream).toBe(0);
        expect(clientMock.calls.publishProfileArtifactShare).toBe(0);
        expect(
          sent.some((message) => message.fileName === "group-report.md")
        ).toBe(true);

        await handleMessage(
          groupInbound({ jid: OTHER_GROUP_JID, text: "/attach" })
        );

        expect(clientMock.calls.readProfileArtifactContent).toBe(1);
        expect(sent.at(-1)?.jid).toBe(OTHER_GROUP_JID);
        expect(sent.at(-1)?.text).toContain("No saved artifact");
      }
    );
  });

  test("lets an authorized group sender stop an in-flight reply", async () => {
    await withGroupHarness(
      { streaming: true },
      async ({ clientMock, handleMessage, sent }) => {
        const running = handleMessage(
          groupInbound({
            mentionedJids: [BOT_ME.id],
            text: "@Atlas work on this",
          })
        );
        const stream = await waitForStreamControl(clientMock.getStreamControl);

        await handleMessage(groupInbound({ text: "/stop" }));
        await running;

        expect(stream.signal?.aborted).toBe(true);
        expect(sent.some((message) => message.text === "Stopped.")).toBe(true);
      }
    );
  });

  test("does not let an unauthorized group sender stop another reply", async () => {
    await withGroupHarness(
      {
        accessMode: "allowlist",
        allowedNumbers: ["628122222222"],
        streaming: true,
      },
      async ({ clientMock, handleMessage }) => {
        const running = handleMessage(
          groupInbound({
            mentionedJids: [BOT_ME.id],
            text: "@Atlas work on this",
          })
        );
        const stream = await waitForStreamControl(clientMock.getStreamControl);

        await handleMessage(
          groupInbound({
            senderJid: "628199999999@s.whatsapp.net",
            text: "/stop",
          })
        );
        expect(stream.signal?.aborted).toBe(false);

        stream.complete();
        await running;
      }
    );
  });

  test("does not let another authorized group sender stop an in-flight reply", async () => {
    await withGroupHarness(
      { accessMode: "open", streaming: true },
      async ({ clientMock, handleMessage, sent }) => {
        const running = handleMessage(
          groupInbound({
            mentionedJids: [BOT_ME.id],
            senderJid: PAIRED_JID,
            text: "@Atlas work on this",
          })
        );
        const stream = await waitForStreamControl(clientMock.getStreamControl);

        await handleMessage(
          groupInbound({
            senderJid: "628199999999@s.whatsapp.net",
            text: "/stop",
          })
        );

        expect(stream.signal?.aborted).toBe(false);
        expect(sent.at(-1)?.text).toBe("Nothing to stop.");

        stream.complete();
        await running;
      }
    );
  });

  test("never accepts chat access codes in a group", async () => {
    await withGroupHarness(
      { pairedJid: null, pairingCode: "ABCD1234" },
      async ({ clientMock, handleMessage, sent }) => {
        await handleMessage(
          groupInbound({
            mentionedJids: [BOT_ME.id],
            senderJid: "628199999999@s.whatsapp.net",
            text: "@Atlas ABCD1234",
          })
        );

        expect(clientMock.calls.createSession).toBe(0);
        expect(clientMock.calls.sendStream).toBe(0);
        expect(sent.at(-1)?.text).toContain("private chat");
      }
    );
  });

  test("stays silent for unauthorized groups when no access code exists", async () => {
    await withGroupHarness(
      { pairedJid: null, pairingCode: null },
      async ({ clientMock, handleMessage, sent }) => {
        await handleMessage(
          groupInbound({
            mentionedJids: [BOT_ME.id],
            senderJid: "628199999999@s.whatsapp.net",
            text: "@Atlas hello",
          })
        );
        await handleMessage(
          groupInbound({
            senderJid: "628199999999@s.whatsapp.net",
            text: "/help",
          })
        );

        expect(sent).toEqual([]);
        expect(clientMock.calls.createSession).toBe(0);
        expect(clientMock.calls.sendStream).toBe(0);
      }
    );
  });

  test("fails closed when the selected org has no available profile", async () => {
    await withGroupHarness(
      { profiles: [] },
      async ({ clientMock, handleMessage, sent }) => {
        await handleMessage(
          groupInbound({
            mentionedJids: [BOT_ME.id],
            text: "@Atlas hello",
          })
        );

        expect(clientMock.calls.createSession).toBe(0);
        expect(clientMock.calls.sendStream).toBe(0);
        expect(sent).toHaveLength(1);
        expect(sent[0]?.jid).toBe(GROUP_JID);
        expect(sent[0]?.text).toContain("workspace profile settings");
      }
    );
  });

  test("fails closed when the group sender cannot resolve to a principal", async () => {
    await withGroupHarness(
      {
        failCreateSession: new Error(
          "No canonical user mapping for this WhatsApp sender."
        ),
      },
      async ({ clientMock, handleMessage, sent }) => {
        await handleMessage(
          groupInbound({
            mentionedJids: [BOT_ME.id],
            text: "@Atlas hello",
          })
        );

        expect(clientMock.calls.createSession).toBe(1);
        expect(clientMock.calls.sendStream).toBe(0);
        expect(sent).toHaveLength(1);
        expect(sent[0]?.jid).toBe(GROUP_JID);
        expect(sent[0]?.text).not.toContain("canonical user mapping");
      }
    );
  });

  test("keeps different groups and direct chats in separate sessions", async () => {
    await withGroupHarness(
      {},
      async ({ clientMock, handleMessage, sessionStore }) => {
        await handleMessage({ jid: PAIRED_JID, text: "hello privately" });
        expect(clientMock.getLastStreamInput()).toEqual({
          message: "hello privately",
        });

        await handleMessage(
          groupInbound({
            mentionedJids: [BOT_ME.id],
            text: "@Atlas hello group one",
          })
        );
        await handleMessage(
          groupInbound({
            jid: OTHER_GROUP_JID,
            mentionedJids: [BOT_ME.lid],
            text: "@Atlas hello group two",
          })
        );

        expect(clientMock.calls.createSession).toBe(3);
        expect(sessionStore.get(PAIRED_JID)).toBeDefined();
        expect(
          sessionStore.get(resolveWhatsAppSessionKey(GROUP_JID, PAIRED_JID))
        ).toBeDefined();
        expect(
          sessionStore.get(
            resolveWhatsAppSessionKey(OTHER_GROUP_JID, PAIRED_JID)
          )
        ).toBeDefined();
      }
    );
  });

  test("keeps a separate group session for each sender identity", async () => {
    await withGroupHarness(
      { accessMode: "open" },
      async ({ clientMock, handleMessage, sessionStore }) => {
        const secondSender = "628199999999@s.whatsapp.net";
        const invokedPrincipals: string[] = [];
        const createSession = clientMock.client.createSession.bind(
          clientMock.client
        );
        clientMock.client.createSession = async (...args) => {
          const session = await createSession(...args);
          const channelUserId = args[1]?.externalPrincipal?.channelUserId ?? "";
          return {
            ...session,
            id: `session_${channelUserId}`,
            sendStream: async (...streamArgs) => {
              invokedPrincipals.push(channelUserId);
              return session.sendStream(...streamArgs);
            },
          };
        };

        await handleMessage(
          groupInbound({
            mentionedJids: [BOT_ME.id],
            senderJid: PAIRED_JID,
            text: "@Atlas first sender",
          })
        );
        await handleMessage(
          groupInbound({
            mentionedJids: [BOT_ME.id],
            senderJid: secondSender,
            text: "@Atlas second sender",
          })
        );
        await handleMessage(
          groupInbound({
            mentionedJids: [BOT_ME.id],
            senderJid: PAIRED_JID,
            text: "@Atlas first sender again",
          })
        );

        expect(clientMock.calls.createSession).toBe(2);
        expect(clientMock.calls.externalPrincipalIds).toEqual([
          PAIRED_JID,
          secondSender,
        ]);
        expect(invokedPrincipals).toEqual([
          PAIRED_JID,
          secondSender,
          PAIRED_JID,
        ]);
        expect(
          sessionStore.get(resolveWhatsAppSessionKey(GROUP_JID, PAIRED_JID))
            ?.channelUserId
        ).toBe(PAIRED_JID);
        expect(
          sessionStore.get(resolveWhatsAppSessionKey(GROUP_JID, secondSender))
            ?.channelUserId
        ).toBe(secondSender);
      }
    );
  });

  test("isolates group org selection and session creation across orgs", async () => {
    await withGroupHarness(
      { orgs: createMultiTestOrgs() },
      async ({ clientMock, handleMessage, orgStore }) => {
        await handleMessage(groupInbound({ text: "/org 1" }));
        await handleMessage(
          groupInbound({
            mentionedJids: [BOT_ME.id],
            text: "@Atlas first workspace",
          })
        );

        await handleMessage(
          groupInbound({ jid: OTHER_GROUP_JID, text: "/org 2" })
        );
        await handleMessage(
          groupInbound({
            jid: OTHER_GROUP_JID,
            mentionedJids: [BOT_ME.id],
            text: "@Atlas second workspace",
          })
        );

        expect(orgStore.get(`g:${GROUP_JID}`)?.orgId).toBe("org_a");
        expect(orgStore.get(`g:${OTHER_GROUP_JID}`)?.orgId).toBe("org_b");
        expect(orgStore.get(PAIRED_JID)).toBeUndefined();
        expect(clientMock.calls.createSessionOrgIds).toEqual([
          "org_a",
          "org_b",
        ]);
      }
    );
  });

  test("drops the prior group session before switching that group to another org", async () => {
    await withGroupHarness(
      { orgs: createMultiTestOrgs() },
      async ({ clientMock, handleMessage, orgStore }) => {
        await handleMessage(groupInbound({ text: "/org 1" }));
        await handleMessage(
          groupInbound({
            mentionedJids: [BOT_ME.id],
            text: "@Atlas first workspace",
          })
        );

        await handleMessage(groupInbound({ text: "/org 2" }));
        await handleMessage(
          groupInbound({
            mentionedJids: [BOT_ME.id],
            text: "@Atlas second workspace",
          })
        );

        expect(orgStore.get(`g:${GROUP_JID}`)?.orgId).toBe("org_b");
        expect(clientMock.calls.createSession).toBe(2);
        expect(clientMock.calls.createSessionOrgIds).toEqual([
          "org_a",
          "org_b",
        ]);
      }
    );
  });
});

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

  const savedReportArtifact: DirectArtifact = {
    filename: "report.md",
    mimeType: "text/markdown",
    path: "artifacts/report.md",
    savedAt: "2026-07-13T10:00:00.000Z",
    sharePath: null,
    shareUrl: null,
    sizeBytes: 8,
  };

  test("attaches the file without a share-link chat bubble", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient({
        messages: artifactMessages,
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      await sessionStore.load();
      sessionStore.set(PAIRED_JID, {
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({ jid: PAIRED_JID, text: "thanks" });

      expect(calls.publishProfileArtifactShare).toBe(0);
      expect(calls.readProfileArtifactContent).toBe(1);
      expect(sent.some((message) => message.document)).toBe(true);
      expect(
        sent.some((message) =>
          message.text?.includes("https://app.example/s/tok_test")
        )
      ).toBe(false);
    });
  });

  test("posts a share link when the file is too large to attach", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const oversizedMeta = JSON.stringify({
        mimeType: "application/pdf",
        savedAt: "2026-07-13T10:00:00.000Z",
        sizeBytes: 26 * 1024 * 1024,
      });
      const oversizedMessages: ChatMessage[] = [
        { content: "save report", role: "user" },
        {
          content: "",
          role: "assistant",
          toolCalls: [
            {
              arguments: { content: "pdf", path: "artifacts/report.pdf" },
              id: "tool_1",
              name: "write_file",
            },
            {
              arguments: {
                content: oversizedMeta,
                path: "artifacts/report.pdf.atlas-meta.json",
              },
              id: "tool_2",
              name: "write_file",
            },
          ],
        },
        {
          content: JSON.stringify({
            bytesWritten: 8,
            path: "/home/.atlas/orgs/org/profiles/default/artifacts/report.pdf",
          }),
          name: "write_file",
          role: "tool",
          toolCallId: "tool_1",
        },
        {
          content: JSON.stringify({
            bytesWritten: oversizedMeta.length,
            path: "/home/.atlas/orgs/org/profiles/default/artifacts/report.pdf.atlas-meta.json",
          }),
          name: "write_file",
          role: "tool",
          toolCallId: "tool_2",
        },
        { content: "Saved the report.", role: "assistant" },
      ];

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient({
        messages: oversizedMessages,
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      await sessionStore.load();
      sessionStore.set(PAIRED_JID, {
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({ jid: PAIRED_JID, text: "thanks" });

      expect(calls.publishProfileArtifactShare).toBe(1);
      expect(calls.readProfileArtifactContent).toBe(0);
      expect(sent.some((message) => message.document)).toBe(false);
      expect(
        sent.some((message) =>
          message.text?.includes("https://app.example/s/tok_test")
        )
      ).toBe(true);
    });
  });

  test("sends an unpaired write_file artifact without minting a share", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient({
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
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      await sessionStore.load();
      sessionStore.set(PAIRED_JID, {
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({ jid: PAIRED_JID, text: "thanks" });

      expect(calls.publishProfileArtifactShare).toBe(0);
      expect(calls.readProfileArtifactContent).toBe(1);
      expect(sent.some((message) => message.document)).toBe(true);
    });
  });

  test("sends a spreadsheet created in the turn", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient({
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
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      await sessionStore.load();
      sessionStore.set(PAIRED_JID, {
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({ jid: PAIRED_JID, text: "thanks" });

      expect(calls.publishProfileArtifactShare).toBe(0);
      expect(calls.readProfileArtifactContent).toBe(1);
      expect(sent.some((message) => message.fileName === "sales.xlsx")).toBe(
        true
      );
    });
  });

  test("sends an artifact emitted by the live agent stream", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient({
        artifactContentBytes: new TextEncoder().encode("%PDF-1.4"),
        messages: [],
        steps: [
          {
            artifact: {
              createdAt: "2026-08-25T10:00:00.000Z",
              filename: "live-report.pdf",
              id: "artifact_live",
              mimeType: "application/pdf",
              path: "artifacts/live-report.pdf",
              size: 8,
              type: "pdf",
            },
            type: "artifact",
          },
          { reply: "Report ready", type: "resolve" },
        ],
        streaming: true,
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({ jid: PAIRED_JID, text: "make a report" });

      expect(calls.publishProfileArtifactShare).toBe(0);
      expect(calls.readProfileArtifactContent).toBe(1);
      expect(
        sent.some((message) => message.fileName === "live-report.pdf")
      ).toBe(true);
      expect(
        sent.some((message) =>
          message.text?.includes("https://app.example/s/tok_test")
        )
      ).toBe(false);
    });
  });

  test("strips download links from the chat reply when a file is attached", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client } = createMockClient({
        artifactContentBytes: new TextEncoder().encode("xlsx-bytes"),
        messages: [],
        steps: [
          {
            artifact: {
              createdAt: "2026-08-25T10:00:00.000Z",
              filename: "sales.xlsx",
              id: "artifact_xlsx",
              mimeType:
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
              path: "artifacts/sales.xlsx",
              size: 10,
              type: "spreadsheet",
            },
            type: "artifact",
          },
          {
            reply: "Sudah.\n\n[Download Excel](sandbox:/artifacts/sales.xlsx)",
            type: "resolve",
          },
        ],
        streaming: true,
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({ jid: PAIRED_JID, text: "kirim excelnya" });

      expect(sent.some((message) => message.fileName === "sales.xlsx")).toBe(
        true
      );
      expect(sent.some((message) => message.text?.includes("sandbox:"))).toBe(
        false
      );
      expect(
        sent.some((message) => message.text?.includes("Download Excel"))
      ).toBe(false);
      expect(sent.some((message) => message.text === "Sudah.")).toBe(true);
    });
  });

  test("sends the latest artifact when the user asks for the file", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient({
        artifactContentBytes: new TextEncoder().encode("# Report"),
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      await sessionStore.load();
      sessionStore.set(PAIRED_JID, {
        deliverableArtifacts: [
          {
            filename: "report.md",
            mimeType: "text/markdown",
            path: "report.md",
            savedAt: "2026-07-13T10:00:00.000Z",
            sharePath: "/s/tok_test",
            shareUrl: "https://app.example/s/tok_test",
            sizeBytes: 8,
          },
        ],
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({ jid: PAIRED_JID, text: "send me the file" });

      expect(calls.readProfileArtifactContent).toBe(1);
      expect(calls.publishProfileArtifactShare).toBe(0);
      expect(calls.sendStream).toBe(0);
      expect(sent.some((message) => message.document)).toBe(true);
      expect(sent.some((message) => message.fileName === "report.md")).toBe(
        true
      );
      expect(
        sent.some((message) =>
          message.text?.includes("https://app.example/s/tok_test")
        )
      ).toBe(false);
    });
  });

  test("handles /attach without an agent turn or public share", async () => {
    await withDirectArtifactHarness(
      { artifacts: [savedReportArtifact] },
      async ({ clientMock, handleMessage, sent }) => {
        await handleMessage({ jid: PAIRED_JID, text: "/attach" });

        expect(clientMock.calls.sendStream).toBe(0);
        expect(clientMock.calls.readProfileArtifactContent).toBe(1);
        expect(clientMock.calls.publishProfileArtifactShare).toBe(0);
        expect(sent.some((message) => message.fileName === "report.md")).toBe(
          true
        );
        expect(
          sent.some((message) => message.text?.includes("/s/tok_test"))
        ).toBe(false);
      }
    );
  });

  test("fails closed when /attach has no conversation artifact", async () => {
    await withDirectArtifactHarness(
      {},
      async ({ clientMock, handleMessage, sent }) => {
        await handleMessage({ jid: PAIRED_JID, text: "/attach" });

        expect(clientMock.calls.sendStream).toBe(0);
        expect(clientMock.calls.readProfileArtifactContent).toBe(0);
        expect(clientMock.calls.publishProfileArtifactShare).toBe(0);
        expect(sent.at(-1)?.text).toContain("No saved artifact");
      }
    );
  });

  test("does not attach files cleared from the conversation", async () => {
    await withDirectArtifactHarness(
      { artifacts: [savedReportArtifact] },
      async ({ clientMock, handleMessage, sent, sessionStore }) => {
        await handleMessage({ jid: PAIRED_JID, text: "/clear" });
        await handleMessage({ jid: PAIRED_JID, text: "/attach" });

        expect(sessionStore.getDeliverableArtifacts(PAIRED_JID)).toEqual([]);
        expect(clientMock.calls.readProfileArtifactContent).toBe(0);
        expect(clientMock.calls.sendStream).toBe(0);
        expect(sent.at(-1)?.text).toContain("No saved artifact");
      }
    );
  });

  test("keeps edit-then-send prompts in the agent turn", async () => {
    const editedMessages: ChatMessage[] = [
      { content: "edit the report and send the file", role: "user" },
      {
        content: "",
        role: "assistant",
        toolCalls: [
          {
            arguments: {
              content: "updated",
              path: "artifacts/updated-report.md",
            },
            id: "tool_edit",
            name: "write_file",
          },
        ],
      },
      {
        content: JSON.stringify({
          bytesWritten: 7,
          path: "/home/.atlas/orgs/org/profiles/default/artifacts/updated-report.md",
        }),
        name: "write_file",
        role: "tool",
        toolCallId: "tool_edit",
      },
    ];

    await withDirectArtifactHarness(
      {
        artifacts: [savedReportArtifact],
        client: {
          artifactContentBytes: new TextEncoder().encode("updated"),
          messages: editedMessages,
        },
      },
      async ({ clientMock, handleMessage, sent }) => {
        await handleMessage({
          jid: PAIRED_JID,
          text: "edit the report and send the file",
        });

        expect(clientMock.calls.sendStream).toBe(1);
        expect(clientMock.calls.readProfileArtifactContent).toBe(1);
        expect(clientMock.calls.publishProfileArtifactShare).toBe(0);
        expect(
          sent.some((message) => message.fileName === "updated-report.md")
        ).toBe(true);
        expect(sent.some((message) => message.fileName === "report.md")).toBe(
          false
        );
      }
    );
  });

  test("disambiguates /attach when an inbound file is present", async () => {
    await withDirectArtifactHarness(
      { artifacts: [savedReportArtifact] },
      async ({ clientMock, getDownloadCalls, handleMessage, sent }) => {
        await handleMessage({
          inbound: {
            key: { fromMe: false, id: "attach-doc", remoteJid: PAIRED_JID },
            message: {
              documentMessage: {
                caption: "/attach",
                fileName: "incoming.pdf",
                mimetype: "application/pdf",
              },
            },
          },
          jid: PAIRED_JID,
          text: "/attach",
        });

        expect(clientMock.calls.sendStream).toBe(0);
        expect(clientMock.calls.readProfileArtifactContent).toBe(0);
        expect(getDownloadCalls()).toBe(0);
        expect(sent.at(-1)?.text).toContain("Send /attach by itself");
      }
    );
  });

  test("mints a share only for an explicit share-link request", async () => {
    await withDirectArtifactHarness(
      { artifacts: [savedReportArtifact] },
      async ({ clientMock, handleMessage, sent }) => {
        await handleMessage({
          jid: PAIRED_JID,
          text: "send me a public link",
        });

        expect(clientMock.calls.sendStream).toBe(0);
        expect(clientMock.calls.readProfileArtifactContent).toBe(1);
        expect(clientMock.calls.publishProfileArtifactShare).toBe(1);
        expect(
          sent.some((message) =>
            message.text?.includes("https://app.example/s/tok_test")
          )
        ).toBe(true);
      }
    );
  });

  test("falls back to a share when native attachment sending fails", async () => {
    await withDirectArtifactHarness(
      { artifacts: [savedReportArtifact], failDocumentSend: true },
      async ({ clientMock, handleMessage, sent }) => {
        await handleMessage({ jid: PAIRED_JID, text: "/attach" });

        expect(clientMock.calls.sendStream).toBe(0);
        expect(clientMock.calls.readProfileArtifactContent).toBe(1);
        expect(clientMock.calls.publishProfileArtifactShare).toBe(1);
        expect(
          sent.some((message) =>
            message.text?.includes("https://app.example/s/tok_test")
          )
        ).toBe(true);
      }
    );
  });

  test("does not attempt share publishing when native send succeeds", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient({
        failPublishShare: true,
        messages: artifactMessages,
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      await sessionStore.load();
      sessionStore.set(PAIRED_JID, {
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({ jid: PAIRED_JID, text: "thanks" });

      expect(calls.publishProfileArtifactShare).toBe(0);
      expect(calls.readProfileArtifactContent).toBe(1);
      expect(sent.some((message) => message.fileName === "report.md")).toBe(
        true
      );
      expect(
        sent.some((message) =>
          message.text?.includes("https://app.example/s/tok_test")
        )
      ).toBe(false);
    });
  });

  test("falls back to a share without running the agent when attach download fails", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient({
        failReadArtifact: true,
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      await sessionStore.load();
      sessionStore.set(PAIRED_JID, {
        deliverableArtifacts: [
          {
            filename: "report.md",
            mimeType: "text/markdown",
            path: "report.md",
            savedAt: "2026-07-13T10:00:00.000Z",
            sharePath: "/s/tok_test",
            shareUrl: "https://app.example/s/tok_test",
            sizeBytes: 8,
          },
        ],
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({ jid: PAIRED_JID, text: "send me the file" });

      expect(calls.readProfileArtifactContent).toBe(1);
      expect(calls.publishProfileArtifactShare).toBe(1);
      expect(calls.sendStream).toBe(0);
      expect(
        sent.some((message) =>
          message.text?.includes("Failed to read the saved file.")
        )
      ).toBe(true);
      expect(
        sent.some((message) =>
          message.text?.includes("https://app.example/s/tok_test")
        )
      ).toBe(true);
    });
  });

  test("tells the user when a saved artifact is too large to send", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient({
        messages: [
          { content: "save", role: "user" },
          {
            content: "",
            role: "assistant",
            toolCalls: [
              {
                arguments: { content: "huge", path: "artifacts/huge.bin" },
                id: "tool_1",
                name: "write_file",
              },
            ],
          },
          {
            content: JSON.stringify({
              bytesWritten: 26 * 1024 * 1024,
              path: "/home/.atlas/orgs/org/profiles/default/artifacts/huge.bin",
            }),
            name: "write_file",
            role: "tool",
            toolCallId: "tool_1",
          },
        ],
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "whatsapp", "chat-sessions.json")
      );
      await sessionStore.load();
      sessionStore.set(PAIRED_JID, {
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const { socket, sent } = createMockSocket();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        getSocket: () => socket as any,
        orgStore,
        sessionStore,
      });

      await handleMessage({ jid: PAIRED_JID, text: "thanks" });

      expect(calls.readProfileArtifactContent).toBe(0);
      expect(sent.some((message) => message.document)).toBe(false);
      expect(
        sent.some(
          (message) =>
            message.text?.includes(
              "File is too large for Atlas WhatsApp delivery"
            ) && message.text.includes("artifacts/huge.bin")
        )
      ).toBe(true);
    });
  });
});

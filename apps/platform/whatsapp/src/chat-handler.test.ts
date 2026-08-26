import { beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage } from "@atlas/core/contract";
import { MAX_DOCUMENT_BYTES } from "@atlas/core/message-content";
import { resetActiveStreamsForTests } from "./active-stream";
import { formatSavedWhatsAppDocumentMessage } from "./attachments";
import { WhatsAppAuthStore } from "./auth-store";
import { createChatHandler, resetChatLocksForTests } from "./chat-handler";
import { SessionStore } from "./session-store";
import {
  createMockClient,
  createMultiTestOrgs,
  createTestOrgStore,
  waitForStreamControl,
  withTempHome,
  writeWhatsAppConfigIni,
} from "./test-helpers";

const PAIRED_JID = "1234567890@s.whatsapp.net";

function createMockSocket() {
  const sent: Array<{
    document?: unknown;
    fileName?: string;
    image?: unknown;
    jid: string;
    mimetype?: string;
    quoted?: unknown;
    text?: string;
  }> = [];

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
        fileName?: string;
        image?: unknown;
        mimetype?: string;
        text?: string;
      },
      options?: { quoted?: unknown }
    ) => {
      sent.push({
        document: content.document,
        fileName: content.fileName,
        image: content.image,
        jid,
        mimetype: content.mimetype,
        quoted: options?.quoted,
        text: content.text,
      });
    },
    sendPresenceUpdate: async () => {},
  };

  return { sent, socket };
}

beforeEach(() => {
  resetActiveStreamsForTests();
  resetChatLocksForTests();
});

describe("createChatHandler", () => {
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

      const pairJid = "1234567890@s.whatsapp.net";
      await handleMessage({ jid: pairJid, text: "ABCD1234" });

      expect(sent.length).toBe(1);
      expect(sent[0]!.text).toContain("Chat authorized");
      expect(authStore.isAuthorized(pairJid)).toBe(true);

      await handleMessage({ jid: pairJid, text: "hello agent" });
      expect(calls.createSession).toBe(1);
      expect(calls.sendStream).toBe(1);
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

  test("/stop aborts an in-flight stream without waiting for the chat lock", async () => {
    await withTempHome(async (homeDir) => {
      await writeWhatsAppConfigIni(homeDir, {
        pairedJid: PAIRED_JID,
        phoneNumber: "1234567890",
      });

      const authStore = new WhatsAppAuthStore();
      await authStore.reload();
      const { client, calls, getStreamControl } = createMockClient({
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
        documents: [
          {
            data: pdfBytes.toString("base64"),
            filename: "report.pdf",
            mediaType: "application/pdf",
          },
        ],
        message: "Summarize",
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
        documents: [
          {
            data: pdfBytes.toString("base64"),
            filename: "report.pdf",
            mediaType: "application/pdf",
          },
        ],
        message: "",
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
        documents: [
          {
            data: xlsxBytes.toString("base64"),
            filename: "sales.xlsx",
            mediaType:
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          },
        ],
        message: "Analyze",
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
      const imageBytes = Buffer.from("jpeg-bytes");
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
        message: "",
      });
    });
  });

  test("transcribes a voice note and forwards text to the agent", async () => {
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
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { phoneNumber: "1234567890", profileId: "default" },
        downloadMedia: async () => Buffer.from("ogg-bytes"),
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

      expect(calls.transcribeAudio).toBe(1);
      expect(calls.sendStream).toBe(1);
      expect(getLastStreamInput()).toEqual({
        message: "Transcribed voice message",
      });
    });
  });

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
      expect(
        sent.some((message) =>
          message.text.includes("No canonical user mapping")
        )
      ).toBe(true);
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

      expect(calls.publishProfileArtifactShare).toBe(1);
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
        sizeBytes: 6 * 1024 * 1024,
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

  test("posts a share link and file after an unpaired write_file artifact", async () => {
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

      expect(calls.publishProfileArtifactShare).toBe(1);
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

      expect(calls.publishProfileArtifactShare).toBe(1);
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

      expect(calls.publishProfileArtifactShare).toBe(1);
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
      expect(sent.some((message) => message.document)).toBe(true);
      expect(sent.some((message) => message.fileName === "report.md")).toBe(
        true
      );
    });
  });

  test("still sends the file when share publishing fails", async () => {
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

      expect(calls.publishProfileArtifactShare).toBe(1);
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

  test("keeps the agent turn going when attach download fails", async () => {
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
      expect(calls.sendStream).toBe(1);
      expect(
        sent.some((message) =>
          message.text?.includes("Failed to read the saved file.")
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
              bytesWritten: 6 * 1024 * 1024,
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
        sent.some((message) =>
          message.text?.includes("File is too large for WhatsApp")
        )
      ).toBe(true);
    });
  });
});

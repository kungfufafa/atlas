import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  spyOn,
  test,
} from "bun:test";
import path from "node:path";
import type { ChatMessage } from "@atlas/core/contract";
import {
  UNSUPPORTED_DOCUMENT_TYPES_REPLY,
  UNSUPPORTED_MEDIA_REPLY,
} from "./attachments";
import { TelegramAuthStore } from "./auth-store";
import {
  createChatHandler,
  resetChatLocksForTests,
  resolveTelegramSessionKey,
} from "./chat-handler";
import { SessionStore } from "./session-store";
import {
  createMessageContext,
  createMockClient,
  createMultiTestOrgs,
  createTestOrgStore,
  TEST_BOT_INFO,
  withTempHome,
  writeTelegramConfigIni,
} from "./test-helpers";

// These handler tests run in ~0.2s locally but occasionally exceed the 5000ms
// default under CI's concurrent all-workspace load. Give them more headroom.
setDefaultTimeout(10_000);

beforeEach(() => {
  resetChatLocksForTests();
});

async function waitForCondition(
  condition: () => boolean,
  message: string,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<void> {
  // Prefer real intervals over setTimeout(0) spins — under CI's concurrent
  // workspace load, session I/O can easily take tens of ms before sendStream runs.
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

describe("createChatHandler group chats", () => {
  test("ignores plain group messages without mention", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [42],
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        getBotInfo: () => TEST_BOT_INFO,
        orgStore,
        sessionStore,
      });

      const { ctx, replies } = createMessageContext({
        chatId: -100_123,
        chatType: "supergroup",
        text: "hello",
        userId: 42,
      });

      await handleMessage(ctx);

      expect(replies).toEqual([]);
      expect(calls.createSession).toBe(0);
      expect(calls.sendStream).toBe(0);
    });
  });

  test("group @mention triggers agent when user is paired", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [42],
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls, getLastCreateSessionExternalPrincipal } =
        createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        getBotInfo: () => TEST_BOT_INFO,
        orgStore,
        sessionStore,
      });

      const { ctx, replies, replyOptions } = createMessageContext({
        chatId: -100_123,
        chatType: "supergroup",
        entities: [{ length: 6, offset: 0, type: "mention" }],
        text: "@mybot hello",
        userId: 42,
      });

      await handleMessage(ctx);

      expect(calls.createSession).toBe(1);
      expect(getLastCreateSessionExternalPrincipal()).toEqual({
        channelUserId: "42",
      });
      expect(calls.sendStream).toBe(1);
      expect(replies.at(-1)).toBe("Agent reply");
      expect(replyOptions.at(-1)).toEqual({ parse_mode: "HTML" });
    });
  });

  test("keeps separate group sessions for different sender principals", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [42, 43],
      });
      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        getBotInfo: () => TEST_BOT_INFO,
        orgStore,
        sessionStore,
      });

      for (const userId of [42, 43]) {
        const message = createMessageContext({
          chatId: -100_123,
          chatType: "supergroup",
          entities: [{ length: 6, offset: 0, type: "mention" }],
          text: "@mybot hello",
          userId,
        });
        await handleMessage(message.ctx);
      }

      const firstKey = resolveTelegramSessionKey("-100123", "42", true);
      const secondKey = resolveTelegramSessionKey("-100123", "43", true);
      expect(firstKey).not.toBe(secondKey);
      expect(sessionStore.get(firstKey)?.channelUserId).toBe("42");
      expect(sessionStore.get(secondKey)?.channelUserId).toBe("43");
      expect(calls.createSession).toBe(2);
    });
  });

  test("group topics create isolated sessions and fall back to the configured profile", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [42],
        profileId: "research",
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls, getLastCreateSessionProfileId } = createMockClient(
        {
          profiles: [
            { id: "default", isDefault: true, name: "Default Agent" },
            { id: "research", name: "Research Bot" },
          ],
        }
      );
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "research" },
        getBotInfo: () => TEST_BOT_INFO,
        orgStore,
        sessionStore,
      });

      const topic10 = createMessageContext({
        chatId: -100_123,
        chatType: "supergroup",
        entities: [{ length: 6, offset: 0, type: "mention" }],
        messageThreadId: 10,
        text: "@mybot hello",
        userId: 42,
      });
      await handleMessage(topic10.ctx);

      const topic20 = createMessageContext({
        chatId: -100_123,
        chatType: "supergroup",
        entities: [{ length: 6, offset: 0, type: "mention" }],
        messageThreadId: 20,
        text: "@mybot hello",
        userId: 42,
      });
      await handleMessage(topic20.ctx);

      expect(calls.createSession).toBe(2);
      expect(getLastCreateSessionProfileId()).toBe("research");
      expect(
        sessionStore.get(
          resolveTelegramSessionKey("g:-100123:t:10", "42", true)
        )?.profileId
      ).toBe("research");
      expect(
        sessionStore.get(
          resolveTelegramSessionKey("g:-100123:t:20", "42", true)
        )?.profileId
      ).toBe("research");
      expect(sessionStore.get("-100123")).toBeUndefined();
    });
  });

  test("/profile in a group topic only switches that topic", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [42],
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, getLastCreateSessionProfileId } = createMockClient({
        profiles: [
          { id: "default", isDefault: true, name: "Default Agent" },
          { id: "research", name: "Research Bot" },
        ],
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        getBotInfo: () => TEST_BOT_INFO,
        orgStore,
        sessionStore,
      });

      const switchTopic10 = createMessageContext({
        chatId: -100_123,
        chatType: "supergroup",
        messageThreadId: 10,
        text: "/profile research",
        userId: 42,
      });
      await handleMessage(switchTopic10.ctx);

      const topic20 = createMessageContext({
        chatId: -100_123,
        chatType: "supergroup",
        entities: [{ length: 6, offset: 0, type: "mention" }],
        messageThreadId: 20,
        text: "@mybot hello",
        userId: 42,
      });
      await handleMessage(topic20.ctx);

      expect(switchTopic10.replies).toEqual([
        "Now using Research Bot. Chat history reset.",
      ]);
      expect(
        sessionStore.get(
          resolveTelegramSessionKey("g:-100123:t:10", "42", true)
        )?.profileId
      ).toBe("research");
      expect(
        sessionStore.get(
          resolveTelegramSessionKey("g:-100123:t:20", "42", true)
        )?.profileId
      ).toBe("default");
      expect(getLastCreateSessionProfileId()).toBe("default");
      expect(orgStore.get("g:-100123")?.orgId).toBe("org_test");
    });
  });

  test("/profile list in a group topic shows that topic current profile", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [42],
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client } = createMockClient({
        profiles: [
          { id: "default", isDefault: true, name: "Default Agent" },
          { id: "research", name: "Research Bot" },
        ],
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        getBotInfo: () => TEST_BOT_INFO,
        orgStore,
        sessionStore,
      });

      const switchTopic10 = createMessageContext({
        chatId: -100_123,
        chatType: "supergroup",
        messageThreadId: 10,
        text: "/profile research",
        userId: 42,
      });
      await handleMessage(switchTopic10.ctx);

      const listTopic10 = createMessageContext({
        chatId: -100_123,
        chatType: "supergroup",
        messageThreadId: 10,
        text: "/profile",
        userId: 42,
      });
      await handleMessage(listTopic10.ctx);

      expect(listTopic10.replies.join("\n")).toContain("Current: Research Bot");
    });
  });

  test("/status in a group topic reports that topic profile", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [42],
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client } = createMockClient({
        profiles: [
          {
            id: "default",
            isDefault: true,
            model: "local::base",
            name: "Default Agent",
          },
          { id: "research", model: "local::research", name: "Research Bot" },
        ],
        providerConfigured: true,
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        getBotInfo: () => TEST_BOT_INFO,
        orgStore,
        sessionStore,
      });

      const switchTopic10 = createMessageContext({
        chatId: -100_123,
        chatType: "supergroup",
        messageThreadId: 10,
        text: "/profile research",
        userId: 42,
      });
      await handleMessage(switchTopic10.ctx);

      const statusTopic10 = createMessageContext({
        chatId: -100_123,
        chatType: "supergroup",
        messageThreadId: 10,
        text: "/status",
        userId: 42,
      });
      await handleMessage(statusTopic10.ctx);

      const statusText = statusTopic10.replies.join("\n");
      expect(statusText).toContain("Profile: Research Bot");
      expect(statusText).toContain("Model: research");
    });
  });

  test("/profile outside a topic keeps switching the group-level profile", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [42],
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, getLastCreateSessionProfileId } = createMockClient({
        profiles: [
          { id: "default", isDefault: true, name: "Default Agent" },
          { id: "support", name: "Support Bot" },
        ],
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        getBotInfo: () => TEST_BOT_INFO,
        orgStore,
        sessionStore,
      });

      const switchGroup = createMessageContext({
        chatId: -100_123,
        chatType: "supergroup",
        text: "/profile support",
        userId: 42,
      });
      await handleMessage(switchGroup.ctx);

      expect(getLastCreateSessionProfileId()).toBe("support");
      expect(
        sessionStore.get(resolveTelegramSessionKey("-100123", "42", true))
          ?.profileId
      ).toBe("support");
      expect(sessionStore.get("g:-100123:t:10")).toBeUndefined();
    });
  });

  test("/profile in a topic asks for /org before switching to another org", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [42],
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient({
        orgs: createMultiTestOrgs(),
        profilesByOrgId: {
          org_a: [{ id: "default", isDefault: true, name: "Default Agent" }],
          org_b: [{ id: "gary", isDefault: true, name: "Gary Vee" }],
        },
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      orgStore.set("g:-100123", "org_a");
      await orgStore.save();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        getBotInfo: () => TEST_BOT_INFO,
        orgStore,
        sessionStore,
      });

      const switchTopic = createMessageContext({
        chatId: -100_123,
        chatType: "supergroup",
        messageThreadId: 10,
        text: "/profile garry-vee",
        userId: 42,
      });
      await handleMessage(switchTopic.ctx);

      expect(switchTopic.replies).toEqual([
        "That profile is in another org. Send /org first, then /profile.",
      ]);
      expect(orgStore.get("g:-100123")?.orgId).toBe("org_a");
      expect(sessionStore.get("g:-100123:t:10")).toBeUndefined();
      expect(calls.createSession).toBe(0);
    });
  });

  test("/stop in a group topic aborts only that topic stream", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [42],
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, getStreamControls } = createMockClient({
        autoComplete: false,
        streaming: true,
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        getBotInfo: () => TEST_BOT_INFO,
        orgStore,
        sessionStore,
      });

      const topic20 = createMessageContext({
        chatId: -100_123,
        chatType: "supergroup",
        entities: [{ length: 6, offset: 0, type: "mention" }],
        messageThreadId: 20,
        text: "@mybot hello",
        userId: 42,
      });
      const topic10 = createMessageContext({
        chatId: -100_123,
        chatType: "supergroup",
        entities: [{ length: 6, offset: 0, type: "mention" }],
        messageThreadId: 10,
        text: "@mybot hello",
        userId: 42,
      });

      const topic20Promise = handleMessage(topic20.ctx);
      await waitForCondition(
        () => getStreamControls().length === 1,
        "Expected topic 20 stream to start"
      );
      const topic10Promise = handleMessage(topic10.ctx);

      try {
        await waitForCondition(
          () => getStreamControls().length === 2,
          "Expected two active topic streams"
        );

        const stopTopic10 = createMessageContext({
          chatId: -100_123,
          chatType: "supergroup",
          messageThreadId: 10,
          text: "/stop",
          userId: 42,
        });
        await handleMessage(stopTopic10.ctx);

        expect(getStreamControls()[0]?.signal?.aborted).toBe(false);
        expect(getStreamControls()[1]?.signal?.aborted).toBe(true);
        expect(stopTopic10.replies).toEqual([]);
      } finally {
        getStreamControls()[0]?.complete();
        getStreamControls()[1]?.complete();
        await topic10Promise;
        await topic20Promise;
      }
    });
  });

  test("group /clear@otherbot does not clear this bot's history", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [42],
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        getBotInfo: () => TEST_BOT_INFO,
        orgStore,
        sessionStore,
      });

      const foreign = createMessageContext({
        chatId: -100_123,
        chatType: "supergroup",
        text: "/clear@moderationbot",
        userId: 42,
      });
      await handleMessage(foreign.ctx);

      expect(foreign.replies).toEqual([]);
      expect(calls.createSession).toBe(0);
      expect(calls.sendStream).toBe(0);

      const ours = createMessageContext({
        chatId: -100_123,
        chatType: "supergroup",
        text: "/clear@mybot",
        userId: 42,
      });
      await handleMessage(ours.ctx);

      expect(ours.replies).toEqual(["History cleared."]);
    });
  });

  test("unpaired /stop in a group topic does not abort an in-flight stream", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        handshakeCode: "ABCD1234",
        pairedUserIds: [42],
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, getStreamControls } = createMockClient({
        autoComplete: false,
        streaming: true,
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        getBotInfo: () => TEST_BOT_INFO,
        orgStore,
        sessionStore,
      });

      const topic10 = createMessageContext({
        chatId: -100_123,
        chatType: "supergroup",
        entities: [{ length: 6, offset: 0, type: "mention" }],
        messageThreadId: 10,
        text: "@mybot hello",
        userId: 42,
      });
      const topicPromise = handleMessage(topic10.ctx);

      try {
        await waitForCondition(
          () => getStreamControls().length === 1,
          "Expected topic 10 stream to start"
        );

        const unpairedStop = createMessageContext({
          chatId: -100_123,
          chatType: "supergroup",
          messageThreadId: 10,
          text: "/stop",
          userId: 9999,
        });
        await handleMessage(unpairedStop.ctx);

        expect(getStreamControls()[0]?.signal?.aborted).toBe(false);
        expect(unpairedStop.replies).toEqual([
          "Link your account in a private chat with this bot first.",
        ]);
        expect(authStore.isAuthorized(9999)).toBe(false);
      } finally {
        getStreamControls()[0]?.complete();
        await topicPromise;
      }
    });
  });

  test("group /stop@otherbot does not abort an in-flight stream", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [42],
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, getStreamControls } = createMockClient({
        autoComplete: false,
        streaming: true,
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        getBotInfo: () => TEST_BOT_INFO,
        orgStore,
        sessionStore,
      });

      const topic10 = createMessageContext({
        chatId: -100_123,
        chatType: "supergroup",
        entities: [{ length: 6, offset: 0, type: "mention" }],
        messageThreadId: 10,
        text: "@mybot hello",
        userId: 42,
      });
      const topicPromise = handleMessage(topic10.ctx);

      try {
        await waitForCondition(
          () => getStreamControls().length === 1,
          "Expected topic 10 stream to start"
        );

        const foreignStop = createMessageContext({
          chatId: -100_123,
          chatType: "supergroup",
          messageThreadId: 10,
          text: "/stop@moderationbot",
          userId: 42,
        });
        await handleMessage(foreignStop.ctx);

        expect(getStreamControls()[0]?.signal?.aborted).toBe(false);
        expect(foreignStop.replies).toEqual([]);
      } finally {
        getStreamControls()[0]?.complete();
        await topicPromise;
      }
    });
  });

  test("unpaired @mention redirects to private chat without pairing", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        handshakeCode: "ABCD1234",
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        getBotInfo: () => TEST_BOT_INFO,
        orgStore,
        sessionStore,
      });

      const { ctx, replies } = createMessageContext({
        chatId: -100_123,
        chatType: "supergroup",
        entities: [{ length: 6, offset: 0, type: "mention" }],
        text: "@mybot hello",
        userId: 1001,
      });

      await handleMessage(ctx);

      expect(replies).toEqual([
        "Link your account in a private chat with this bot first.",
      ]);
      expect(calls.sendStream).toBe(0);
      expect(authStore.isAuthorized(1001)).toBe(false);
    });
  });

  test("/org in group stores selection under group org key", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [42],
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client } = createMockClient({ orgs: createMultiTestOrgs() });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        getBotInfo: () => TEST_BOT_INFO,
        orgStore,
        sessionStore,
      });

      const { ctx } = createMessageContext({
        chatId: -100_123,
        chatType: "supergroup",
        text: "/org 1",
        userId: 42,
      });

      await handleMessage(ctx);

      expect(orgStore.get("g:-100123")?.orgId).toBe("org_a");
    });
  });
});

describe("createChatHandler security", () => {
  test("does not reuse a legacy session without a canonical channel owner", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [1001],
      });
      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      await sessionStore.load();
      sessionStore.set("1001", {
        profileId: "default",
        sessionId: "legacy_session",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const message = createMessageContext({ text: "hello", userId: 1001 });
      await handleMessage(message.ctx);

      expect(calls.createSession).toBe(1);
      expect(calls.sendStream).toBe(1);
      expect(sessionStore.get("1001")?.channelUserId).toBe("1001");
      expect(sessionStore.get("1001")?.sessionId).not.toBe("legacy_session");
    });
  });

  test("ignores messages without a sender id", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        handshakeCode: "ABCD1234",
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const { ctx, replies } = createMessageContext({ text: "hello" });
      delete (ctx as { from?: unknown }).from;

      await handleMessage(ctx);

      expect(replies).toEqual([]);
      expect(calls.sendStream).toBe(0);
    });
  });

  test("blocks agent access until pairing succeeds", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        handshakeCode: "ABCD1234",
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const { ctx, replies } = createMessageContext({
        text: "Tell me a joke",
        userId: 1001,
      });

      await handleMessage(ctx);

      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain("Paste your pairing code");
      expect(calls.createSession).toBe(0);
      expect(calls.sendStream).toBe(0);
    });
  });

  test("rejects invalid pairing codes without contacting the agent", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        handshakeCode: "ABCD1234",
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const { ctx, replies } = createMessageContext({
        text: "DEADBEEF",
        userId: 1001,
      });

      await handleMessage(ctx);

      expect(replies).toEqual([
        "Invalid pairing code. Copy it from Integrations → Telegram and try again.",
      ]);
      expect(authStore.isAuthorized(1001)).toBe(false);
      expect(calls.sendStream).toBe(0);
    });
  });

  test("pairs a user with a valid code and clears the active handshake", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        handshakeAssertion: "assert_pair",
        handshakeCode: "ABCD1234",
        handshakeUserId: "user_test",
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        fixedWorkspaceId: "org_test",
        orgStore,
        sessionStore,
      });

      const pairAttempt = createMessageContext({
        text: "ab cd 12 34",
        userId: 1001,
      });
      await handleMessage(pairAttempt.ctx);

      expect(pairAttempt.replies).toEqual([
        "Linked successfully. You can chat with Atlas now.",
      ]);
      expect(authStore.isAuthorized(1001)).toBe(true);
      expect(authStore.getConfig()?.handshakeCode).toBeNull();
      expect(authStore.getConfig()?.pairedUserIds).toEqual([1001]);
      expect(calls.bindChannelPrincipal).toBe(1);
      expect(calls.sendStream).toBe(0);

      const chatAttempt = createMessageContext({
        text: "hello agent",
        userId: 1001,
      });
      await handleMessage(chatAttempt.ctx);

      expect(calls.createSession).toBe(1);
      expect(calls.sendStream).toBe(1);
      expect(chatAttempt.replies.at(-1)).toBe("Agent reply");
    });
  });

  test("binds the canonical user after pairing with an assertion", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        handshakeAssertion: "assert_1",
        handshakeCode: "ABCD1234",
        handshakeUserId: "user_test",
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls, getLastBindChannelPrincipalInput } =
        createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        fixedWorkspaceId: "org_test",
        orgStore,
        sessionStore,
      });

      const pairAttempt = createMessageContext({
        text: "ab cd 12 34",
        userId: 1001,
      });
      await handleMessage(pairAttempt.ctx);

      expect(pairAttempt.replies).toEqual([
        "Linked successfully. You can chat with Atlas now.",
      ]);
      expect(calls.bindChannelPrincipal).toBe(1);
      expect(getLastBindChannelPrincipalInput()).toMatchObject({
        channel: "telegram",
        channelUserId: "1001",
        expectedUserId: "user_test",
        pairingAssertion: "assert_1",
      });
      expect(authStore.getConfig()?.handshakeAssertion).toBeNull();
      expect(authStore.getConfig()?.handshakeUserId).toBeNull();
    });
  });

  test("falls back to the default profile when the configured profile is missing", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        handshakeAssertion: "assert_profile",
        handshakeCode: "ABCD1234",
        handshakeUserId: "user_test",
        profileId: "missing_profile",
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls, getLastCreateSessionProfileId } = createMockClient(
        {
          profiles: [{ id: "default", model: null }],
        }
      );
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "missing_profile" },
        fixedWorkspaceId: "org_test",
        orgStore,
        sessionStore,
      });

      const pairAttempt = createMessageContext({
        text: "ABCD1234",
        userId: 1001,
      });
      await handleMessage(pairAttempt.ctx);

      const chatAttempt = createMessageContext({
        text: "hello agent",
        userId: 1001,
      });
      await handleMessage(chatAttempt.ctx);

      expect(calls.createSession).toBe(1);
      expect(getLastCreateSessionProfileId()).toBe("default");
      expect(chatAttempt.replies.at(-1)).toBe("Agent reply");
    });
  });

  test("does not allow a second user to reuse a consumed pairing code", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        handshakeAssertion: "assert_once",
        handshakeCode: "ABCD1234",
        handshakeUserId: "user_test",
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        fixedWorkspaceId: "org_test",
        orgStore,
        sessionStore,
      });

      const firstUser = createMessageContext({
        text: "ABCD1234",
        userId: 1001,
      });
      await handleMessage(firstUser.ctx);

      const secondUser = createMessageContext({
        text: "ABCD1234",
        userId: 2002,
      });
      await handleMessage(secondUser.ctx);

      expect(secondUser.replies[0]).toContain("not linked yet");
      expect(authStore.isAuthorized(2002)).toBe(false);
      expect(authStore.isAuthorized(1001)).toBe(true);
    });
  });

  test("compacts session history on /compact", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        allowedUserIds: [4242],
        botToken: "1234567890:TEST",
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const { ctx, replies } = createMessageContext({
        text: "/compact",
        userId: 4242,
      });

      await handleMessage(ctx);

      expect(calls.compact).toBe(1);
      expect(calls.sendStream).toBe(0);
      expect(replies).toEqual(["Compacted (summarized). Messages: 4."]);
    });
  });

  test("allows pre-approved users to skip pairing", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        allowedUserIds: [4242],
        botToken: "1234567890:TEST",
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const { ctx, replies } = createMessageContext({
        text: "hello agent",
        userId: 4242,
      });

      await handleMessage(ctx);

      expect(calls.createSession).toBe(1);
      expect(calls.sendStream).toBe(1);
      expect(replies.at(-1)).toBe("Agent reply");
    });
  });

  test("open and allowlist callers cannot consume a pending admin assertion", async () => {
    for (const access of [
      { accessMode: "open" as const, allowedUserIds: [] },
      { accessMode: "allowlist" as const, allowedUserIds: [1001] },
    ]) {
      await withTempHome(async (homeDir) => {
        await writeTelegramConfigIni(homeDir, {
          ...access,
          botToken: "1234567890:TEST",
          handshakeAssertion: "assert_admin",
          handshakeCode: "ABCD1234",
          handshakeUserId: "user_admin",
        });
        const authStore = new TelegramAuthStore();
        await authStore.reload();
        const { client, calls } = createMockClient();
        const sessionStore = new SessionStore(
          path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
        );
        const orgStore = createTestOrgStore(homeDir);
        await orgStore.load();
        const handleMessage = createChatHandler({
          authStore,
          client,
          config: { botToken: "1234567890:TEST", profileId: "default" },
          fixedWorkspaceId: "org_test",
          orgStore,
          sessionStore,
        });

        const message = createMessageContext({
          text: "hello agent",
          userId: 1001,
        });
        await handleMessage(message.ctx);

        expect(calls.bindChannelPrincipal).toBe(0);
        expect(authStore.getConfig()?.handshakeAssertion).toBe("assert_admin");
        expect(authStore.getConfig()?.handshakeCode).toBe("ABCD1234");
      });
    }
  });

  test("an authorized open caller binds only after sending the exact active code", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        accessMode: "open",
        botToken: "1234567890:TEST",
        handshakeAssertion: "assert_user",
        handshakeCode: "ABCD1234",
        handshakeUserId: "user_test",
      });
      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        fixedWorkspaceId: "org_test",
        orgStore,
        sessionStore,
      });

      const wrong = createMessageContext({ text: "DEADBEEF", userId: 1001 });
      await handleMessage(wrong.ctx);
      expect(calls.bindChannelPrincipal).toBe(0);
      expect(authStore.getConfig()?.handshakeCode).toBe("ABCD1234");

      const exact = createMessageContext({ text: "ABCD1234", userId: 1001 });
      await handleMessage(exact.ctx);
      expect(calls.bindChannelPrincipal).toBe(1);
      expect(exact.replies).toEqual([
        "Linked successfully. You can chat with Atlas now.",
      ]);
      expect(authStore.getConfig()?.handshakeCode).toBeNull();
    });
  });

  test("a failed canonical bind keeps the code active and never reports success", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        handshakeAssertion: "assert_retry",
        handshakeCode: "ABCD1234",
        handshakeUserId: "user_test",
      });
      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient({ failBindPrincipal: true });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        fixedWorkspaceId: "org_test",
        orgStore,
        sessionStore,
      });
      const pairAttempt = createMessageContext({
        text: "ABCD1234",
        userId: 1001,
      });

      await handleMessage(pairAttempt.ctx);

      expect(calls.bindChannelPrincipal).toBe(1);
      expect(pairAttempt.replies).toEqual([
        "Could not link this chat. The pairing code is still active; try again.",
      ]);
      expect(authStore.getConfig()?.handshakeAssertion).toBe("assert_retry");
      expect(authStore.getConfig()?.handshakeCode).toBe("ABCD1234");
      expect(authStore.getConfig()?.pairedUserIds).toEqual([]);
    });
  });

  test("/stop aborts an in-flight stream without waiting for the chat lock", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        allowedUserIds: [4242],
        botToken: "1234567890:TEST",
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls, getStreamControl } = createMockClient({
        autoComplete: false,
        streaming: true,
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const chatAttempt = createMessageContext({
        text: "hello agent",
        userId: 4242,
      });
      const stopAttempt = createMessageContext({
        text: "/stop",
        userId: 4242,
      });

      const chatPromise = handleMessage(chatAttempt.ctx);

      try {
        await waitForCondition(
          () => getStreamControl()?.signal != null,
          "Expected in-flight stream control before /stop"
        );

        await handleMessage(stopAttempt.ctx);
        await chatPromise;

        expect(calls.sendStream).toBe(1);
        expect(stopAttempt.replies).toEqual([]);
        expect(chatAttempt.replies).toEqual(["Stopped."]);
      } finally {
        getStreamControl()?.complete();
        await chatPromise.catch(() => undefined);
      }
    });
  });

  test("/stop with no active stream replies with nothing to stop", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        allowedUserIds: [4242],
        botToken: "1234567890:TEST",
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const { ctx, replies } = createMessageContext({
        text: "/stop",
        userId: 4242,
      });

      await handleMessage(ctx);

      expect(replies).toEqual(["Nothing to stop."]);
    });
  });

  test("shows todo progress in one status message and keeps the final completed state", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        allowedUserIds: [4242],
        botToken: "1234567890:TEST",
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client } = createMockClient({
        steps: [
          {
            todos: [
              { content: "Plan changes", id: "plan", status: "in_progress" },
              { content: "Ship update", id: "ship", status: "pending" },
            ],
            type: "todos",
          },
          {
            todos: [
              { content: "Plan changes", id: "plan", status: "completed" },
              { content: "Ship update", id: "ship", status: "completed" },
            ],
            type: "todos",
          },
          { todos: [], type: "todos" },
          { reply: "Done", type: "resolve" },
        ],
        streaming: true,
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const { ctx, replies, edits } = createMessageContext({
        text: "hello agent",
        userId: 4242,
      });

      await handleMessage(ctx);

      expect(replies).toHaveLength(2);
      expect(replies[0]).toContain("🛠️ Working");
      expect(replies[0]).toContain("🔄 [~] Plan changes");
      expect(replies[0]).toContain("⏳ [ ] Ship update");
      expect(replies[1]).toBe("Done");
      expect(edits).toHaveLength(2);
      expect(edits[0]).toEqual({
        chatId: 4242,
        messageId: 1,
        text: "🛠️ Working\n✅ [x] Plan changes\n✅ [x] Ship update",
      });
      expect(edits[1]).toEqual({
        chatId: 4242,
        messageId: 1,
        text: "✅ Completed\n✅ [x] Plan changes\n✅ [x] Ship update",
      });
    });
  });

  test("does not create a status message when no todo updates arrive", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        allowedUserIds: [4242],
        botToken: "1234567890:TEST",
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client } = createMockClient({
        steps: [
          { delta: "Agent ", type: "chunk" },
          { delta: "reply", type: "chunk" },
          { reply: "Agent reply", type: "resolve" },
        ],
        streaming: true,
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const { ctx, replies, edits } = createMessageContext({
        text: "hello agent",
        userId: 4242,
      });

      await handleMessage(ctx);

      expect(replies).toEqual(["Agent reply"]);
      expect(edits).toEqual([]);
    });
  });

  test("reuses the same status message when stopping an in-flight run", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        allowedUserIds: [4242],
        botToken: "1234567890:TEST",
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, getStreamControl } = createMockClient({
        autoComplete: false,
        steps: [
          {
            todos: [
              { content: "Plan changes", id: "plan", status: "in_progress" },
              { content: "Ship update", id: "ship", status: "pending" },
            ],
            type: "todos",
          },
        ],
        streaming: true,
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const chatAttempt = createMessageContext({
        text: "hello agent",
        userId: 4242,
      });
      const stopAttempt = createMessageContext({
        text: "/stop",
        userId: 4242,
      });

      const chatPromise = handleMessage(chatAttempt.ctx);

      try {
        await waitForCondition(
          () => getStreamControl()?.signal != null,
          "Expected in-flight stream control before /stop"
        );
        await handleMessage(stopAttempt.ctx);
        await chatPromise;

        expect(chatAttempt.replies).toEqual([
          "🛠️ Working\n🔄 [~] Plan changes\n⏳ [ ] Ship update",
          "Stopped.",
        ]);
        expect(chatAttempt.edits).toEqual([
          {
            chatId: 4242,
            messageId: 1,
            text: "⏹️ Stopped\n🔄 [~] Plan changes\n⏳ [ ] Ship update",
          },
        ]);
        expect(stopAttempt.replies).toEqual([]);
      } finally {
        getStreamControl()?.complete();
        await chatPromise.catch(() => undefined);
      }
    });
  });

  test("marks the status message as failed when the stream errors", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        allowedUserIds: [4242],
        botToken: "1234567890:TEST",
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client } = createMockClient({
        steps: [
          {
            todos: [
              { content: "Plan changes", id: "plan", status: "in_progress" },
              { content: "Ship update", id: "ship", status: "pending" },
            ],
            type: "todos",
          },
          { message: "Boom", type: "error" },
        ],
        streaming: true,
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const { ctx, replies, edits } = createMessageContext({
        text: "hello agent",
        userId: 4242,
      });

      await handleMessage(ctx);

      expect(replies).toEqual([
        "🛠️ Working\n🔄 [~] Plan changes\n⏳ [ ] Ship update",
        "Boom",
      ]);
      expect(edits).toEqual([
        {
          chatId: 4242,
          messageId: 1,
          text: "❌ Failed\n🔄 [~] Plan changes\n⏳ [ ] Ship update",
        },
      ]);
    });
  });

  test("skips redundant edits for identical todo payloads", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        allowedUserIds: [4242],
        botToken: "1234567890:TEST",
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client } = createMockClient({
        steps: [
          {
            todos: [
              { content: "Plan changes", id: "plan", status: "in_progress" },
              { content: "Ship update", id: "ship", status: "pending" },
            ],
            type: "todos",
          },
          {
            todos: [
              { content: "Plan changes", id: "plan", status: "in_progress" },
              { content: "Ship update", id: "ship", status: "pending" },
            ],
            type: "todos",
          },
          { reply: "Done", type: "resolve" },
        ],
        streaming: true,
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const { ctx, replies, edits } = createMessageContext({
        text: "hello agent",
        userId: 4242,
      });

      await handleMessage(ctx);

      expect(replies).toEqual([
        "🛠️ Working\n🔄 [~] Plan changes\n⏳ [ ] Ship update",
        "Done",
      ]);
      expect(edits).toEqual([
        {
          chatId: 4242,
          messageId: 1,
          text: "✅ Completed\n🔄 [~] Plan changes\n⏳ [ ] Ship update",
        },
      ]);
    });
  });

  test("/start shows pairing prompt before authorization", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        handshakeCode: "ABCD1234",
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const { ctx, replies } = createMessageContext({
        text: "/start",
        userId: 1001,
      });

      await handleMessage(ctx);

      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain("Paste your pairing code");
      expect(calls.sendStream).toBe(0);
    });
  });

  test("/start@botname shows help for authorized users", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        allowedUserIds: [4242],
        botToken: "1234567890:TEST",
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const { ctx, replies } = createMessageContext({
        text: "/start@AtlasBot",
        userId: 4242,
      });

      await handleMessage(ctx);

      expect(calls.sendStream).toBe(0);
      expect(replies.join("\n")).toContain("/help");
      expect(replies.join("\n")).toContain("/start");
    });
  });

  test("prompts for dashboard setup when no pairing code is active", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const { ctx, replies } = createMessageContext({
        text: "ABCD1234",
        userId: 1001,
      });

      await handleMessage(ctx);

      expect(replies[0]).toContain("not linked yet");
      expect(calls.sendStream).toBe(0);
    });
  });
});

describe("bridge API integration", () => {
  test("calls org and profile APIs before creating a chat session", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [1001],
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls, orgIds } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const { ctx } = createMessageContext({ text: "hello", userId: 1001 });
      await handleMessage(ctx);

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
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [1001],
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const { ctx, replies } = createMessageContext({
        text: "hello",
        userId: 1001,
      });
      await handleMessage(ctx);

      expect(
        replies.some((reply) => reply.includes("Choose an organization"))
      ).toBe(false);
      expect(orgStore.get("u:1001")?.orgId).toBe("org_test");
    });
  });

  test("legacy concurrent chats keep their own org on createSession", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [1001, 2002],
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, getCreateSessionOrgIds } = createMockClient({
        orgs: createMultiTestOrgs(),
        profilesByOrgId: {
          org_a: [{ id: "alpha", isDefault: true, name: "Alpha Agent" }],
          org_b: [{ id: "beta", isDefault: true, name: "Beta Agent" }],
        },
      });
      const originalCreate = client.createSession.bind(client);
      client.createSession = async (
        channel,
        options?: { profileId?: string }
      ) => {
        await Bun.sleep(40);
        return originalCreate(channel, options);
      };
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      orgStore.set("u:1001", "org_a");
      orgStore.set("u:2002", "org_b");
      await orgStore.save();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const userA = createMessageContext({
        chatId: 1001,
        text: "hello from a",
        userId: 1001,
      });
      const userB = createMessageContext({
        chatId: 2002,
        text: "hello from b",
        userId: 2002,
      });
      await Promise.all([handleMessage(userA.ctx), handleMessage(userB.ctx)]);

      expect(getCreateSessionOrgIds().slice().sort()).toEqual([
        "org_a",
        "org_b",
      ]);
    });
  });

  test("prompts for org selection when multiple orgs exist", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [1001],
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient({
        orgs: createMultiTestOrgs(),
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const { ctx, replies } = createMessageContext({
        text: "hello",
        userId: 1001,
      });
      await handleMessage(ctx);

      expect(replies.join("\n")).toContain("Choose an organization");
      expect(calls.createSession).toBe(0);
      expect(calls.sendStream).toBe(0);
    });
  });

  test("continues chatting after the user selects an org", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [1001],
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls, orgIds } = createMockClient({
        orgs: createMultiTestOrgs(),
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const pick = createMessageContext({ text: "2", userId: 1001 });
      await handleMessage(pick.ctx);

      expect(orgIds).toContain("org_b");
      expect(pick.replies.join("\n")).toContain("Now using Beta");

      const chat = createMessageContext({ text: "hello", userId: 1001 });
      await handleMessage(chat.ctx);

      expect(calls.createSession).toBe(1);
      expect(calls.sendStream).toBe(1);
    });
  });

  test("/profile lists profiles for the active org", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [1001],
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client } = createMockClient({
        profiles: [
          { id: "default", isDefault: true, name: "Default Agent" },
          { id: "research", name: "Research Bot" },
        ],
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const { ctx, replies } = createMessageContext({
        text: "/profile",
        userId: 1001,
      });
      await handleMessage(ctx);

      expect(replies.join("\n")).toContain("Choose a profile");
      expect(replies.join("\n")).toContain("Default Agent");
      expect(replies.join("\n")).toContain("Research Bot");
    });
  });

  test("/profile hides super agent from channel profile switches", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [1001],
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client } = createMockClient({
        profiles: [
          { id: "default", isDefault: true, name: "Default Agent" },
          { id: "super_agent", isSuper: true, name: "Super Agent" },
        ],
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const { ctx, replies } = createMessageContext({
        text: "/profile",
        userId: 1001,
      });
      await handleMessage(ctx);

      const text = replies.join("\n");
      expect(text).toContain("Default Agent");
      expect(text).not.toContain("Super Agent");
    });
  });

  test("/profile switches bot and starts a fresh session", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [1001],
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls, getLastCreateSessionProfileId } = createMockClient(
        {
          profiles: [
            { id: "default", isDefault: true, name: "Default Agent" },
            { id: "research", name: "Research Bot" },
          ],
        }
      );
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const chat = createMessageContext({ text: "hello", userId: 1001 });
      await handleMessage(chat.ctx);
      expect(getLastCreateSessionProfileId()).toBe("default");

      const switchProfile = createMessageContext({
        text: "/profile research",
        userId: 1001,
      });
      await handleMessage(switchProfile.ctx);

      expect(calls.createSession).toBe(2);
      expect(getLastCreateSessionProfileId()).toBe("research");
      expect(switchProfile.replies).toEqual([
        "Now using Research Bot. Chat history reset.",
      ]);
      expect(sessionStore.get("1001")?.profileId).toBe("research");
    });
  });

  test("/profile switches org when the profile lives in another org", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [1001],
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, getLastCreateSessionProfileId } = createMockClient({
        orgs: createMultiTestOrgs(),
        profilesByOrgId: {
          org_a: [{ id: "default", isDefault: true, name: "Default Agent" }],
          org_b: [{ id: "gary", isDefault: true, name: "Gary Vee" }],
        },
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      orgStore.set("u:1001", "org_a");
      await orgStore.save();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const switchProfile = createMessageContext({
        text: "/profile garry-vee",
        userId: 1001,
      });
      await handleMessage(switchProfile.ctx);

      expect(orgStore.get("u:1001")?.orgId).toBe("org_b");
      expect(getLastCreateSessionProfileId()).toBe("gary");
      expect(switchProfile.replies).toEqual([
        "Now using Gary Vee. Chat history reset. (Beta)",
      ]);
    });
  });

  test("/profile accepts the visible list number in the current org", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [1001],
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, getLastCreateSessionProfileId } = createMockClient({
        orgs: createMultiTestOrgs(),
        profilesByOrgId: {
          org_a: [
            { id: "default", isDefault: true, name: "Default Agent" },
            { id: "research", name: "Research Bot" },
          ],
          org_b: [
            { id: "writer", isDefault: true, name: "Writer Bot" },
            { id: "gary", name: "Gary Vee" },
          ],
        },
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      orgStore.set("u:1001", "org_a");
      await orgStore.save();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const switchProfile = createMessageContext({
        text: "/profile 2",
        userId: 1001,
      });
      await handleMessage(switchProfile.ctx);

      expect(orgStore.get("u:1001")?.orgId).toBe("org_a");
      expect(getLastCreateSessionProfileId()).toBe("research");
      expect(switchProfile.replies).toEqual([
        "Now using Research Bot. Chat history reset.",
      ]);
    });
  });
});

describe("createChatHandler document attachments", () => {
  let fetchSpy: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  function createDocumentContext(options: {
    userId: number;
    fileName: string;
    mimeType: string;
    caption?: string;
  }) {
    const base = createMessageContext({ userId: options.userId });
    (base.ctx as { message: Record<string, unknown> }).message = {
      caption: options.caption,
      document: {
        file_id: "doc-1",
        file_name: options.fileName,
        mime_type: options.mimeType,
      },
    };
    (base.ctx as { api: Record<string, unknown> }).api = {
      ...((base.ctx as { api?: Record<string, unknown> }).api ?? {}),
      getFile: async () => ({ file_path: `documents/${options.fileName}` }),
      token: "test-token",
    };

    return base;
  }

  test("forwards supported pdf documents to sendStream", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        allowedUserIds: [4242],
        botToken: "1234567890:TEST",
      });

      fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("pdf-content", {
          headers: { "content-type": "application/pdf" },
        })
      );

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls, getLastStreamInput } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const { ctx, replies } = createDocumentContext({
        caption: "Summarize",
        fileName: "report.pdf",
        mimeType: "application/pdf",
        userId: 4242,
      });

      await handleMessage(ctx);

      expect(calls.sendStream).toBe(1);
      expect(getLastStreamInput()).toEqual({
        documents: [
          expect.objectContaining({
            filename: "report.pdf",
            mediaType: "application/pdf",
          }),
        ],
        message: "Summarize",
      });
      expect(replies.at(-1)).toBe("Agent reply");
    });
  });

  test("forwards a captionless pdf to sendStream", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        allowedUserIds: [4242],
        botToken: "1234567890:TEST",
      });

      fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("pdf-content", {
          headers: { "content-type": "application/pdf" },
        })
      );

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls, getLastStreamInput } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const { ctx } = createDocumentContext({
        fileName: "report.pdf",
        mimeType: "application/pdf",
        userId: 4242,
      });

      await handleMessage(ctx);

      expect(calls.sendStream).toBe(1);
      expect(getLastStreamInput()).toEqual({
        documents: [
          expect.objectContaining({
            filename: "report.pdf",
            mediaType: "application/pdf",
          }),
        ],
        message: "",
      });
    });
  });

  test("forwards an xlsx document to sendStream", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        allowedUserIds: [4242],
        botToken: "1234567890:TEST",
      });

      fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("xlsx-content", {
          headers: {
            "content-type":
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          },
        })
      );

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls, getLastStreamInput } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const { ctx } = createDocumentContext({
        caption: "Analyze",
        fileName: "sales.xlsx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        userId: 4242,
      });

      await handleMessage(ctx);

      expect(calls.sendStream).toBe(1);
      expect(getLastStreamInput()).toEqual({
        documents: [
          expect.objectContaining({
            filename: "sales.xlsx",
            mediaType:
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          }),
        ],
        message: "Analyze",
      });
    });
  });

  test("rejects unsupported documents without calling sendStream", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        allowedUserIds: [4242],
        botToken: "1234567890:TEST",
      });

      fetchSpy = spyOn(globalThis, "fetch");

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const { ctx, replies } = createDocumentContext({
        fileName: "archive.zip",
        mimeType: "application/zip",
        userId: 4242,
      });

      await handleMessage(ctx);

      expect(calls.sendStream).toBe(0);
      expect(replies).toEqual([UNSUPPORTED_DOCUMENT_TYPES_REPLY]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  test("transcribes voice messages and forwards text to the agent", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        allowedUserIds: [4242],
        botToken: "1234567890:TEST",
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(Buffer.from("voice-bytes"), {
          headers: { "content-type": "audio/ogg" },
          status: 200,
        })
      );
      const { client, calls, getLastStreamInput, getLastTranscribeAudioInput } =
        createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const { ctx, replies } = createMessageContext({ userId: 4242 });
      (ctx as { message: Record<string, unknown> }).message = {
        voice: { file_id: "voice-1" },
      };
      (ctx as { api: Record<string, unknown> }).api = {
        ...((ctx as { api?: Record<string, unknown> }).api ?? {}),
        getFile: async () => ({ file_path: "voice/file.ogg" }),
        token: "test-token",
      };

      await handleMessage(ctx);

      expect(calls.transcribeAudio).toBe(1);
      expect(getLastTranscribeAudioInput()).toEqual(
        expect.objectContaining({ sessionId: "session_test" })
      );
      expect(calls.sendStream).toBe(1);
      expect(getLastStreamInput()).toEqual({
        message: "Transcribed voice message",
      });
      expect(replies.at(-1)).toBe("Agent reply");
      fetchSpy.mockRestore();
    });
  });

  test("replies with supported media guidance for other non-text messages", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        allowedUserIds: [4242],
        botToken: "1234567890:TEST",
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const { ctx, replies } = createMessageContext({ userId: 4242 });
      (ctx as { message: Record<string, unknown> }).message = {
        sticker: { file_id: "sticker-1" },
      };

      await handleMessage(ctx);

      expect(calls.sendStream).toBe(0);
      expect(replies).toEqual([UNSUPPORTED_MEDIA_REPLY]);
    });
  });

  test("runs /help even when the same message includes a document", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        allowedUserIds: [4242],
        botToken: "1234567890:TEST",
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const { ctx, replies } = createMessageContext({
        text: "/help",
        userId: 4242,
      });
      (ctx as { message: Record<string, unknown> }).message = {
        ...(ctx.message as Record<string, unknown>),
        document: {
          file_id: "doc-1",
          file_name: "report.pdf",
          mime_type: "application/pdf",
        },
        text: "/help",
      };

      await handleMessage(ctx);

      expect(calls.sendStream).toBe(0);
      expect(replies.join("\n")).toContain("/help");
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

  test("posts a publish share link after a paired save-artifact turn", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [4242],
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient({
        messages: artifactMessages,
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      await sessionStore.load();
      sessionStore.set("4242", {
        channelUserId: "4242",
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const mock = createMessageContext({
        text: "thanks",
        userId: 4242,
      });
      await handleMessage(mock.ctx);

      expect(calls.publishProfileArtifactShare).toBe(1);
      expect(calls.readProfileArtifactContent).toBe(1);
      expect(mock.documentSends).toBe(1);
      expect(
        mock.replies.some((reply) =>
          reply.includes("https://app.example/s/tok_test")
        )
      ).toBe(true);
    });
  });

  test("publishes and sends when write_file saved an artifact without sidecar", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [4242],
      });

      const authStore = new TelegramAuthStore();
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
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      await sessionStore.load();
      sessionStore.set("4242", {
        channelUserId: "4242",
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const mock = createMessageContext({
        text: "thanks",
        userId: 4242,
      });
      await handleMessage(mock.ctx);

      expect(calls.publishProfileArtifactShare).toBe(1);
      expect(calls.readProfileArtifactContent).toBe(1);
      expect(mock.documentSends).toBe(1);
      expect(
        mock.replies.some((reply) =>
          reply.includes("https://app.example/s/tok_test")
        )
      ).toBe(true);
    });
  });

  test("publishes and sends a spreadsheet created in the turn", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [4242],
      });

      const authStore = new TelegramAuthStore();
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
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      await sessionStore.load();
      sessionStore.set("4242", {
        channelUserId: "4242",
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const mock = createMessageContext({
        text: "thanks",
        userId: 4242,
      });
      await handleMessage(mock.ctx);

      expect(calls.publishProfileArtifactShare).toBe(1);
      expect(calls.readProfileArtifactContent).toBe(1);
      expect(mock.documentSends).toBe(1);
    });
  });

  test("sends an artifact emitted by the live agent stream", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [4242],
      });

      const authStore = new TelegramAuthStore();
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
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });
      const mock = createMessageContext({
        text: "make a report",
        userId: 4242,
      });

      await handleMessage(mock.ctx);

      expect(calls.publishProfileArtifactShare).toBe(1);
      expect(calls.readProfileArtifactContent).toBe(1);
      expect(mock.documentSends).toBe(1);
    });
  });

  test("does not publish when the turn wrote nothing under artifacts/", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [4242],
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient({
        messages: [
          { content: "hello", role: "user" },
          { content: "hi", role: "assistant" },
        ],
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      await sessionStore.load();
      sessionStore.set("4242", {
        channelUserId: "4242",
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const { ctx, replies } = createMessageContext({
        text: "thanks",
        userId: 4242,
      });
      await handleMessage(ctx);

      expect(calls.publishProfileArtifactShare).toBe(0);
      expect(replies.some((reply) => reply.includes("/s/"))).toBe(false);
    });
  });

  test("sends a document when the user asks to attach a saved artifact", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [4242],
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      await sessionStore.load();
      sessionStore.set("4242", {
        channelUserId: "4242",
        deliverableArtifacts: [
          {
            filename: "report.md",
            mimeType: "text/markdown",
            path: "report.md",
            savedAt: "2026-07-13T10:00:00.000Z",
            sharePath: "/s/tok_test",
            shareUrl: "https://app.example/s/tok_test",
            sizeBytes: 42,
          },
        ],
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      let sendDocumentCalls = 0;
      const { ctx } = createMessageContext({
        text: "send me the file",
        userId: 4242,
      });
      (ctx.api as { sendDocument: typeof ctx.api.sendMessage }).sendDocument =
        async () => {
          sendDocumentCalls += 1;
          return { message_id: 99 };
        };

      await handleMessage(ctx);

      expect(calls.readProfileArtifactContent).toBe(1);
      expect(sendDocumentCalls).toBe(1);
    });
  });

  test("typed /attach sends the last saved artifact without an agent turn", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [4242],
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient();
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      await sessionStore.load();
      sessionStore.set("4242", {
        channelUserId: "4242",
        deliverableArtifacts: [
          {
            filename: "report.md",
            mimeType: "text/markdown",
            path: "report.md",
            savedAt: "2026-07-13T10:00:00.000Z",
            sharePath: "/s/tok_test",
            shareUrl: "https://app.example/s/tok_test",
            sizeBytes: 42,
          },
        ],
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      let sendDocumentCalls = 0;
      const mock = createMessageContext({
        text: "/attach",
        userId: 4242,
      });
      (
        mock.ctx.api as { sendDocument: typeof mock.ctx.api.sendMessage }
      ).sendDocument = async () => {
        sendDocumentCalls += 1;
        return { message_id: 99 };
      };

      await handleMessage(mock.ctx);

      expect(calls.sendStream).toBe(0);
      expect(calls.readProfileArtifactContent).toBe(1);
      expect(sendDocumentCalls).toBe(1);
      expect(mock.replies.some((reply) => /unknown command/i.test(reply))).toBe(
        false
      );
    });
  });

  test("still sends the file when share publishing fails", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [4242],
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient({
        failPublishShare: true,
        messages: artifactMessages,
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      await sessionStore.load();
      sessionStore.set("4242", {
        channelUserId: "4242",
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const mock = createMessageContext({
        text: "thanks",
        userId: 4242,
      });
      await handleMessage(mock.ctx);

      expect(calls.publishProfileArtifactShare).toBe(1);
      expect(calls.readProfileArtifactContent).toBe(1);
      expect(mock.documentSends).toBe(1);
      expect(
        mock.replies.some((reply) =>
          reply.includes("https://app.example/s/tok_test")
        )
      ).toBe(false);
    });
  });

  test("keeps the agent turn going when attach download fails", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [4242],
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls } = createMockClient({
        failReadArtifact: true,
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      await sessionStore.load();
      sessionStore.set("4242", {
        channelUserId: "4242",
        deliverableArtifacts: [
          {
            filename: "report.md",
            mimeType: "text/markdown",
            path: "report.md",
            savedAt: "2026-07-13T10:00:00.000Z",
            sharePath: "/s/tok_test",
            shareUrl: "https://app.example/s/tok_test",
            sizeBytes: 42,
          },
        ],
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const mock = createMessageContext({
        text: "send me the file",
        userId: 4242,
      });
      await handleMessage(mock.ctx);

      expect(calls.readProfileArtifactContent).toBe(1);
      expect(calls.sendStream).toBe(1);
      expect(
        mock.replies.some((reply) =>
          reply.includes("Failed to read the saved file.")
        )
      ).toBe(true);
    });
  });

  test("tells the user when a saved artifact is too large to send", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [4242],
      });

      const authStore = new TelegramAuthStore();
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
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      await sessionStore.load();
      sessionStore.set("4242", {
        channelUserId: "4242",
        profileId: "default",
        sessionId: "session_test",
        updatedAt: new Date().toISOString(),
      });
      await sessionStore.save();
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        orgStore,
        sessionStore,
      });

      const mock = createMessageContext({
        text: "thanks",
        userId: 4242,
      });
      await handleMessage(mock.ctx);

      expect(calls.readProfileArtifactContent).toBe(0);
      expect(mock.documentSends).toBe(0);
      expect(
        mock.replies.some((reply) =>
          reply.includes("File is too large for Telegram")
        )
      ).toBe(true);
    });
  });

  test("locks chat to fixedWorkspaceId and prevents switching workspaces", async () => {
    await withTempHome(async (homeDir) => {
      await writeTelegramConfigIni(homeDir, {
        botToken: "1234567890:TEST",
        pairedUserIds: [4242],
      });

      const authStore = new TelegramAuthStore();
      await authStore.reload();
      const { client, calls, orgIds } = createMockClient({
        orgs: createMultiTestOrgs(),
        profilesByOrgId: {
          org_a: [{ id: "gary", isDefault: true, name: "Gary Vee" }],
          org_b: [{ id: "default", isDefault: true, name: "Default Agent" }],
        },
      });
      const sessionStore = new SessionStore(
        path.join(homeDir, ".atlas", "telegram", "chat-sessions.json")
      );
      const orgStore = createTestOrgStore(homeDir);
      await orgStore.load();
      const handleMessage = createChatHandler({
        authStore,
        client,
        config: { botToken: "1234567890:TEST", profileId: "default" },
        fixedWorkspaceId: "org_b",
        orgStore,
        sessionStore,
      });

      const chatMsg = createMessageContext({
        text: "hello",
        userId: 4242,
      });
      await handleMessage(chatMsg.ctx);

      expect(orgIds).toContain("org_b");
      expect(calls.createSession).toBe(1);
      expect(calls.sendStream).toBe(1);
      expect(
        chatMsg.replies.some((reply) =>
          reply.includes("Choose an organization")
        )
      ).toBe(false);

      const orgCmd = createMessageContext({
        text: "/org",
        userId: 4242,
      });
      await handleMessage(orgCmd.ctx);

      expect(
        orgCmd.replies.some((reply) =>
          reply.includes(
            "belongs to one workspace and cannot switch workspaces"
          )
        )
      ).toBe(true);

      const profileCmd = createMessageContext({
        text: "/profile garry-vee",
        userId: 4242,
      });
      await handleMessage(profileCmd.ctx);

      expect(orgStore.get("u:4242")?.orgId).toBe("org_b");
      expect(profileCmd.replies).toEqual([
        "Unknown profile. Send /profile to see the list.",
      ]);
      expect(calls.createSession).toBe(1);
    });
  });
});

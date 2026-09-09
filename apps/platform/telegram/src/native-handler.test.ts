import { expect, test } from "bun:test";
import { join } from "node:path";
import type { AgentQuestionnaire, ApprovalRequest } from "@atlas/core/contract";
import { Bot, type Context } from "grammy";
import { TelegramAuthStore } from "./auth-store";
import { registerTelegramBotHandlers } from "./bot";
import { createChatHandler, resetChatLocksForTests } from "./chat-handler";
import { SessionStore } from "./session-store";
import {
  createMockClient,
  createTestOrgStore,
  withTempHome,
  writeTelegramConfigIni,
} from "./test-helpers";

const questionnaire: AgentQuestionnaire = {
  id: "q_a",
  questions: [
    {
      allowCustomAnswer: true,
      choices: [
        { id: "a", label: "Internal" },
        { id: "b", label: "External" },
      ],
      id: "q1",
      prompt: "Choose destination",
    },
  ],
  title: "Choose",
};
const approval: ApprovalRequest = {
  consequenceSummary: "Creates the report",
  createdAt: new Date().toISOString(),
  id: "approval_a",
  status: "pending",
  title: "Write report",
  tool: "write_file",
  toolCallId: "write_a",
};

async function fixture(
  home: string,
  kind: "questionnaire" | "approval",
  group = false
) {
  resetChatLocksForTests();
  await writeTelegramConfigIni(home, {
    botToken: "123:controlled",
    pairedUserIds: [42],
  });
  const authStore = new TelegramAuthStore();
  await authStore.reload();
  const mock = createMockClient({
    steps:
      kind === "questionnaire"
        ? [{ questionnaire, type: "questionnaire" }]
        : [{ approval, type: "approval" }],
    streaming: true,
  });
  const orgStore = createTestOrgStore(home);
  await orgStore.load();
  const sessionStore = new SessionStore(join(home, "native-sessions.json"));
  const decisions: unknown[] = [];
  let allowed = true;
  const originalAuthorize = mock.client.authorizeChannelPrincipal.bind(
    mock.client
  );
  mock.client.authorizeChannelPrincipal = async (input) => {
    if (!allowed) {
      throw new Error("Current membership revoked");
    }
    return originalAuthorize(input);
  };
  mock.client.decideChannelApproval = async (input) => {
    decisions.push(input);
    return { resumed: true, status: input.decision };
  };
  const handler = createChatHandler({
    authStore,
    client: mock.client,
    config: { botToken: "123:controlled", profileId: "default" },
    orgStore,
    sessionStore,
  });
  const pending: Promise<void>[] = [];
  const errors: unknown[] = [];
  const observedHandler = Object.assign(
    (ctx: Context) => {
      const operation = handler(ctx);
      pending.push(operation);
      return operation;
    },
    {
      handleCallback: (ctx: Context) => {
        const operation = handler.handleCallback(ctx);
        pending.push(operation);
        return operation;
      },
    }
  );
  const bot = new Bot("123:controlled", {
    botInfo: {
      allows_users_to_create_topics: false,
      can_connect_to_business: false,
      can_join_groups: true,
      can_manage_bots: false,
      can_read_all_group_messages: false,
      first_name: "Atlas",
      has_main_web_app: false,
      has_topics_enabled: false,
      id: 123,
      is_bot: true,
      supports_inline_queries: false,
      username: "atlas_test",
    },
  });
  const cards = new Map<
    number,
    Array<Array<{ text: string; callback_data: string }>>
  >();
  const chat = group
    ? {
        id: -100,
        is_forum: true as const,
        title: "Controlled forum",
        type: "supergroup" as const,
      }
    : { first_name: "Sender", id: 42, type: "private" as const };
  const thread = group
    ? { is_topic_message: true as const, message_thread_id: 77 }
    : {};
  let messageId = 100;
  bot.api.config.use(async (_previous, method, payload) => {
    const params = payload as {
      message_id?: number;
      reply_markup?: {
        inline_keyboard?: Array<Array<{ text: string; callback_data: string }>>;
      };
    };
    const id = params.message_id ?? ++messageId;
    if (params.reply_markup?.inline_keyboard) {
      cards.set(id, params.reply_markup.inline_keyboard);
    }
    return {
      ok: true,
      result:
        method === "answerCallbackQuery" || method === "sendChatAction"
          ? true
          : { chat, ...thread, date: 1, message_id: id },
    } as never;
  });
  registerTelegramBotHandlers(bot, observedHandler, (error) =>
    errors.push(error)
  );
  const flush = async () => {
    await Promise.allSettled(pending.splice(0));
  };
  await bot.handleUpdate({
    message: {
      chat,
      ...thread,
      date: 1,
      from: { first_name: "Sender", id: 42, is_bot: false },
      message_id: 1,
      text: group ? "@atlas_test Start" : "Start",
      ...(group
        ? { entities: [{ length: 11, offset: 0, type: "mention" as const }] }
        : {}),
    },
    update_id: 1,
  });
  await flush();
  const firstCard = () =>
    [...cards.entries()].find(([, keyboard]) => keyboard.length > 0)!;
  const click = async (data: string, sender = 42) => {
    const [id] = firstCard();
    await bot.handleUpdate({
      callback_query: {
        chat_instance: "test",
        data,
        from: { first_name: "Sender", id: sender, is_bot: false },
        id: "callback",
        message: { chat, ...thread, date: 1, message_id: id, text: "Question" },
      },
      update_id: 2,
    });
    await flush();
  };
  return {
    click,
    decisions,
    deny: () => {
      allowed = false;
    },
    errors,
    firstCard,
    mock,
    orgStore,
    sessionStore,
  };
}

for (const group of [false, true]) {
  test(`actual ${group ? "forum topic" : "direct"} chat stream renders a native question and its bot callback preserves the snapshot in the dependent answer turn`, async () => {
    await withTempHome(async (home) => {
      const f = await fixture(home, "questionnaire", group);
      expect(f.mock.calls.sendStream).toBe(1);
      await f.click(f.firstCard()[1][0]![0]!.callback_data);
      const submit = f.firstCard()[1].at(-1)![0]!.callback_data;
      await f.click(submit);
      expect(f.mock.calls.sendStream).toBe(2);
      expect(f.mock.getLastStreamInput()).toMatchObject({
        expectedQuestionnaire: questionnaire,
        message: expect.stringContaining(
          "Answers\n\nQ: Choose destination\nA: Internal"
        ),
      });
      expect(f.errors).toEqual([]);
    });
  });
}

for (const revoked of ["sender", "membership", "tenant", "session"] as const) {
  test(`actual bot rejects ${revoked} change before resolving a pending approval`, async () => {
    await withTempHome(async (home) => {
      const f = await fixture(home, "approval");
      const data = f.firstCard()[1][0]![0]!.callback_data;
      if (revoked === "membership") {
        f.deny();
      }
      if (revoked === "tenant") {
        f.orgStore.set("u:42", "org_other");
      }
      if (revoked === "session") {
        f.sessionStore.set("42", {
          channelUserId: "42",
          profileId: "default",
          sessionId: "other_session",
          updatedAt: new Date().toISOString(),
        });
      }
      await f.click(data, revoked === "sender" ? 99 : 42);
      expect(f.decisions).toEqual([]);
      expect(f.mock.calls.sendStream).toBe(1);
    });
  });
}

test("actual bot approval carries the bound canonical sender and room to the server", async () => {
  await withTempHome(async (home) => {
    const f = await fixture(home, "approval");
    await f.click(f.firstCard()[1][0]![0]!.callback_data);
    expect(f.decisions).toEqual([
      expect.objectContaining({
        approvalId: "approval_a",
        channel: "telegram",
        channelAddressed: true,
        channelChatId: "42",
        channelIsGroup: false,
        channelUserId: "42",
        decision: "approved",
        profileId: "default",
        sessionId: "session_test",
      }),
    ]);
    expect(f.errors).toEqual([]);
  });
});

test("a questionnaire replaced through another client cannot accept a stale native choice", async () => {
  await withTempHome(async (home) => {
    const f = await fixture(home, "questionnaire");
    const original = f.mock.client.getSessionMessages.bind(f.mock.client);
    f.mock.client.getSessionMessages = async (sessionId) => ({
      ...(await original(sessionId)),
      questionnaire: null,
    });
    await f.click(f.firstCard()[1][0]![0]!.callback_data);
    expect(f.mock.calls.sendStream).toBe(1);
    expect(f.firstCard()[1][0]![0]!.text.startsWith("✓")).toBe(false);
    expect(f.errors).toHaveLength(1);
  });
});

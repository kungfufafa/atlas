import { expect, test } from "bun:test";
import type { AgentQuestionnaire, ApprovalRequest } from "@atlas/core/contract";
import { Bot, type Context } from "grammy";
import { registerTelegramBotHandlers } from "./bot";
import type { createChatHandler } from "./chat-handler";
import {
  type TelegramControlBinding,
  TelegramNativeControls,
} from "./native-controls";

const binding: TelegramControlBinding = {
  addressed: true,
  channelOrgKey: "g:-100",
  channelUserId: "42",
  chatId: -100,
  isGroup: true,
  orgId: "tenant_a",
  profileId: "profile_a",
  sessionId: "session_a",
  sessionKey: "key_a",
  threadId: 77,
};
const questionnaire: AgentQuestionnaire = {
  id: "questionnaire_a",
  questions: [
    {
      allowCustomAnswer: false,
      choices: [
        { id: "a", label: "First" },
        { id: "b", label: "Second" },
      ],
      id: "q1",
      prompt: "Pick one",
    },
  ],
  title: "Choose",
};
const approval: ApprovalRequest = {
  consequenceSummary: "Changes a file",
  createdAt: new Date().toISOString(),
  id: "approval_a",
  status: "pending",
  title: "Run action",
  tool: "write_file",
  toolCallId: "call_a",
};

function fixture() {
  let currentTime = 1000;
  let allowed = true;
  let currentOrg = "tenant_a";
  const authorizations: TelegramControlBinding[] = [];
  const sends: Array<{
    chatId: number;
    text: string;
    options: {
      reply_markup: {
        inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
      };
      message_thread_id?: number;
    };
  }> = [];
  const keyboards: Array<
    Array<Array<{ text: string; callback_data: string }>>
  > = [];
  const edits: string[] = [];
  const acknowledgements: string[] = [];
  const answers: unknown[] = [];
  const decisions: string[] = [];
  const api = {
    editMessageReplyMarkup: async (
      _chatId: number,
      _messageId: number,
      options: { reply_markup: { inline_keyboard: (typeof keyboards)[number] } }
    ) => {
      keyboards.push(options.reply_markup.inline_keyboard);
    },
    editMessageText: async (
      _chatId: number,
      _messageId: number,
      text: string
    ) => {
      edits.push(text);
    },
    sendMessage: async (
      chatId: number,
      text: string,
      options: (typeof sends)[number]["options"]
    ) => {
      sends.push({ chatId, options, text });
      return { message_id: 55 };
    },
  };
  const ctx = { api } as unknown as Context;
  const controls = new TelegramNativeControls(
    async (actual) => {
      authorizations.push(actual);
      if (!allowed || actual.orgId !== currentOrg) {
        throw new Error("Denied by current canonical authority");
      }
    },
    () => currentTime
  );
  const callback = (
    data: string,
    changes: {
      userId?: number;
      chatId?: number;
      messageId?: number;
      threadId?: number;
    } = {}
  ) =>
    ({
      answerCallbackQuery: async ({ text }: { text: string }) => {
        acknowledgements.push(text);
      },
      api,
      callbackQuery: {
        data,
        from: { id: changes.userId ?? 42 },
        message: {
          chat: { id: changes.chatId ?? -100 },
          message_id: changes.messageId ?? 55,
          message_thread_id: changes.threadId ?? 77,
        },
      },
    }) as unknown as Context;
  const latestKeyboard = () =>
    keyboards.at(-1) ?? sends.at(-1)!.options.reply_markup.inline_keyboard;
  return {
    acknowledgements,
    answers,
    authorizations,
    callback,
    controls,
    ctx,
    decisions,
    deny: () => {
      allowed = false;
    },
    edits,
    expire: () => {
      currentTime += 16 * 60 * 1000;
    },
    foreignTenant: () => {
      currentOrg = "tenant_b";
    },
    keyboards,
    latestKeyboard,
    publishApproval: (
      decide?: (decision: "approved" | "denied") => Promise<void>
    ) =>
      controls.approval({
        approval,
        binding,
        ctx,
        decide:
          decide ??
          (async (decision) => {
            decisions.push(decision);
          }),
      }),
    publishQuestionnaire: (value = questionnaire) =>
      controls.questionnaire({
        binding,
        ctx,
        questionnaire: value,
        submit: async (value) => {
          answers.push(value);
        },
      }),
    sends,
  };
}

test("single choice is revision-bound and submits the selected label once", async () => {
  const f = fixture();
  await f.publishQuestionnaire();
  const original = f.latestKeyboard()[0]![0]!.callback_data;
  await f.controls.handleCallback(f.callback(original));
  await f.controls.handleCallback(f.callback(original));
  expect(f.keyboards).toHaveLength(1);
  const submit = f.latestKeyboard().at(-1)![0]!.callback_data;
  await f.controls.handleCallback(f.callback(submit));
  await f.controls.handleCallback(f.callback(submit));
  expect(f.answers).toEqual([
    [{ answer: "First", prompt: "Pick one", questionId: "q1" }],
  ]);
  expect(f.sends[0]!.options.message_thread_id).toBe(77);
  expect(Buffer.byteLength(original)).toBeLessThanOrEqual(64);
});

test("multiple choices toggle and submit all selected labels", async () => {
  const f = fixture();
  await f.publishQuestionnaire({
    ...questionnaire,
    questions: [{ ...questionnaire.questions[0]!, selectionMode: "multiple" }],
  });
  await f.controls.handleCallback(
    f.callback(f.latestKeyboard()[0]![0]!.callback_data)
  );
  await f.controls.handleCallback(
    f.callback(f.latestKeyboard()[1]![0]!.callback_data)
  );
  expect(f.latestKeyboard()[0]![0]!.text.startsWith("✓")).toBe(true);
  expect(f.latestKeyboard()[1]![0]!.text.startsWith("✓")).toBe(true);
  await f.controls.handleCallback(
    f.callback(f.latestKeyboard().at(-1)![0]!.callback_data)
  );
  expect(f.answers).toEqual([
    [{ answer: "First, Second", prompt: "Pick one", questionId: "q1" }],
  ]);
});

for (const changes of [
  { userId: 99 },
  { chatId: -999 },
  { messageId: 999 },
  { threadId: 99 },
]) {
  test(`rejects copied controls on ${JSON.stringify(changes)} before authority or mutation`, async () => {
    const f = fixture();
    await f.publishApproval();
    const count = f.authorizations.length;
    await f.controls.handleCallback(
      f.callback(f.latestKeyboard()[0]![0]!.callback_data, changes)
    );
    expect(f.authorizations).toHaveLength(count);
    expect(f.decisions).toEqual([]);
    expect(f.edits).toEqual([]);
  });
}

for (const change of ["deny", "foreignTenant"] as const) {
  test(`rechecks ${change} before accepting an approval`, async () => {
    const f = fixture();
    await f.publishApproval();
    f[change]();
    await expect(
      f.controls.handleCallback(
        f.callback(f.latestKeyboard()[0]![0]!.callback_data)
      )
    ).rejects.toThrow();
    expect(f.decisions).toEqual([]);
    expect(f.edits).toEqual([]);
  });
}

test("expired and invalidated controls cannot run decisions", async () => {
  const f = fixture();
  await f.publishApproval();
  const first = f.latestKeyboard()[0]![0]!.callback_data;
  f.expire();
  await f.controls.handleCallback(f.callback(first));
  await f.publishApproval();
  const second = f.latestKeyboard()[0]![0]!.callback_data;
  f.controls.invalidate(binding.sessionKey);
  await f.controls.handleCallback(f.callback(second));
  expect(f.decisions).toEqual([]);
});

test("an uncertain approval response consumes the button without automatic retry", async () => {
  const f = fixture();
  let attempts = 0;
  await f.publishApproval(async () => {
    attempts++;
    throw new Error("response lost");
  });
  const data = f.latestKeyboard()[0]![0]!.callback_data;
  await expect(f.controls.handleCallback(f.callback(data))).rejects.toThrow();
  await f.controls.handleCallback(f.callback(data));
  expect(attempts).toBe(1);
});

test("approve and deny callbacks flow through the production grammY registration", async () => {
  const f = fixture();
  await f.publishApproval();
  const errors: unknown[] = [];
  const completed: Promise<void>[] = [];
  const handler = Object.assign(async () => {}, {
    handleCallback: (ctx: Context) => {
      const promise = f.controls.handleCallback(ctx);
      completed.push(promise);
      return promise;
    },
  }) as ReturnType<typeof createChatHandler>;
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
  bot.api.config.use(
    async (_previous, method) =>
      ({
        ok: true,
        result: method === "answerCallbackQuery" ? true : { message_id: 55 },
      }) as never
  );
  registerTelegramBotHandlers(bot, handler, (error) => errors.push(error));
  const update = (data: string) => ({
    callback_query: {
      chat_instance: "instance",
      data,
      from: { first_name: "User", id: 42, is_bot: false },
      id: "callback",
      message: {
        chat: { id: -100, title: "Test", type: "supergroup" as const },
        date: 1,
        message_id: 55,
        message_thread_id: 77,
      },
    },
    update_id: 1,
  });
  const data = f.latestKeyboard()[0]![1]!.callback_data;
  await bot.handleUpdate(update(data));
  await Promise.all(completed);
  expect(f.decisions).toEqual(["denied"]);
  expect(errors).toEqual([]);
  await bot.handleUpdate(update(data));
  await Promise.all(completed);
  expect(f.decisions).toHaveLength(1);
});

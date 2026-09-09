import { expect, test } from "bun:test";
import type { AgentQuestionnaire, ApprovalRequest } from "@atlas/core/contract";
import type { DiscordComponentMessage, DiscordMessenger } from "./messenger";
import { sendDiscordNativeApproval } from "./native-approval-message";
import {
  type DiscordCallbackBinding,
  DiscordCallbackRegistry,
} from "./native-callbacks";
import { handleDiscordNativeInteraction } from "./native-interaction-handler";
import {
  type DiscordNativeCallback,
  type DiscordNativeInteraction,
  DiscordNativeQuestionnaireMessage,
} from "./native-questionnaire";

const binding: DiscordCallbackBinding = {
  channelAddressed: true,
  channelChatId: "room",
  channelId: "room",
  channelOrgKey: "org-room",
  channelUserId: "sender",
  conversationKey: "conversation",
  guildId: "guild",
  orgId: "org",
  profileId: "profile",
  sessionId: "session",
};

function fixture() {
  const payloads: DiscordComponentMessage[] = [];
  const answers: string[] = [];
  const registry = new DiscordCallbackRegistry<DiscordNativeCallback>();
  let current = "q";
  const messenger: DiscordMessenger = {
    edit: async () => {},
    editComponents: async (_id, payload) => {
      payloads.push(payload);
    },
    send: async () => ({ id: "message" }),
    sendComponents: async (payload) => {
      payloads.push(payload);
      return { id: "message" };
    },
    sendTyping: async () => {},
  };
  const questionnaire = new DiscordNativeQuestionnaireMessage({
    binding,
    isCurrent: (id) => current === id,
    messenger,
    onAnswer: async (answer) => {
      answers.push(answer);
    },
    registry,
  });
  return {
    answers,
    expire: () => {
      current = "new-questionnaire";
    },
    messenger,
    payloads,
    questionnaire,
    registry,
  };
}

function components(payload: DiscordComponentMessage) {
  return JSON.parse(JSON.stringify(payload.components)) as {
    components: {
      custom_id: string;
      label?: string;
      type: number;
      options?: { label: string; value: string }[];
    }[];
  }[];
}

function interaction(
  customId: string,
  options: {
    kind?: "button" | "select" | "modal";
    values?: string[];
    sender?: string;
    messageId?: string;
    answer?: string;
  } = {}
) {
  const responses: unknown[] = [];
  const modals: unknown[] = [];
  const value = {
    channelId: "room",
    customId,
    async deferReply(payload: unknown) {
      value.deferred = true;
      responses.push(payload);
    },
    deferred: false,
    async editReply(payload: unknown) {
      responses.push(payload);
    },
    fields: { getTextInputValue: () => options.answer ?? "custom answer" },
    guildId: "guild",
    isButton: () => (options.kind ?? "button") === "button",
    isModalSubmit: () => options.kind === "modal",
    isStringSelectMenu: () => options.kind === "select",
    message: { id: options.messageId ?? "message" },
    replied: false,
    async reply(payload: unknown) {
      value.replied = true;
      responses.push(payload);
    },
    async showModal(payload: unknown) {
      value.replied = true;
      modals.push(JSON.parse(JSON.stringify(payload)));
    },
    user: { id: options.sender ?? "sender" },
    values: options.values ?? [],
  };
  return {
    interaction: value as unknown as DiscordNativeInteraction,
    modals,
    responses,
  };
}

async function click(
  fixtureValue: ReturnType<typeof fixture>,
  input: ReturnType<typeof interaction>,
  authorize = async (_binding: DiscordCallbackBinding) => {}
) {
  return await handleDiscordNativeInteraction({
    authorize,
    interaction: input.interaction,
    registry: fixtureValue.registry,
  });
}

const question: AgentQuestionnaire = {
  id: "q",
  questions: [
    {
      allowCustomAnswer: true,
      choices: [
        { id: "a", label: "Alpha" },
        { id: "b", label: "Beta" },
      ],
      id: "q1",
      prompt: "Which option?",
    },
  ],
  title: "Choose",
};

test("native button uses stored answer and submits once after current authorization", async () => {
  const state = fixture();
  await state.questionnaire.update(question);
  const button = components(state.payloads[0]!)[0]!.components[0]!;
  let authorizations = 0;
  const authorize = async (actual: DiscordCallbackBinding) => {
    authorizations += 1;
    expect(actual).toEqual(binding);
  };
  await click(state, interaction(button.custom_id), authorize);
  await click(state, interaction(button.custom_id), authorize);
  expect(authorizations).toBe(1);
  expect(state.answers).toHaveLength(1);
  expect(state.answers[0]).toContain("A: Alpha");
  expect(state.payloads.at(-1)?.components).toEqual([]);
});

test("foreign sender, message, stale questionnaire and revoked role cannot answer", async () => {
  for (const failure of ["sender", "message", "stale", "role"] as const) {
    const state = fixture();
    await state.questionnaire.update(question);
    const id = components(state.payloads[0]!)[0]!.components[0]!.custom_id;
    if (failure === "stale") {
      state.expire();
    }
    let authorizations = 0;
    await click(
      state,
      interaction(id, {
        messageId: failure === "message" ? "foreign" : undefined,
        sender: failure === "sender" ? "foreign" : undefined,
      }),
      async () => {
        authorizations += 1;
        if (failure === "role") {
          throw new Error("revoked");
        }
      }
    );
    expect(state.answers).toHaveLength(0);
    expect(authorizations).toBe(
      failure === "sender" || failure === "message" ? 0 : 1
    );
  }
});

test("native select pagination supports more than twenty-five choices and rejects forged selection", async () => {
  const state = fixture();
  const choices = Array.from({ length: 31 }, (_, index) => ({
    id: String(index),
    label: `Choice ${index}`,
  }));
  await state.questionnaire.update({
    ...question,
    questions: [{ ...question.questions[0]!, choices }],
  });
  const initial = components(state.payloads[0]!);
  expect(initial[0]!.components[0]!.options).toHaveLength(25);
  await click(state, interaction(initial[1]!.components[0]!.custom_id));
  const next = components(state.payloads.at(-1)!);
  expect(next[0]!.components[0]!.options).toHaveLength(6);
  await click(
    state,
    interaction(next[0]!.components[0]!.custom_id, {
      kind: "select",
      values: ["5"],
    })
  );
  expect(state.answers[0]).toContain("Choice 30");
  const invalid = fixture();
  await invalid.questionnaire.update({
    ...question,
    questions: [{ ...question.questions[0]!, choices }],
  });
  const id = components(invalid.payloads[0]!)[0]!.components[0]!.custom_id;
  await click(invalid, interaction(id, { kind: "select", values: ["999"] }));
  expect(invalid.answers).toHaveLength(0);
});

test("modal must originate from the bound message and retains custom text", async () => {
  const state = fixture();
  await state.questionnaire.update(question);
  const id = components(state.payloads[0]!)[1]!.components[0]!.custom_id;
  const opened = interaction(id);
  await click(state, opened);
  expect(opened.interaction.deferred).toBe(false);
  const modalId = (opened.modals[0] as { custom_id: string }).custom_id;
  await click(
    state,
    interaction(modalId, { kind: "modal", messageId: "foreign" })
  );
  expect(state.answers).toHaveLength(0);
  await click(
    state,
    interaction(modalId, { answer: "A custom preference", kind: "modal" })
  );
  expect(state.answers[0]).toContain("A custom preference");
});

test("multiple questions submit together only after every answer", async () => {
  const state = fixture();
  await state.questionnaire.update({
    ...question,
    questions: [
      question.questions[0]!,
      { ...question.questions[0]!, id: "q2", prompt: "Second?" },
    ],
  });
  await click(
    state,
    interaction(components(state.payloads.at(-1)!)[0]!.components[0]!.custom_id)
  );
  expect(state.answers).toHaveLength(0);
  await click(
    state,
    interaction(components(state.payloads.at(-1)!)[0]!.components[1]!.custom_id)
  );
  expect(state.answers[0]).toContain("Q: Second?\nA: Beta");
});

test("native approve and deny race permits one exact pending decision", async () => {
  const state = fixture();
  const decisions: string[] = [];
  const approval: ApprovalRequest = {
    consequenceSummary: "Modify a file",
    createdAt: new Date().toISOString(),
    id: "approval-a",
    status: "pending",
    title: "Approve file edit",
    tool: "write_file",
    toolCallId: "call-a",
  };
  await sendDiscordNativeApproval({
    approval,
    binding,
    decide: async (decision) => {
      decisions.push(decision);
    },
    messenger: state.messenger,
    registry: state.registry,
  });
  const buttons = components(state.payloads[0]!)[0]!.components;
  await Promise.all(
    buttons.map((button) => click(state, interaction(button.custom_id)))
  );
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toBe("approved");
  expect(state.payloads.at(-1)?.components).toEqual([]);
});

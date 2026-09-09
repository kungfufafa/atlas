import { expect, test } from "bun:test";
import type { AgentQuestionnaire } from "@atlas/core/contract";
import type { DiscordComponentMessage, DiscordMessenger } from "./messenger";
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
const question: AgentQuestionnaire = {
  id: "multiple-questionnaire",
  questions: [
    {
      allowCustomAnswer: true,
      choices: Array.from({ length: 5 }, (_, index) => ({
        id: `choice-${index}`,
        label: `Destination ${index}: ${"full descriptive label ".repeat(6).trim()}`,
      })),
      id: "destinations",
      prompt: "Which destinations?",
      selectionMode: "multiple",
    },
  ],
  title: "Choose destinations",
};
type Component = {
  type: number;
  custom_id: string;
  min_values?: number;
  max_values?: number;
  options?: Array<{ value: string; label: string }>;
};
function fixture() {
  const payloads: DiscordComponentMessage[] = [];
  const submitted: Array<{ message: string; snapshot: AgentQuestionnaire }> =
    [];
  const authorizedSnapshots: Array<AgentQuestionnaire | undefined> = [];
  const registry = new DiscordCallbackRegistry<DiscordNativeCallback>();
  let current = true;
  let allowed = true;
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
  const view = new DiscordNativeQuestionnaireMessage({
    binding,
    isCurrent: (id) => current && id === question.id,
    messenger,
    onAnswer: async (message, snapshot) => {
      submitted.push({ message, snapshot });
    },
    registry,
  });
  async function invoke(
    customId: string,
    options: {
      values?: string[];
      sender?: string;
      kind?: "select" | "button" | "modal";
      text?: string;
    } = {}
  ) {
    const modals: Array<{ custom_id: string }> = [];
    const interaction = {
      channelId: binding.channelId,
      customId,
      deferReply: async () => {
        interaction.deferred = true;
      },
      deferred: false,
      editReply: async () => {},
      fields: { getTextInputValue: () => options.text ?? "" },
      guildId: binding.guildId,
      isButton: () => options.kind === "button",
      isModalSubmit: () => options.kind === "modal",
      isStringSelectMenu: () => (options.kind ?? "select") === "select",
      message: { id: "message" },
      replied: false,
      reply: async () => {
        interaction.replied = true;
      },
      showModal: async (modal: unknown) => {
        modals.push(JSON.parse(JSON.stringify(modal)));
        interaction.replied = true;
      },
      user: { id: options.sender ?? binding.channelUserId },
      values: options.values ?? [],
    };
    await handleDiscordNativeInteraction({
      authorize: async (actor, callback) => {
        expect(actor).toEqual(binding);
        authorizedSnapshots.push(callback.questionnaireSnapshot);
        if (!allowed) {
          throw new Error("Current workspace membership revoked");
        }
      },
      interaction: interaction as unknown as DiscordNativeInteraction,
      registry,
    });
    return modals;
  }
  const components = () =>
    JSON.parse(JSON.stringify(payloads.at(-1)?.components)) as Array<{
      components: Component[];
    }>;
  return {
    authorizedSnapshots,
    components,
    invoke,
    payloads,
    replace: () => {
      current = false;
    },
    revoke: () => {
      allowed = false;
    },
    submitted,
    view,
  };
}

test("multiple native select accepts two choices, preserves full labels and snapshot, and consumes concurrent replay once", async () => {
  const f = fixture();
  await f.view.update(question);
  const select = f.components()[0]!.components[0]!;
  expect(select.type).toBe(3);
  expect(select.min_values).toBe(1);
  expect(select.max_values).toBe(5);
  expect(select.options?.map((option) => option.label.length)).toEqual([
    100, 100, 100, 100, 100,
  ]);
  await Promise.all([
    f.invoke(select.custom_id, { values: ["3", "1"] }),
    f.invoke(select.custom_id, { values: ["3", "1"] }),
  ]);
  expect(f.submitted).toEqual([
    {
      message: `Answers\n\nQ: Which destinations?\nA: ${question.questions[0]!.choices[1]!.label}, ${question.questions[0]!.choices[3]!.label}`,
      snapshot: question,
    },
  ]);
  expect(f.authorizedSnapshots).toEqual([question]);
});
for (const values of [
  [],
  ["1", "1"],
  ["1", "9"],
  ["-1"],
  ["01"],
  ["0", "1", "2", "3", "4", "5"],
]) {
  test(`native multi select denies malformed selection ${JSON.stringify(values)} without submitting`, async () => {
    const f = fixture();
    await f.view.update(question);
    const select = f.components()[0]!.components[0]!;
    await f.invoke(select.custom_id, { values });
    await f.invoke(select.custom_id, { values: ["0", "1"] });
    expect(f.submitted).toEqual([]);
    expect(f.authorizedSnapshots).toHaveLength(1);
  });
}
test("foreign sender cannot consume a multi-select ticket or submit answers", async () => {
  const f = fixture();
  await f.view.update(question);
  const select = f.components()[0]!.components[0]!;
  await f.invoke(select.custom_id, { sender: "foreign", values: ["0", "1"] });
  expect(f.submitted).toEqual([]);
  expect(f.authorizedSnapshots).toEqual([]);
  await f.invoke(select.custom_id, { values: ["0", "1"] });
  expect(f.submitted).toHaveLength(1);
  expect(f.submitted[0]!.snapshot).toEqual(question);
});
for (const boundary of ["membership", "replacement"] as const) {
  test(`current ${boundary} denial prevents a native multiple answer`, async () => {
    const f = fixture();
    await f.view.update(question);
    const select = f.components()[0]!.components[0]!;
    if (boundary === "membership") {
      f.revoke();
    } else {
      f.replace();
    }
    await f.invoke(select.custom_id, { values: ["0", "1"] });
    expect(f.submitted).toEqual([]);
  });
}
test("multiple question retains the custom-answer modal and its original full snapshot", async () => {
  const f = fixture();
  await f.view.update(question);
  const originalSelect = f.components()[0]!.components[0]!;
  const custom = f.components()[1]!.components[0]!;
  const modals = await f.invoke(custom.custom_id, { kind: "button" });
  expect(modals).toHaveLength(1);
  await f.invoke(modals[0]!.custom_id, {
    kind: "modal",
    text: "Both destinations, subject to the review team's approval.",
  });
  await f.invoke(originalSelect.custom_id, { values: ["0", "1"] });
  expect(f.submitted).toEqual([
    {
      message:
        "Answers\n\nQ: Which destinations?\nA: Both destinations, subject to the review team's approval.",
      snapshot: question,
    },
  ]);
});
test("single-choice questions retain native buttons", async () => {
  const f = fixture();
  const single = structuredClone(question);
  single.questions[0]!.selectionMode = "single";
  await f.view.update(single);
  expect(f.components()[0]!.components.map((c) => c.type)).toEqual([
    2, 2, 2, 2, 2,
  ]);
  await f.invoke(f.components()[0]!.components[2]!.custom_id, {
    kind: "button",
  });
  expect(f.submitted[0]!.message).toContain(
    question.questions[0]!.choices[2]!.label
  );
  expect(f.submitted[0]!.snapshot).toEqual(single);
});
test("unsupported multi-selection beyond 25 choices is rejected before rendering a partial or single-choice control", async () => {
  const f = fixture();
  const oversized = structuredClone(question);
  oversized.questions[0]!.choices = Array.from({ length: 26 }, (_, index) => ({
    id: String(index),
    label: `Choice ${index}`,
  }));
  await expect(f.view.update(oversized)).rejects.toThrow();
  expect(f.payloads).toEqual([]);
  expect(f.submitted).toEqual([]);
  expect(f.view.getActive()).toBeNull();
});

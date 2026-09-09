import { randomBytes } from "node:crypto";
import type {
  AgentQuestionAnswer,
  AgentQuestionnaire,
  ApprovalRequest,
} from "@atlas/core/contract";
import type { Context } from "grammy";

const CALLBACK_PATTERN =
  /^atlas:([a-f0-9]{24}):(\d+):(choose|submit|approve|deny)(?::(\d+):(\d+))?$/;
const CONTROL_TTL_MS = 15 * 60 * 1000;
const MAX_CARDS = 1000;

export interface TelegramControlBinding {
  addressed: boolean;
  channelOrgKey: string;
  channelUserId: string;
  chatId: number;
  isGroup: boolean;
  orgId: string;
  profileId: string;
  sessionId: string;
  sessionKey: string;
  threadId?: number;
}

interface KeyboardButton {
  callback_data: string;
  text: string;
}

type Card = {
  binding: TelegramControlBinding;
  busy: boolean;
  expiresAt: number;
  id: string;
  messageId: number;
  revision: number;
} & (
  | {
      kind: "questionnaire";
      questionnaire: AgentQuestionnaire;
      selected: Map<string, Set<number>>;
      submit: (answers: AgentQuestionAnswer[]) => Promise<void>;
    }
  | {
      approval: ApprovalRequest;
      decide: (decision: "approved" | "denied") => Promise<void>;
      kind: "approval";
    }
);

export class TelegramNativeControls {
  private readonly cards = new Map<string, Card>();

  constructor(
    private readonly authorize: (
      binding: TelegramControlBinding,
      kind: Card["kind"],
      questionnaire?: AgentQuestionnaire
    ) => Promise<void>,
    private readonly now: () => number = Date.now
  ) {}

  async questionnaire(input: {
    binding: TelegramControlBinding;
    ctx: Context;
    questionnaire: AgentQuestionnaire;
    submit: (answers: AgentQuestionAnswer[]) => Promise<void>;
  }): Promise<void> {
    const questions = input.questionnaire.questions;
    if (
      questions.length === 0 ||
      questions.length > 5 ||
      questions.some((question) => question.choices.length > 12)
    ) {
      throw new Error(
        "This questionnaire exceeds Telegram's native control limits."
      );
    }
    this.invalidate(input.binding.sessionKey, "questionnaire");
    await this.publish(input.ctx, {
      ...this.newCard(input.binding),
      kind: "questionnaire",
      questionnaire: structuredClone(input.questionnaire),
      selected: new Map(),
      submit: input.submit,
    });
  }

  async approval(input: {
    approval: ApprovalRequest;
    binding: TelegramControlBinding;
    ctx: Context;
    decide: (decision: "approved" | "denied") => Promise<void>;
  }): Promise<void> {
    if (input.approval.status !== "pending") {
      return;
    }
    await this.publish(input.ctx, {
      ...this.newCard(input.binding),
      approval: structuredClone(input.approval),
      decide: input.decide,
      kind: "approval",
    });
  }

  invalidate(sessionKey: string, kind?: Card["kind"]): void {
    for (const [id, card] of this.cards) {
      if (
        card.binding.sessionKey === sessionKey &&
        (!kind || card.kind === kind)
      ) {
        this.cards.delete(id);
      }
    }
  }

  async resolveApproval(
    ctx: Context,
    sessionKey: string,
    approvalId: string
  ): Promise<void> {
    for (const [id, card] of this.cards) {
      if (
        card.kind === "approval" &&
        card.binding.sessionKey === sessionKey &&
        card.approval.id === approvalId
      ) {
        this.cards.delete(id);
        await this.disable(ctx, card, "Approval resolved.");
      }
    }
  }

  async handleCallback(ctx: Context): Promise<void> {
    const query = ctx.callbackQuery;
    const match =
      typeof query?.data === "string"
        ? CALLBACK_PATTERN.exec(query.data)
        : null;
    const card = match ? this.cards.get(match[1]!) : undefined;
    const message = query?.message;
    if (
      !(match && card && message) ||
      card.busy ||
      card.expiresAt <= this.now() ||
      card.revision !== Number(match[2]) ||
      String(query.from.id) !== card.binding.channelUserId ||
      message.chat.id !== card.binding.chatId ||
      message.message_id !== card.messageId ||
      ("message_thread_id" in message
        ? message.message_thread_id
        : undefined) !== card.binding.threadId
    ) {
      await this.acknowledge(
        ctx,
        "This control is unavailable for this message or sender."
      );
      return;
    }
    card.busy = true;
    try {
      await this.authorize(
        card.binding,
        card.kind,
        card.kind === "questionnaire" ? card.questionnaire : undefined
      );
      if (this.cards.get(card.id) !== card || card.expiresAt <= this.now()) {
        throw new Error("This control has expired.");
      }
      const action = match[3];
      if (card.kind === "approval") {
        if (action !== "approve" && action !== "deny") {
          throw new Error("Invalid approval action.");
        }
        // Consume before the decision: an uncertain remote result must never retry it.
        this.cards.delete(card.id);
        await this.acknowledge(ctx, "Processing decision.");
        await card.decide(action === "approve" ? "approved" : "denied");
        await this.disable(
          ctx,
          card,
          action === "approve" ? "Approved." : "Denied."
        );
        return;
      }
      if (action === "choose") {
        const questionIndex = Number(match[4]);
        const choiceIndex = Number(match[5]);
        const question = card.questionnaire.questions[questionIndex];
        if (!question?.choices[choiceIndex]) {
          throw new Error("Invalid questionnaire choice.");
        }
        const selected = card.selected.get(question.id) ?? new Set<number>();
        const multiple =
          (question as typeof question & { selectionMode?: string })
            .selectionMode === "multiple";
        if (!multiple) {
          selected.clear();
          selected.add(choiceIndex);
        } else if (!selected.delete(choiceIndex)) {
          selected.add(choiceIndex);
        }
        card.selected.set(question.id, selected);
        card.revision += 1;
        await this.acknowledge(ctx, "Selection updated.");
        await this.render(ctx, card);
        return;
      }
      if (action !== "submit") {
        throw new Error("Invalid questionnaire action.");
      }
      const answers = card.questionnaire.questions.map((question) => {
        const selected = [...(card.selected.get(question.id) ?? [])].sort(
          (a, b) => a - b
        );
        if (selected.length === 0) {
          throw new Error(
            "Choose an answer for every question, or reply in chat."
          );
        }
        return {
          answer: selected
            .map((index) => question.choices[index]!.label)
            .join(", "),
          prompt: question.prompt,
          questionId: question.id,
        };
      });
      this.cards.delete(card.id);
      await this.acknowledge(ctx, "Answers submitted.");
      await this.disable(ctx, card, "Answers submitted.");
      await card.submit(answers);
    } catch (error) {
      await this.acknowledge(
        ctx,
        "Unable to use this control. Check the current conversation."
      );
      if (!this.cards.has(card.id)) {
        // Delivery/decision may have reached the server. Do not offer a retry button.
        await this.disable(
          ctx,
          card,
          "Control consumed. Check the conversation for its outcome."
        );
      }
      throw error;
    } finally {
      card.busy = false;
    }
  }

  private newCard(binding: TelegramControlBinding) {
    for (const [id, card] of this.cards) {
      if (card.expiresAt <= this.now()) {
        this.cards.delete(id);
      }
    }
    if (this.cards.size >= MAX_CARDS) {
      throw new Error(
        "Telegram has too many pending controls. Reply in chat instead."
      );
    }
    return {
      binding: { ...binding },
      busy: false,
      expiresAt: this.now() + CONTROL_TTL_MS,
      id: randomBytes(12).toString("hex"),
      messageId: 0,
      revision: 0,
    };
  }

  private async publish(ctx: Context, card: Card): Promise<void> {
    await this.authorize(
      card.binding,
      card.kind,
      card.kind === "questionnaire" ? card.questionnaire : undefined
    );
    const sent = await ctx.api.sendMessage(
      card.binding.chatId,
      this.text(card),
      {
        ...(card.binding.threadId && card.binding.threadId !== 1
          ? { message_thread_id: card.binding.threadId }
          : {}),
        reply_markup: { inline_keyboard: this.keyboard(card) },
      }
    );
    if (!Number.isInteger(sent.message_id) || sent.message_id <= 0) {
      throw new Error("Telegram did not acknowledge the control message.");
    }
    card.messageId = sent.message_id;
    this.cards.set(card.id, card);
  }

  private keyboard(card: Card): KeyboardButton[][] {
    const callback = (action: string) =>
      `atlas:${card.id}:${card.revision}:${action}`;
    if (card.kind === "approval") {
      return [
        [
          { callback_data: callback("approve"), text: "Approve" },
          { callback_data: callback("deny"), text: "Deny" },
        ],
      ];
    }
    return [
      ...card.questionnaire.questions.flatMap((question, questionIndex) =>
        question.choices.map((choice, choiceIndex) => [
          {
            callback_data: callback(`choose:${questionIndex}:${choiceIndex}`),
            text: `${card.selected.get(question.id)?.has(choiceIndex) ? "✓ " : ""}${questionIndex + 1}. ${choice.label}`.slice(
              0,
              80
            ),
          },
        ])
      ),
      [{ callback_data: callback("submit"), text: "Submit answers" }],
    ];
  }

  private text(card: Card): string {
    if (card.kind === "approval") {
      return `${card.approval.title}\n\n${card.approval.consequenceSummary}`.slice(
        0,
        4000
      );
    }
    return [
      card.questionnaire.title,
      ...card.questionnaire.questions.map(
        (question, index) => `${index + 1}. ${question.prompt}`
      ),
      "Choose answers below and submit, or reply in chat.",
    ]
      .join("\n\n")
      .slice(0, 4000);
  }

  private async render(ctx: Context, card: Card): Promise<void> {
    await ctx.api.editMessageReplyMarkup(card.binding.chatId, card.messageId, {
      reply_markup: { inline_keyboard: this.keyboard(card) },
    });
  }

  private async disable(ctx: Context, card: Card, text: string): Promise<void> {
    await ctx.api
      .editMessageText(card.binding.chatId, card.messageId, text, {
        reply_markup: { inline_keyboard: [] },
      })
      .catch(() => undefined);
  }

  private async acknowledge(ctx: Context, text: string): Promise<void> {
    await ctx.answerCallbackQuery({ text }).catch(() => undefined);
  }
}

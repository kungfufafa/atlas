import {
  formatAgentQuestionnaireAnswersMessage,
  formatAgentQuestionnaireMessage,
} from "@atlas/core/agent-questionnaire";
import { CHAT_TOOL_APPROVAL_TIMEOUT_MS } from "@atlas/core/chat-tool-approval-timeout";
import type { AgentQuestionnaire, ApprovalRequest } from "@atlas/core/contract";
import { normalizeWhatsAppUserJid } from "@atlas/core/whatsapp-config";
import type { WAMessageKey, WASocket } from "@whiskeysockets/baileys";
import type { WhatsAppAccount } from "./group-message";
import { isPrivateWhatsAppChat } from "./inbound-message";

const CHOICES = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"];
const QUESTIONNAIRE_TTL_MS = 10 * 60_000;

export function isWhatsAppApprovalDecisionEmoji(emoji: string): boolean {
  return emoji === "✅" || emoji === "❌";
}

export interface WhatsAppNativeBinding {
  channelUserAliases: string[];
  channelUserId: string;
  destination: string;
  orgId: string;
  profileId: string;
  sessionId: string;
  userId: string;
}

export interface WhatsAppNativeReaction {
  actorAliases: string[];
  actorId: string;
  destination: string;
  emoji: string;
  eventId: string;
  target: WAMessageKey;
}

interface ControlCard {
  binding: WhatsAppNativeBinding;
  choose: (emoji: string) => Promise<boolean>;
  expiresAt: number;
  key: WAMessageKey;
  questionnaire?: boolean;
  used: boolean;
}

export class WhatsAppNativeControls {
  private readonly cards = new Map<string, ControlCard>();
  private readonly events = new Set<string>();
  private readonly issued = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  async approval(input: {
    approval: ApprovalRequest;
    binding: WhatsAppNativeBinding;
    decide: (
      decision: "approved" | "denied",
      reaction: WhatsAppNativeReaction
    ) => Promise<void>;
    socket: WASocket;
  }): Promise<void> {
    // The card must remain usable throughout the server's decision window.
    // Dispatch still validates the current live approval on the server.
    const expiresAt = this.now() + CHAT_TOOL_APPROVAL_TIMEOUT_MS;
    if (
      input.approval.status !== "pending" ||
      !this.issue(input.binding, `approval:${input.approval.id}`, expiresAt)
    ) {
      return;
    }
    const message = await input.socket.sendMessage(input.binding.destination, {
      text: `${input.approval.title}\n\n${input.approval.consequenceSummary}\n\nReact ✅ to approve or ❌ to deny.`,
    });
    if (!message?.key) {
      return;
    }
    const card = this.add(
      input.binding,
      message.key,
      async (emoji) => isWhatsAppApprovalDecisionEmoji(emoji),
      expiresAt
    );
    if (card) {
      this.decisions.set(card, async (reaction) =>
        input.decide(reaction.emoji === "✅" ? "approved" : "denied", reaction)
      );
    }
  }

  private readonly decisions = new WeakMap<
    ControlCard,
    (reaction: WhatsAppNativeReaction) => Promise<void>
  >();

  async questionnaire(input: {
    binding: WhatsAppNativeBinding;
    questionnaire: AgentQuestionnaire;
    answer: (text: string, reaction: WhatsAppNativeReaction) => Promise<void>;
    socket: WASocket;
  }): Promise<void> {
    if (!this.issue(input.binding, `questionnaire:${input.questionnaire.id}`)) {
      return;
    }
    this.clearQuestionnaire(input.binding);
    const questionnaire = structuredClone(input.questionnaire);
    if (
      questionnaire.questions.some(
        (question) => question.selectionMode === "multiple"
      )
    ) {
      await input.socket.sendMessage(input.binding.destination, {
        text: `${formatAgentQuestionnaireMessage(questionnaire)}\n\nThis questionnaire allows multiple choices. Type all your selections in chat; reactions will not submit answers.`,
      });
      return;
    }
    const answers = new Map<string, string>();
    let submitted = false;
    for (const question of questionnaire.questions) {
      const choices = question.choices.slice(0, CHOICES.length);
      const text = [
        questionnaire.title,
        question.prompt,
        ...choices.map((choice, index) => `${CHOICES[index]} ${choice.label}`),
        question.allowCustomAnswer || question.choices.length > CHOICES.length
          ? "React to choose, or reply in chat with your answer."
          : "React with the number of your choice.",
      ].join("\n\n");
      const message = await input.socket.sendMessage(
        input.binding.destination,
        { text }
      );
      if (!message?.key) {
        continue;
      }
      const card = this.add(input.binding, message.key, async (emoji) => {
        const selected = choices[CHOICES.indexOf(emoji)];
        if (!selected || submitted) {
          return false;
        }
        answers.set(question.id, selected.label);
        return true;
      });
      if (!card) {
        continue;
      }
      card.questionnaire = true;
      this.decisions.set(card, async (reaction) => {
        if (submitted || answers.size !== questionnaire.questions.length) {
          return;
        }
        submitted = true;
        await input.answer(
          formatAgentQuestionnaireAnswersMessage(
            questionnaire.questions.map((item) => ({
              answer: answers.get(item.id)!,
              prompt: item.prompt,
              questionId: item.id,
            }))
          ),
          reaction
        );
      });
    }
  }

  clearQuestionnaire(binding: WhatsAppNativeBinding): void {
    for (const [id, card] of this.cards) {
      if (
        card.questionnaire &&
        card.binding.orgId === binding.orgId &&
        card.binding.sessionId === binding.sessionId &&
        card.binding.destination ===
          normalizeWhatsAppUserJid(binding.destination)
      ) {
        this.cards.delete(id);
      }
    }
  }

  private issue(
    binding: WhatsAppNativeBinding,
    id: string,
    expiresAt = this.now() + QUESTIONNAIRE_TTL_MS
  ): boolean {
    this.prune();
    const key = JSON.stringify([
      binding.orgId,
      binding.sessionId,
      binding.destination,
      id,
    ]);
    if (this.issued.has(key) || this.issued.size >= 1000) {
      return false;
    }
    this.issued.set(key, expiresAt);
    return true;
  }

  async react(
    reaction: WhatsAppNativeReaction,
    authorize: (
      binding: WhatsAppNativeBinding,
      reaction: WhatsAppNativeReaction
    ) => Promise<{ userId: string }>
  ): Promise<boolean> {
    this.prune();
    const card = this.cards.get(
      this.key(reaction.destination, reaction.target.id ?? "")
    );
    if (
      !card ||
      card.used ||
      !reaction.eventId ||
      this.events.has(reaction.eventId) ||
      reaction.target.fromMe !== true ||
      normalizeWhatsAppUserJid(reaction.target.participant ?? "") !==
        normalizeWhatsAppUserJid(card.key.participant ?? "") ||
      normalizeWhatsAppUserJid(reaction.target.remoteJid ?? "") !==
        card.binding.destination
    ) {
      return false;
    }
    // Claim before crossing an asynchronous authorization boundary. Unknown
    // decision outcomes must never be repeated automatically.
    card.used = true;
    try {
      const principal = await authorize(card.binding, reaction);
      if (
        principal.userId !== card.binding.userId ||
        card.expiresAt <= this.now()
      ) {
        card.used = false;
        return false;
      }
      if (!(await card.choose(reaction.emoji))) {
        card.used = false;
        return false;
      }
      this.events.add(reaction.eventId);
      await this.decisions.get(card)?.(reaction);
      return true;
    } catch (error) {
      // A failed admission can be retried with a different authorized actor;
      // a decision already dispatched remains consumed even on a lost reply.
      if (!this.events.has(reaction.eventId)) {
        card.used = false;
      }
      throw error;
    }
  }

  private add(
    binding: WhatsAppNativeBinding,
    key: WAMessageKey,
    choose: ControlCard["choose"],
    expiresAt = this.now() + QUESTIONNAIRE_TTL_MS
  ): ControlCard | undefined {
    this.prune();
    if (
      !key.id ||
      key.fromMe !== true ||
      normalizeWhatsAppUserJid(key.remoteJid ?? "") !==
        normalizeWhatsAppUserJid(binding.destination)
    ) {
      return;
    }
    if (this.cards.size >= 1000) {
      return;
    }
    const card: ControlCard = {
      binding: {
        ...binding,
        destination: normalizeWhatsAppUserJid(binding.destination),
      },
      choose,
      expiresAt,
      key: { ...key },
      used: false,
    };
    this.cards.set(this.key(binding.destination, key.id), card);
    return card;
  }

  private prune(): void {
    for (const [id, expiresAt] of this.issued) {
      if (expiresAt <= this.now()) {
        this.issued.delete(id);
      }
    }
    for (const [id, card] of this.cards) {
      if (card.expiresAt <= this.now()) {
        this.cards.delete(id);
      }
    }
    if (this.events.size > 2000) {
      this.events.clear();
    }
  }

  private key(destination: string, id: string): string {
    return JSON.stringify([normalizeWhatsAppUserJid(destination), id]);
  }
}

/** Baileys reaction.key is the actor's message key; event.key is the reacted
 * message key. Swapping the two would authorize the bot instead of the actor. */
export function parseWhatsAppNativeReaction(
  input: {
    key: WAMessageKey;
    reaction: { key?: WAMessageKey | null; text?: string | null };
  },
  me?: WhatsAppAccount
): WhatsAppNativeReaction | null {
  const actor = input.reaction.key;
  const destination = normalizeWhatsAppUserJid(input.key.remoteJid ?? "");
  if (
    !(destination && actor?.id) ||
    (actor.fromMe &&
      ![me?.id, me?.lid].some(
        (jid) => jid && normalizeWhatsAppUserJid(jid) === destination
      )) ||
    input.key.fromMe !== true ||
    normalizeWhatsAppUserJid(actor.remoteJid ?? "") !== destination ||
    !input.reaction.text
  ) {
    return null;
  }
  const actorId = normalizeWhatsAppUserJid(
    destination.endsWith("@g.us")
      ? (actor.participant ?? "")
      : (actor.remoteJid ?? "")
  );
  if (!isPrivateWhatsAppChat(actorId)) {
    return null;
  }
  const hints = actor as WAMessageKey & {
    participantPn?: string;
    participantLid?: string;
    senderPn?: string;
    senderLid?: string;
  };
  const aliases = [
    actor.fromMe ? me?.id : undefined,
    actor.fromMe ? me?.lid : undefined,
    hints.participantPn,
    hints.participantLid,
    hints.senderPn,
    hints.senderLid,
  ]
    .filter((value): value is string =>
      Boolean(value && isPrivateWhatsAppChat(value))
    )
    .map(normalizeWhatsAppUserJid);
  return {
    actorAliases: [...new Set(aliases)].filter((value) => value !== actorId),
    actorId,
    destination,
    emoji: input.reaction.text,
    eventId: JSON.stringify([destination, actorId, actor.id]),
    target: input.key,
  };
}

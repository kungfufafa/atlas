import { normalizeWhatsAppUserJid } from "@atlas/core/whatsapp-config";
import { isWhatsAppChatControlCandidate } from "./commands";
import {
  BoundedWorkQueue,
  type BoundedWorkQueueOptions,
} from "./inbound-work-queue";
import { isWhatsAppApprovalDecisionEmoji } from "./native-controls";

const QUEUE_OPTIONS: BoundedWorkQueueOptions = {
  maxConcurrent: 4,
  maxQueued: 100,
  maxWaitMs: 2 * 60 * 1000,
};

/** Keep decisions and cancellation available while chat turns await them. */
export class WhatsAppInboundDispatcher {
  private readonly messages: BoundedWorkQueue;
  private readonly controls: BoundedWorkQueue;

  constructor(options: BoundedWorkQueueOptions = QUEUE_OPTIONS) {
    this.messages = new BoundedWorkQueue(options);
    this.controls = new BoundedWorkQueue(options);
  }

  runMessage<T>(jid: string, text: string, work: () => Promise<T>): Promise<T> {
    if (isWhatsAppChatControlCandidate(text)) {
      return this.controls.run(work, normalizeWhatsAppUserJid(jid));
    }
    return this.messages.run(work, normalizeWhatsAppUserJid(jid));
  }

  runReaction<T>(
    jid: string,
    emoji: string,
    work: () => Promise<T>
  ): Promise<T> {
    // Questionnaire reactions can await an entire new turn. Only approval
    // decision emojis have a short callback; authorization still runs inside it.
    if (isWhatsAppApprovalDecisionEmoji(emoji)) {
      return this.controls.run(work);
    }
    return this.messages.run(work, normalizeWhatsAppUserJid(jid));
  }

  snapshot(): {
    messages: { active: number; queued: number };
    controls: { active: number; queued: number };
  } {
    return {
      controls: this.controls.snapshot(),
      messages: this.messages.snapshot(),
    };
  }
}

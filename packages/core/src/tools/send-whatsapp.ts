import { z } from "zod";
import { createWhatsAppOutboundAdapter } from "../channels/whatsapp-outbound";
import type { ToolContext, ToolDefinition } from "../contract";
import { isChannelGuestUserId } from "../identity/principal";
import { toWhatsAppPhoneJid } from "../whatsapp-config";
import { jsonSchemaFromZod, parseToolInput } from "./schema";

const MAX_WHATSAPP_RECIPIENTS = 50;
const phoneInput = z.string({ error: "to is required." }).trim().min(1);
const sendWhatsAppInputSchema = z
  .object({
    text: z.string({ error: "text is required." }).trim().min(1),
    to: z
      .union([
        phoneInput,
        z.array(phoneInput).min(1).max(MAX_WHATSAPP_RECIPIENTS),
      ])
      .describe(
        "One phone number, or up to 50 numbers receiving the same text in one approval."
      ),
  })
  .strict();

export type SendWhatsAppInput = z.infer<typeof sendWhatsAppInputSchema>;

export interface SendWhatsAppSuccess {
  ok: true;
  to: string;
}

export interface SendWhatsAppFailure {
  error: string;
  ok: false;
}

export type WhatsAppRecipientReceipt =
  | { ok: true; status: "sent"; to: string }
  | {
      error: string;
      ok: false;
      status: "unconfirmed" | "not_sent";
      to: string;
    };

export interface SendWhatsAppBatchResult {
  error?: string;
  ok: boolean;
  results: WhatsAppRecipientReceipt[];
}

export type SendWhatsAppResult =
  | SendWhatsAppFailure
  | SendWhatsAppSuccess
  | SendWhatsAppBatchResult;

type SendWhatsAppMessage = (payload: {
  orgId: string;
  text: string;
  to: string;
}) => Promise<{ error?: string; ok: boolean }>;

/** Validate the entire request before sending; aliases must not duplicate delivery. */
function resolveRecipients(to: string | string[]): string[] | null {
  const recipients = new Map<string, string>();
  for (const candidate of typeof to === "string" ? [to] : to) {
    const jid = toWhatsAppPhoneJid(candidate);
    if (!jid) {
      return null;
    }
    if (!recipients.has(jid)) {
      recipients.set(jid, candidate);
    }
  }
  return [...recipients.values()];
}

async function sendBatch(
  recipients: string[],
  text: string,
  orgId: string,
  context: ToolContext,
  send: SendWhatsAppMessage
): Promise<SendWhatsAppBatchResult> {
  const results: WhatsAppRecipientReceipt[] = [];
  let stopped: string | undefined;
  for (const to of recipients) {
    if (stopped === undefined) {
      try {
        context.signal?.throwIfAborted();
        await context.beforeToolCall?.("send_whatsapp");
        context.signal?.throwIfAborted();
      } catch (error) {
        stopped = error instanceof Error ? error.message : String(error);
      }
    }
    if (stopped !== undefined) {
      results.push({ error: stopped, ok: false, status: "not_sent", to });
      continue;
    }
    try {
      const result = await send({ orgId, text, to });
      results.push(
        result.ok
          ? { ok: true, status: "sent", to }
          : {
              error: result.error ?? "WhatsApp failed to send.",
              ok: false,
              status: "unconfirmed",
              to,
            }
      );
    } catch (error) {
      // A transport failure cannot prove non-delivery. Keep earlier receipts and
      // never retry the whole batch, which would duplicate successful messages.
      results.push({
        error: error instanceof Error ? error.message : String(error),
        ok: false,
        status: "unconfirmed",
        to,
      });
    }
  }
  const ok = results.every((result) => result.ok);
  return {
    ok,
    results,
    ...(ok
      ? {}
      : {
          error:
            "Some recipients were not confirmed. Check per-recipient results; do not resend successful recipients. Verify unconfirmed delivery before retrying.",
        }),
  };
}

export async function runSendWhatsApp(
  input: unknown,
  context: ToolContext,
  send: SendWhatsAppMessage = (payload) =>
    createWhatsAppOutboundAdapter().send(payload)
): Promise<SendWhatsAppResult> {
  if (isChannelGuestUserId(context.userId)) {
    return {
      error: "Channel guest principals cannot send outbound WhatsApp messages.",
      ok: false,
    };
  }
  const parsed = parseToolInput(sendWhatsAppInputSchema, input);
  const orgId = context.orgId?.trim();
  if (!orgId) {
    return {
      error:
        "This workspace has no organization context, so WhatsApp cannot send.",
      ok: false,
    };
  }
  const recipients = resolveRecipients(parsed.to);
  if (!recipients) {
    return {
      error:
        "Every destination must be a WhatsApp phone number (for example 6281234567890). No messages were sent.",
      ok: false,
    };
  }
  if (Array.isArray(parsed.to)) {
    return sendBatch(recipients, parsed.text, orgId, context, send);
  }
  context.signal?.throwIfAborted();
  const result = await send({ orgId, text: parsed.text, to: parsed.to });
  if (!result.ok) {
    return { error: result.error ?? "WhatsApp failed to send.", ok: false };
  }
  return { ok: true, to: parsed.to };
}

export const sendWhatsAppTool: ToolDefinition<
  SendWhatsAppInput,
  SendWhatsAppResult
> = {
  description:
    "Send WhatsApp text from this workspace's paired number. For the same message to multiple people, supply all destination phone numbers in one to array (up to 50), so the user reviews one approval. Returns a receipt for each unique recipient; never resend successful recipients, and verify unconfirmed delivery before retrying. The workspace WhatsApp bridge must be connected. If the workspace uses an allowlist, destinations must be listed under Integrations → WhatsApp.",
  name: "send_whatsapp",
  parameters: jsonSchemaFromZod(sendWhatsAppInputSchema),
  async run(input, context) {
    return runSendWhatsApp(input, context);
  },
};

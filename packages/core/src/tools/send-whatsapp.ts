import { z } from "zod";
import { createWhatsAppOutboundAdapter } from "../channels/whatsapp-outbound";
import type { ToolContext, ToolDefinition } from "../contract";
import { isChannelGuestUserId } from "../identity/principal";
import { toWhatsAppPhoneJid } from "../whatsapp-config";
import { jsonSchemaFromZod, parseToolInput } from "./schema";

const sendWhatsAppInputSchema = z
  .object({
    text: z
      .string({ error: "text is required." })
      .trim()
      .min(1, "text is required."),
    to: z
      .string({ error: "to is required." })
      .trim()
      .min(1, "to is required (WhatsApp phone number)."),
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

export type SendWhatsAppResult = SendWhatsAppFailure | SendWhatsAppSuccess;

export async function runSendWhatsApp(
  input: unknown,
  context: ToolContext,
  send: (payload: {
    orgId: string;
    text: string;
    to: string;
  }) => Promise<{ error?: string; ok: boolean }> = (payload) =>
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

  if (!toWhatsAppPhoneJid(parsed.to)) {
    return {
      error:
        "Need a WhatsApp phone number to send to (for example 6281234567890).",
      ok: false,
    };
  }

  const result = await send({
    orgId,
    text: parsed.text,
    to: parsed.to,
  });

  if (!result.ok) {
    return {
      error: result.error ?? "WhatsApp failed to send.",
      ok: false,
    };
  }

  return { ok: true, to: parsed.to };
}

export const sendWhatsAppTool: ToolDefinition<
  SendWhatsAppInput,
  SendWhatsAppResult
> = {
  description:
    "Send a WhatsApp text from this workspace's paired WhatsApp number to a destination phone number. Use when the user asks to WhatsApp someone (for example 'kirim ke 62895…'). The workspace WhatsApp bridge must be connected. If the workspace uses an allowlist, the destination must be listed under Integrations → WhatsApp.",
  name: "send_whatsapp",
  parameters: jsonSchemaFromZod(sendWhatsAppInputSchema),
  async run(input, context) {
    return runSendWhatsApp(input, context);
  },
};

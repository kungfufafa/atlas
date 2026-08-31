import { loadWhatsAppConfigFile } from "../whatsapp-config";
import {
  assertOutboundEnvelope,
  revalidateOutboundAllowlist,
} from "./outbound-envelope";
import type { ChannelSendResult, WhatsAppOutboundAdapter } from "./types";

const DEFAULT_OUTBOUND_PORT = 4312;
const EPHEMERAL_LISTEN_PORT = 0;

export const WHATSAPP_OUTBOUND_TOKEN_HEADER = "x-atlas-token";

export interface WhatsAppOutboundOptions {
  fetchImpl?: typeof fetch;
}

export function resolveWhatsAppOutboundListenPort(
  config: { outboundPort?: string | null } | null
): number {
  const raw = config?.outboundPort?.trim();

  if (!raw) {
    return EPHEMERAL_LISTEN_PORT;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    return EPHEMERAL_LISTEN_PORT;
  }

  return parsed;
}

export function resolveWhatsAppOutboundPort(
  config: { outboundPort?: string | null } | null
): number {
  const listenPort = resolveWhatsAppOutboundListenPort(config);
  return listenPort > 0 ? listenPort : DEFAULT_OUTBOUND_PORT;
}

export function createWhatsAppOutboundAdapter(
  options: WhatsAppOutboundOptions = {}
): WhatsAppOutboundAdapter {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async send(input): Promise<ChannelSendResult> {
      try {
        const orgId = input.orgId?.trim();
        if (!orgId) {
          return { error: "Outbound envelope orgId is required.", ok: false };
        }

        const config = await loadWhatsAppConfigFile(orgId);

        if (!config?.pairedJid) {
          return { error: "WhatsApp is not paired.", ok: false };
        }

        const to = input.to?.trim() || config.pairedJid;
        const envelope = assertOutboundEnvelope({
          orgId,
          replyTarget: { channel: "whatsapp", whatsapp: { to } },
          text: input.text,
        });
        revalidateOutboundAllowlist(envelope, {
          pairedJid: config.pairedJid,
        });

        const port = resolveWhatsAppOutboundPort(config);
        const payload: { text: string; to?: string } = {
          text: envelope.text,
          to,
        };

        const response = await fetchImpl(`http://127.0.0.1:${port}/send`, {
          body: JSON.stringify(payload),
          headers: {
            "Content-Type": "application/json",
            ...(config.outboundToken
              ? { [WHATSAPP_OUTBOUND_TOKEN_HEADER]: config.outboundToken }
              : {}),
          },
          method: "POST",
        });

        if (!response.ok) {
          const body = await response.text();
          return {
            error: `WhatsApp worker error (${response.status}): ${body.slice(0, 200)}`,
            ok: false,
          };
        }

        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { error: message, ok: false };
      }
    },
  };
}

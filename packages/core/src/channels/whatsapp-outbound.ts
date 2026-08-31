import {
  loadWhatsAppConfigFile,
  resolveWhatsAppOutboundDestination,
} from "../whatsapp-config";
import {
  formatWhatsAppOutboundAuthorization,
  loadOrCreateWhatsAppOutboundAuthToken,
} from "../whatsapp-outbound-auth";
import { assertOutboundEnvelope } from "./outbound-envelope";
import type { ChannelSendResult, WhatsAppOutboundAdapter } from "./types";

const DEFAULT_OUTBOUND_PORT = 4312;
const EPHEMERAL_LISTEN_PORT = 0;
const DEFAULT_OUTBOUND_TIMEOUT_MS = 15_000;

export const WHATSAPP_OUTBOUND_TOKEN_HEADER = "x-atlas-token";

export interface WhatsAppOutboundOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
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
  const timeoutMs = options.timeoutMs ?? DEFAULT_OUTBOUND_TIMEOUT_MS;

  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw new Error("WhatsApp outbound timeout must be greater than zero.");
  }

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

        const destination = resolveWhatsAppOutboundDestination(
          config,
          input.to
        );
        if ("error" in destination) {
          return { error: destination.error, ok: false };
        }

        const envelope = assertOutboundEnvelope({
          orgId,
          replyTarget: {
            channel: "whatsapp",
            whatsapp: { to: destination.jid },
          },
          text: input.text,
        });

        const port = resolveWhatsAppOutboundPort(config);
        const authToken = await loadOrCreateWhatsAppOutboundAuthToken(orgId);
        const payload: { text: string; to?: string } = {
          text: envelope.text,
          to: destination.jid,
        };
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        let response: Response;

        try {
          response = await fetchImpl(`http://127.0.0.1:${port}/send`, {
            body: JSON.stringify(payload),
            headers: {
              Authorization: formatWhatsAppOutboundAuthorization(authToken),
              "Content-Type": "application/json",
              ...(config.outboundToken
                ? { [WHATSAPP_OUTBOUND_TOKEN_HEADER]: config.outboundToken }
                : {}),
            },
            method: "POST",
            signal: controller.signal,
          });
        } catch (error) {
          if (controller.signal.aborted) {
            return {
              error: `WhatsApp worker request timed out after ${timeoutMs}ms.`,
              ok: false,
            };
          }
          throw error;
        } finally {
          clearTimeout(timeout);
        }

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

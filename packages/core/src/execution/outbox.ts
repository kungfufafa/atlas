import {
  assertOutboundEnvelope,
  type ChannelAllowlist,
  type OutboundEnvelope,
  revalidateOutboundAllowlist,
} from "../channels/outbound-envelope";
import {
  assertCanonicalPrincipal,
  type CanonicalPrincipal,
} from "../identity/principal";
import { applyRedactionBoundary } from "../redaction-boundary";

export type OutboxStatus = "queued" | "sending" | "sent" | "failed";

export interface OutboxMessage {
  attempt: number;
  createdAt: string;
  envelope: OutboundEnvelope;
  id: string;
  orgId: string;
  principalUserId: string;
  status: OutboxStatus;
  updatedAt: string;
}

export class OutboxError extends Error {
  readonly code = "OUTBOX";

  constructor(message: string) {
    super(message);
    this.name = "OutboxError";
  }
}

export function enqueueOutbound(input: {
  envelope: Partial<OutboundEnvelope>;
  id: string;
  principal: CanonicalPrincipal;
  now?: string;
}): OutboxMessage {
  const principal = assertCanonicalPrincipal(input.principal);
  const envelope = assertOutboundEnvelope(input.envelope);
  if (envelope.orgId !== principal.orgId) {
    throw new OutboxError("Outbox envelope org must match the principal.");
  }
  const now = input.now ?? new Date().toISOString();
  return {
    attempt: 0,
    createdAt: now,
    envelope: {
      ...envelope,
      text: applyRedactionBoundary(envelope.text, "outbound"),
    },
    id: input.id,
    orgId: principal.orgId,
    principalUserId: principal.userId,
    status: "queued",
    updatedAt: now,
  };
}

export function claimOutboxForSend(
  message: OutboxMessage,
  allowlist: ChannelAllowlist,
  now = new Date().toISOString()
): OutboxMessage {
  if (message.status !== "queued" && message.status !== "failed") {
    throw new OutboxError(`Cannot claim outbox in status ${message.status}.`);
  }
  revalidateOutboundAllowlist(message.envelope, allowlist);
  return {
    ...message,
    attempt: message.attempt + 1,
    status: "sending",
    updatedAt: now,
  };
}

export function completeOutbox(
  message: OutboxMessage,
  status: "sent" | "failed",
  now = new Date().toISOString()
): OutboxMessage {
  if (message.status !== "sending") {
    throw new OutboxError("Only sending outbox messages can complete.");
  }
  return { ...message, status, updatedAt: now };
}

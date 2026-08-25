import { createHash } from "node:crypto";
import {
  assertCanonicalPrincipal,
  type CanonicalPrincipal,
} from "../identity/principal";
import { applyRedactionBoundary } from "../redaction-boundary";

export type AuditAction =
  | "tool.execute"
  | "memory.write"
  | "skill.write"
  | "approval.decide"
  | "outbound.send"
  | "learning.commit"
  | "run.start"
  | "run.complete";

export interface AuditEvent {
  action: AuditAction;
  createdAt: string;
  id: string;
  orgId: string;
  payload: unknown;
  principalUserId: string;
  resource: string;
  runId: string | null;
}

export class AuditError extends Error {
  readonly code = "AUDIT";

  constructor(message: string) {
    super(message);
    this.name = "AuditError";
  }
}

export function createAuditEvent(input: {
  action: AuditAction;
  id: string;
  payload: unknown;
  principal: CanonicalPrincipal;
  resource: string;
  runId?: string | null;
  now?: string;
}): AuditEvent {
  const principal = assertCanonicalPrincipal(input.principal);
  if (!input.resource.trim()) {
    throw new AuditError("Audit resource is required.");
  }
  return {
    action: input.action,
    createdAt: input.now ?? new Date().toISOString(),
    id: input.id,
    orgId: principal.orgId,
    payload: applyRedactionBoundary(input.payload, "audit"),
    principalUserId: principal.userId,
    resource: input.resource.trim(),
    runId: input.runId ?? null,
  };
}

export function auditEventDigest(event: AuditEvent): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        action: event.action,
        id: event.id,
        orgId: event.orgId,
        payload: event.payload,
        principalUserId: event.principalUserId,
        resource: event.resource,
      })
    )
    .digest("hex");
}

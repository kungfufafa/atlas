# ADR 0001 — Learning Plane + Execution Plane

Atlas splits **identity/policy/memory/learning/run state/approval/audit** into
`packages/core`, `packages/db`, and `apps/server`. `apps/platform/*` stay thin
channel adapters.

## Planes

- **Execution Plane** — durable, lease-based, idempotent, principal-bound runs.
  Chat tool loops, automations, and tasks share one run/step state machine.
- **Learning Plane** — closed-loop: redacted evidence → candidate → commit
  (memory or skill revision) → later retrieval → outcome. Nothing is learned
  without evidence; nothing is retrieved without a commit.

## Identity

Channel identities (`telegram` user id, WhatsApp JID, Discord snowflake) are
`ExternalPrincipal`. Runtime always uses a **canonical Atlas user** from
`channel_org_mappings`. Missing principal → fail closed. The local-client
service account (`user_local_client`) must never be the acting principal for
channel chats.

## State machines

### Approval

`pending → approved | denied | expired`

A high-risk tool call pauses the run at the **exact step** (`awaiting_approval`).
Approve resumes that step with the same args hash; deny records a denial result
and does not execute the tool.

### Execution run

`queued → running → awaiting_approval → running → completed | failed | cancelled`

Leases expire; another worker may resume. Idempotency keys are unique per org.

## Evidence

Learning payloads are passed through the redaction boundary **before**
persist/index/audit/outbound. Redaction failure → fail closed.

## Outbound

Every send is an envelope `{ orgId, replyTarget, text }`. Destinations are
re-validated against the workspace allowlist immediately before send.

## Roadmap

- **Gate 0** — resolver, principal, approval resume, fail-closed fallbacks,
  outbound envelope, redaction, tool_search sources, browser `runId` scope.
- **V1** — closed learning loop with evidence.
- **V2** — durable orchestration (lease, idempotency, principal).
- **V3** — internal skill registry (versioned, evidence-linked).

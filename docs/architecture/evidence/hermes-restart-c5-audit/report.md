# Actual abrupt-process restart reproduction

Completed 2026-09-06 22:58:49 UTC against Atlas candidate 5 `1b44dd862ed3dac305c1ebe86dabda28c0de085c6a1d9fc1f6f1eb5eaa7dca2d`. All 2,078 enumerated candidate source files matched before and after the three cases. No root/product/control edits, provider requests, model calls, native SDKs, network requests, or mutation replays were used.

## Method and results

`run.py` starts an owned Bun child per boundary, each with an actual disposable SQLite database and a separate parent-initialized counter file. The child seeds one org, member, profile and session, creates a real `SessionTurnRegistry` entry, requests through `ChatToolApprovalService`, persists through `ExecutionPlaneService`, and (for approved cases) invokes `executeProtectedTool`. The fixture uses the approval-gated `delete_file` name but its injected handler only appends one counter record; it does not delete any file. Before-decision access callbacks read the actual fixture DB membership and session ownership. These callbacks are fixture authorization checks, not the complete HTTP/AgentService admission stack.

The parent observes the selected boundary over a pipe, verifies the child is alive, sends SIGKILL, waits for exit code -9, then launches a different Bun process that opens the same database and new service/registry objects. The after-effect handler fsyncs its append before reporting the boundary and never returns its tool result. Both approved handlers block inside the actual executor after the grant has been consumed. Every process has a bounded deadline; the three-case run took 4.18 seconds.

| Killed boundary | External counter after exit and cold reopen | Old approval / step / run | Durable receipt | Old approval decision after reopen |
|---|---:|---|---|---|
| Awaiting approval | 0 | pending / awaiting_approval / awaiting_approval | absent | 409; no new grant |
| Handler entered, before effect | 0 | approved / running / running | absent | 409; old grant absent |
| Effect fsynced, handler not returned | 1 | approved / running / running | absent | 409; old grant absent |

The fresh registry reports inactive in all three cases. No counter changes occur from reopening or trying to decide the old approval. The before-effect and after-effect cases have equal operational DB state (call/checkpoint, action hash and arguments, approval/step/run status, missing receipt/history), while counters differ 0 versus 1. Timestamps, worker identity and grant IDs necessarily differ and were not asserted equal. The fixture DB has no prior conversation messages; this proves missing receipts at this boundary, not preservation of arbitrary earlier transcripts.

Each cold process also creates a separate explicit new request with fresh approval/run IDs, rechecks current fixture ACLs, and approves it. Its live waiter resolves with a new grant. It does not execute the counter a second time. Cancelling that new run through normal `complete()` records `UNCONFIRMED_RESULT` for its running step; the old crashed run is unchanged. This establishes new approval availability and safe old approval refusal at this service boundary, not automatic continuation or a full user-facing reapproval flow.

## Post-lease observation

A separate additive inspection reopened all three databases after their real 30-second leases expired. No clock was mocked and no new mutation was invoked. `listActiveRuns()` returned no active runs; stored old approval/step/run states and null results remained unchanged, and old decisions still returned 409. Therefore a stale stored `running` record is not the same as being returned as active. This inspection does not instantiate the full server startup, HTTP routes, UI or native runtime; no claim about their rendering or a complete startup recovery worker is made.

The initial run's manifest included mutable SQLite WAL/SHM sidecars. Additional reopen changed or removed six sidecars; their initial byte hashes remain recorded but their original bytes were not snapshotted. This is explicitly recorded in `sidecar-lineage.json`. Main SQLite files, counter files, source bindings, structured snapshots and raw output logs still match the initial hashes. The final package manifest binds the present bytes. Do not describe the initial sidecar set as immutable/reproducibly byte-verified after the follow-up.

## What this proves and does not prove

The restart continuation gap is reproduced, and the uncertainty window is concrete: approved/running plus a checkpoint cannot distinguish zero from one external effect. No duplicate effect was observed. No repeat execution of the mutation was attempted. Automatic replay safety, SDK cold resume, prior-receipt survival, full HTTP authorization and UI presentation require their own tests; this fixture does not prove them. The existing 409 behavior is a sound fail-closed boundary and should be retained.

## Minimal generic fix proposal

Add an explicit interrupted-chat reconciliation lifecycle at the owning server/service boundary, without reconstructing an approval grant or blindly executing a remaining call. For a proven abandoned chat run: expire outstanding approvals, retain all already recorded receipts, mark unresolved running steps with an explicit uncertain-result diagnostic (the existing `UNCONFIRMED_RESULT` is reusable), and terminalize the run as interrupted/cancelled with a reason preserved for the session. Any new non-idempotent action must be a fresh interaction after verification/reconciliation; a tool's cooperating idempotency key or independent effect lookup can later support safe automatic continuation.

Ownership must be proved before mutation. Merely seeing an empty process-local registry or an expired lease is insufficient for a generic multi-process implementation: a live worker may still be executing and current chat approval code does not establish a heartbeat/fencing recovery protocol here. Use an exclusive server epoch or a durable owner/lease with heartbeat and compare-and-swap fencing, and make recovery idempotent and safe against a late original worker. `complete()` currently performs multiple writes; calling it indiscriminately for every stored active row is not a crash-atomic recovery protocol. Preserve org/session scope and existing terminal states, and never create a successful receipt from approval/checkpoint alone.

The next bounded tests should reuse these actual-kill boundaries and add crash-during-reconciliation, already-saved receipt retention, repeated recovery idempotence, foreign/live owner exclusion and a late-writer race. A full new chat-resume worker is a separate development step; the smallest honest immediate improvement is durable interruption/uncertainty handling with an authorized explicit next action.

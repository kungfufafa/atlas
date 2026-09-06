# Agent harness reliability

Audit date: 2026-09-06. This document describes implementation guarantees and
regression coverage. It is not a benchmark claiming parity with Codex, Claude Code,
OpenClaw, or Hermes.

## Sources of truth

Model capabilities belong to the selected provider instance and exact model.
Account runtimes own subscription context occupancy and supported reasoning
settings. API discovery and documented model metadata own API model limits.
Unknown metadata remains unknown; a model name or generic token budget is not
evidence of support. See [provider capability registry](../adr/0002-provider-capability-registry.md).

Tool results establish what executed. Provider terminal events establish whether
a response completed. A fluent preamble, disconnected stream, or successful HTTP
status cannot establish task completion.

## Findings and invariants

| Boundary | Defect found | Required behavior |
| --- | --- | --- |
| Tool loop | Repeated requests were stopped even when results changed | Compare arguments and observed outcomes; allow changing polling results; normalize unordered parallel batches |
| Final response | Reaching a loop limit could return an earlier work promise | Make one bounded request with no Atlas tools, based on completed results; reject empty or tool-calling final output |
| Tool protocol | Malformed argument JSON became an empty object; duplicate call IDs lost correlation | Reject corrupt input before tool effects; retain one result per call ID |
| Argument validation | Advertised schemas were not enforced consistently before execution | Validate supported JSON Schema dialects without coercion, inserting defaults, or deleting properties; reject unsupported schemas before running tools |
| Tool execution | Returned failures were displayed/counted as success | Use returned error indicators for activity and execution metrics |
| Serialization | Unsupported output values could turn a completed mutation into a reported execution failure | Preserve completed status, normalize output for JSON transport, and explicitly report unavailable output |
| Streaming | Repeated Claude deltas were deduplicated; missing terminal responses looked successful | Preserve actual deltas and validate provider terminal status |
| Recovery | A failed model follow-up erased completed tool evidence | Retain correlated action receipts and persist them even when the final model request fails |
| Observers | A disconnected event consumer could interrupt a tool batch after effects | Isolate tool observers from execution; cancellation uses the abort signal |
| Compaction | Invalid summaries and partial tool boundaries could corrupt history | Stage compaction, validate a smaller complete summary, preserve the current user request and latest complete tool batch, commit atomically |
| Long runs | Compaction only between user turns missed growing tool runs | Recheck context after completed batches; native subscription runtimes continue managing their own automatic compaction |
| Retrieval | Successful compaction discarded original database history | Archive original snapshots, including results not yet persisted; store snapshots and active history in one transaction; retrieve with existing conversation ownership checks |
| Skills | A tool-count threshold forced skill creation despite optional post-turn review | Keep user-requested skill authoring and opt-in post-turn review as separate intentional actions |

Primary code boundaries are `packages/agent/src/chat.ts`,
`packages/agent/src/history-compaction.ts`, `packages/core/src/tools/execution.ts`,
`apps/server/src/providers/`, and `apps/server/src/services/session-persistence.ts`.

## Why these mechanisms matter

OpenAI's [model guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.5)
emphasizes preserving tool workflow state and evaluating real tasks. The
[Claude Agent SDK loop](https://code.claude.com/docs/en/agent-sdk/agent-loop)
distinguishes intermediate assistant/tool messages from the final result.
[OpenClaw loop detection](https://docs.openclaw.ai/tools/loop-detection) considers
tool arguments and outcomes when deciding whether repetition makes progress.
[Hermes context compression](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching/)
treats context growth during tool execution as part of the harness lifecycle.
These are design references, not measurements of Atlas against those products.

## Evaluation boundary

Audit verification: the combined core, database, agent, provider, conversation-tool,
and affected service regression run passed **2,275 tests across 271 files**.
Production and web TypeScript checks passed; Ultracite passed on 145 changed source
and configuration files. Provider tests used fixtures, without live inference or
account credentials. Additional persistence race tests also passed independently.

Deterministic tests and provider response fixtures can verify correlation,
failure recovery, input validation, context handling, and persistence. They cannot
measure whether a real model solves a difficult task correctly or writes a useful
answer. Mock release-gate responses are not evidence of model quality.

Any platform comparison must pin model/version, reasoning settings, permissions,
tools, repository state, and resource budget. Use the same tasks with verifiable
outcomes: a repository bug fix, a multi-file refactor, research with supported
citations, a long tool workflow requiring compaction, and recovery after a network
failure following a write. Record completion rate, incorrect completion claims,
duplicate effects, failing validations, latency, and token/cost usage. Compare
answers against task rubrics and executed checks, not style alone.

Archives created by this change preserve future compactions; they cannot recover
details already discarded by older versions. A process crash before persistence
can still lose in-memory receipts: exactly-once external side effects require
tool-specific idempotency keys or a durable execution journal.

# Atlas agent harness — gap analysis (iteration 1)

This document compares the Atlas agent loop to three reference harnesses:

- **Hermes Agent** (NousResearch): learning loop, skill self-improvement, FTS5 memory + LLM summarization
- **OpenClaw**: multi-channel gateway, policy/sandbox, skills ecosystem
- **Nakama** (upstream of this fork): soul system, skill post-turn review + consolidation, channel-aware prompts

Citations are to current Atlas files and functions. Rankings are about **response quality**, not product surface area: tool-hallucination rate, multi-step reasoning, context-awareness, long-session behavior.

## What Atlas already has (do not rebuild)

| Area | Atlas location | Notes |
|---|---|---|
| Chat structure + channel prompts | `packages/agent/src/chat-prompt.ts` `buildChatSystemPrompt` | Presence rules, untrusted-document guidance, WhatsApp/Telegram/Discord format rules |
| Soul identity | `packages/core/src/soul/compose.ts` `composeSoulSystemPrompt` | SOUL / STYLE / INSTRUCTIONS / MEMORY.md |
| Skills catalog + match | `packages/core/src/skills/compose.ts` | Catalog, matched body, agent-browser capability |
| Tool loop | `packages/agent/src/tool-loop.ts` `executeToolCall`; parallel batching in `packages/agent/src/chat.ts` | Unknown tools return `{ error: "Unknown tool: …" }`; `parallelSafe` tools may batch |
| Compaction | `packages/agent/src/history-compaction.ts` `compactHistory` | Structured Markdown summary; ChatGPT subscription owns native compaction via `managesContext` |
| Post-turn skill review | `packages/agent/src/skill-post-turn-review.ts`; `apps/server/src/services/skill-post-turn-review-service.ts` | Opt-in; org default is **off** (`skills_post_turn_review` default 0) |
| Skill consolidation | `packages/agent/src/skill-curator-consolidation.ts`; `apps/server/src/services/skill-curator-service.ts` | LLM merge of overlapping SKILL.md |
| `/learn` | `packages/agent/src/learn-prompt.ts`; `skill_manage` guidance in `buildChatSystemPrompt` | Distill sources into a profile skill; untrusted-source rules |
| DB memory | `apps/server/src/tools/memory-tools.ts` | `memory_write` uses `strategy: "preserve"` (exact reuse, not semantic upsert) |
| Conversation retrieval | `packages/db/src/conversation-keyword-search.ts` | Weighted lexical scan; `matchMode: "keywords"` |
| Skill FTS5 | `packages/db/src/skill-rank-fts5.ts` | In-memory FTS5 for **skill ranking only**, not memory |
| Runtime work rules | `packages/db/src/constants.ts` `DEFAULT_AGENT_WORK_RULES` | Includes “do not invent tools”; appended in `AgentService`, not in `buildChatSystemPrompt` |
| OpenCode Go provider | `apps/server/src/providers/opencode-go/` | Catalog + chat/messages/responses routing; live eval channel |

---

## Ranked gaps

Impact columns: **H** = tool-hallucination, **R** = multi-step reasoning, **C** = context-awareness, **L** = long-session behavior. Score 1–5.

### P0. OpenCode Go live path is unusable (missing `x-opencode-session`)

**Iteration 1 shipped this.** `createOpenCodeGoProvider` now wraps outbound fetch with `x-opencode-session` (`apps/server/src/providers/opencode-go/session.ts`). Atlas `GenerateChatInput.conversationId` (from `toolContext.sessionId` in `generateReply`) is preferred; otherwise a stable `atlas-opencode-go-{providerInstanceId}` id is used.

Before this change the gateway returned HTTP 400 `MissingSessionID` on chat/completions, so the real agent path could not be live-evaluated. Remaining quality gaps below assume transport works.

| H | R | C | L | Why first |
|---|---|---|---|---|
| 5 | 5 | 5 | 5 | Every live-eval dimension is zero until the real agent path can complete a turn |

Without this, Atlas cannot measure itself against Hermes/OpenClaw/Nakama on the chosen live channel.

### P0. Assigned-tool allowlist is not in the chat prompt

**Iteration 2 shipped this.** `buildChatSystemPrompt` emits `# Assigned tools` when `enableToolLoop` is true: exact names plus a one-line purpose from `tool.description`, with an instruction to call only those names or answer directly. Native schemas remain on the provider `tools` field. `DEFAULT_AGENT_WORK_RULES` “Do not invent tools” is still AgentService-only and is not duplicated here.

Unknown-tool recovery (`executeToolCall` → `{ error: "Unknown tool: …" }`) is unchanged. Live eval on `kimi-k2.7-code` was already 12/12 on the expanded suite before the prompt change; the allowlist is the product-path fix, not a measured live delta on this model.

| H | R | C | L |
|---|---|---|---|
| 5 | 3 | 2 | 2 |

### P1. Memory is file-injection + exact-match DB, not Hermes FTS5 + summarization

**Iteration 3 shipped** bounded `MEMORY.md` + FTS/recency `memory_search`. **Iteration 5 shipped** the remaining Hermes pair: live LLM summarization of over-cap omitted facts (hash-cached) and production `memory_search` over profile `memory-archive/` (`YYYY-MM.md`), ranked with the same FTS/recency code.

Remaining vs Hermes:

- `memory_write` exact-reuses identical trimmed content (`strategy: "preserve"`) — not a semantic merge
- `search_chats` is still in-process keyword ranking; compacted transcripts are not FTS-indexed
- Database memory and `MEMORY.md` **do not sync**; the LLM summary is an injection, not a rewritten file
- Summarization cache is process-local LRU (content hash); it does not persist across restarts

| H | R | C | L |
|---|---|---|---|
| 1 | 3 | 2 | 3 |

### P1. Learning loop is opt-in and turn-local, not continuous

**Iteration 4 shipped the closed loop, still default-off.** `runSkillLearningTurn` on `createAgentChatSession` distills Unknown tool / requested unassigned tool / `no_progress` / taught SOP into a skill (LLM review + deterministic fallback), consolidates, and injects via matched-skill compose. Live two-phase eval: **0/6 → 6/6** with `--skill-learning` on both models.

Remaining vs Hermes always-on:

- Product still requires opted-in post-turn review + assigned `manage-skills` (eval `--skill-learning` forces the session flag)
- `/learn` remains the user-invoked path
- Review output on the older AgentService suggestion path is unchanged when the new loop is off

| H | R | C | L |
|---|---|---|---|
| 3 | 4 | 3 | 3 |

### P1. Long-session compaction is structured but not retrieval-backed

`compactHistory` produces a fixed Markdown template (Goal / Constraints / Progress / …). That is better than naive truncation. Gaps vs Hermes:

- Compacted archives are not FTS-indexed for later `search_chats`
- Compaction is token-window triggered, not “learning distill”
- Native ChatGPT path bypasses Atlas compaction (`ProviderClient.managesContext`); other providers including OpenCode Go do not

| H | R | C | L |
|---|---|---|---|
| 1 | 3 | 4 | 5 |

### P2. Channel awareness: format rules exist; private/group kind does not reach the session

**Iteration 6 shipped this.** `createAgentChatSession` and `AgentService.buildChatSession` pass `chatKind` (`private` | `group`) into `buildChatSystemPrompt`. Channel workers already send `externalPrincipal.channelIsGroup`; `resolveMessagingChatKind` maps that onto messaging channels only. Unset kind still uses the generic fallback line. Private vs group etiquette lines now fire. Remaining: `chatKind` is in-memory on the live session record, not a SQLite column, so a cold rebuild after restart without the original principal falls back to unset.

| H | R | C | L |
|---|---|---|---|
| 1 | 2 | 4 | 2 |

### P2. OpenClaw policy/sandbox vs Atlas process sandbox

Atlas: Landlock (`linux-landlock-abi3-v2`), `ATLAS_PROCESS_NETWORK`, profile `workspaceRoot` via `buildToolExecutionContext`. OpenClaw’s gateway policy language (per-channel allow/deny, skill trust tiers) is broader. This is mostly **safety**, but it also reduces tool hallucination when the model is told a tool is unavailable vs calling it and getting a sandbox error.

| H | R | C | L |
|---|---|---|---|
| 3 | 2 | 2 | 1 |

### P2. Skills ecosystem breadth

Atlas: bundled skills, profile SKILL.md, Composio, `skill_manage`, curator. OpenClaw’s public skill registry is larger. Quality impact is tool **selection** when the catalog is huge (`tool_search` exists but is optional).

| H | R | C | L |
|---|---|---|---|
| 3 | 3 | 2 | 2 |

### P3. Soul system (Nakama) — keep, don’t replace

`composeSoulSystemPrompt` + USER.md in `buildChatSystemPrompt` already match Nakama’s identity model. Guests skip MEMORY.md (`resolveProfileSystemPrompt`). Iteration work should **preserve** this and measure it, not rewrite it.

---

## Iteration 1 choice

**Shipped:** send `x-opencode-session` on every OpenCode Go HTTP call (chat, messages, responses, models; prefer Atlas `conversationId` when present).

This is not a prompt tweak. It is the blocker for live evaluation of every other gap on the agreed channel (OpenCode Go). After it lands, iteration 2 should attack **assigned-tool allowlist + unknown-tool learning** (highest remaining H), then **memory retrieval/summarization** (highest remaining C/L).

## Iteration 2 choice

**Shipped:** assigned-tool allowlist in `buildChatSystemPrompt` when `enableToolLoop` is true (`packages/agent/src/chat-prompt.ts`). The real tool-loop path (`createAgentChatSession` → `generateReply` → `executeToolCall`) and AgentService both assemble that prompt, so CLI/eval no longer depend on `appendRuntimeProfileRules` for the roster.

Eval added four harder hallucination scenarios (absent web/email tools, live-vs-archive decoy, lookup+KB combination, no-fit general question). Live OpenCode Go (`kimi-k2.7-code`) was **12/12 before and after**; no scenario improved or regressed. Next: **unknown-tool learning** (feed `Unknown tool` / `no_progress` into post-turn review) or **memory retrieval/summarization** (highest remaining C/L).

## Eval hardening (after iteration 2)

The 12-scenario suite was saturated on `kimi-k2.7-code` because work-rules and native schemas already constrained a strong model. The runner now ablates work-rules, the assigned-tool allowlist, model id, and (eval-only) native schemas; scores tool precision/recall; and adds near-duplicate, 3-hop, long-context needle, wording-trap, and no-fit-lure scenarios. Live matrix: `docs/harness/eval-results/ablation-summary.md`.

Honest result: allowlist **alone** did not reduce hallucination (zero delta with work-rules OFF on both `kimi-k2.7-code` and `deepseek-flash`). Allowlist **plus** work-rules flipped `tool_avoid_absent_web_search` on flash only (15/17 → 16/17). `tool_avoid_wording_trap` failed all eight cells because the user-named decoy is in that scenario's catalog.

## Iteration 3 choice

**Shipped:** bounded `MEMORY.md` injection (`composeContinuityMemorySection`, 8192-byte default; small files unchanged) and shared `searchRankedMemories` (lexical + FTS5 boost + recency collapse on `"X is Y"` slots). `MemoryService` search uses that ranker. Eval `--no-memory-retrieval` is the dump-only baseline.

Live OpenCode Go: memory yardsticks **0/4 → 4/4** on `kimi-k2.7-code` (n=3) and `deepseek-flash` (n=3). Full suite **20/21** on both; original 16/17 held. `tool_avoid_wording_trap` still fails. Extractive bound is the production default; LLM summarization is a seam, not a live session-start call. Details: `docs/harness/eval-results/iter3-summary.md`.

## Iteration 4 choice

**Shipped:** a default-off closed skill-learning loop on `createAgentChatSession`. Qualifying signals (Unknown tool, requested unassigned snake_case name, `no_progress`/`iteration_limit`, tool error, taught SOP) distill a create/patch via `generateSkillPostTurnReview` with `distillFallbackSkill` if the LLM noops, then `consolidateSkillLearningOutcome`. Learned skills match/inject through the existing FTS compose path (`include-body-on-match: true`). AgentService enables the loop only when post-turn review is opted in, `manage-skills` is assigned, the channel is web/cli, and the principal is not a guest. Write-approval still stages.

Live OpenCode Go two-phase yardsticks (`learn_sop_acquisition`, `learn_unknown_tool_recovery`): **0/6 → 6/6** on `kimi-k2.7-code` (n=3) and **0/6 → 6/6** on `deepseek-flash` (n=3) with `--skill-learning` vs `--no-skill-learning`. Original 21-suite **20/21** held (learning off). Details: `docs/harness/eval-results/iter4-summary.md`.

## Iteration 5 choice

**Shipped:** wire `summarizeContinuityMemoryWithModel` into `composeSoulSystemPromptWithSummary` / `AgentService.resolveProfileSystemPrompt` so over-cap MEMORY.md injects a hash-cached LLM summary of omitted facts plus newest extractive bullets. Product `memory_search` loads `memory-archive/YYYY-MM.md` via `loadProfileMemoryArchiveFacts` and ranks those rows with `searchRankedMemories`. Kill switches: `ATLAS_MEMORY_SUMMARIZATION=0`, `MemoryService({ indexProfileArchive: false })`.

Live OpenCode Go: `memory_summary_needle` **0/6 → 6/6** per model (n=3, extractive vs LLM; `CEDAR-FALCON-7` survives only via summary). `memory_archive_needle` **0/6 → 6/6** per model (n=3, `--no-archive-index` vs production parser; `QUARTZ-WALRUS-19`). Full 21-suite **20/21**; learning 23-suite **22/23** strong / **23/23** weak. Details: `docs/harness/eval-results/iter5-summary.md`.

## Iteration 6 choice

**Shipped:** plumb `chatKind` from `externalPrincipal.channelIsGroup` through `AgentService` / `createAgentChatSession` into `buildChatSystemPrompt`, with explicit private 1:1 vs group etiquette blocks. Assigned-tool roster now labels each line `purpose:` and instructs selection by purpose, not similar names. Eval extras: private/group WhatsApp + Telegram yardsticks (`--no-chat-kind` baseline) and `tool_avoid_unassigned_decoy` (close name absent from the catalog).

See `docs/harness/eval-results/iter6-summary.md` for live numbers. Do not claim `tool_avoid_wording_trap` is solved unless the strong model actually moved.

## Eval coverage this iteration

`scripts/harness-eval/run.ts` drives `createAgentHarness` → `createChatSession` → `send()` (real `buildChatSystemPrompt` + `generateReply` + `executeToolCall` loop) with `createOpenCodeGoProvider`. Flags: `scripts/harness-eval/README.md`.

Scenarios: original 12 plus near-duplicate, 3-hop, 90-bin MEMORY.md needle, wording trap, no-fit lure, four retrieval yardsticks (archive needle, conflict/recency, search_chats, bounded dump), two two-phase learning yardsticks (SOP acquisition, unknown-tool recovery), extra `memory_summary_needle` (not in the 21 default), private/group WhatsApp+Telegram `chatKind` extras, and `tool_avoid_unassigned_decoy`. `--skill-learning` is **off** by default. `--memory-summarization`, `--archive-index`, and `--chat-kind` default **on**.

Honest limit: this path does **not** boot `AgentService` (no org middleware, no `appendRuntimeProfileRules` unless the eval injects them, no SQLite `memory_write`). Soul is composed in-process via the same `composeSoulSystemPromptWithSummary` AgentService uses. Memory tools in the eval use an in-harness store over the **same** `searchRankedMemories` / `ConversationKeywordSearch` / `loadMemoryArchiveFacts` functions as production. Native schemas stay on in the published matrix. See the eval summary JSON `path` field.

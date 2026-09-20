# Atlas harness evidence — Nakama, OpenClaw, and Hermes Agent

Historical Atlas capability inventory and fixture results, corrected on **2026-09-21**. The previous relative rankings are withdrawn: no reference system ran these fixtures. **Quality parity and a shorter user journey remain unproven against all three references.** See [Foundation audit](foundation-audit.md) for current pinned sources, product journeys, and the blocked Phase 0 gate.

Atlas citations are current files/functions. Historical live evidence is OpenCode Go `createAgentHarness.createChatSession.send` from iterations 1–7 plus the **2026-09-18 verification** (`docs/harness/eval-results/final-verification-summary.md`). The 2026-09-17 29-scenario sweep is historical.

Reference notes (documentation/source only; no reference runtime evaluation here):

- **Hermes Agent** (NousResearch): bounded `MEMORY.md`/`USER.md`, SQLite FTS5 `session_search`, default-on, disableable post-turn skill/memory review ([Hermes memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory), [Hermes skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)).
- **OpenClaw**: USER.md/MEMORY.md, memory retrieval and consolidation, gateway bindings, and tool-policy allow/deny; the older characterization as a generic workspace dump was unsupported ([memory](https://docs.openclaw.ai/concepts/memory)) ([tool policy](https://docs.openclaw.ai/gateway/config-tools/tool-policy), [multi-agent](https://docs.openclaw.ai/concepts/multi-agent)).
- **Nakama** (upstream fork): soul files, `buildChatSystemPrompt` USER.md + `chatKind`, opt-in post-turn skill review that stages suggestions rather than a closed apply loop.

Eval honesty: this path does **not** boot `AgentService` (no org middleware, no tenant SQLite `memory_write`). Soul, ranking, archive parser, keyword search, and skill compose/match are the same functions production uses. Native schemas stay on. These historical runs used OpenCode Go; new model evidence must use `https://router.rizqis.com/v1` with exact model/configuration recorded and credentials excluded from artifacts.

---

## Matrix

Each row preserves Atlas implementation notes and historical fixture results, then states the comparative evidence limit.

### 1. Prompt assembly (soul / USER.md / tools / channel)

**Atlas.** `composeSoulSystemPrompt` / `composeSoulSystemPromptWithSummary` (`packages/core/src/soul/compose.ts`) injects SOUL / STYLE / INSTRUCTIONS / bounded MEMORY.md. `buildChatSystemPrompt` (`packages/agent/src/chat-prompt.ts`) adds USER.md, timezone, `# Assigned tools` via `appendAssignedToolsAllowlist` / `formatAssignedToolRosterLine` (purpose lines + “choose by purpose”), and messaging blocks via `appendMessagingChannelPrompt` + `resolveMessagingChatKind`. `appendRuntimeProfileRules` / `DEFAULT_AGENT_WORK_RULES` (`packages/db/src/constants.ts`) still append “do not invent tools” on the AgentService/eval work-rules path.

**Live evidence.** Iter1 transport 0/8 → 8/8. Iter2 allowlist: 12/12 before and after on `kimi-k2.7-code` (saturated). Iter6 purpose roster did not move assigned decoy on kimi (0/3). Historical 2026-09-18 verification: unassigned decoy **8/8** (n=2 × 4 models); soul `memory_recall` and USER.md continuity held inside the 21-suite.

| Reference | Comparative quality | Observation / limit |
|---|---|---|
| Nakama | **unproven** | Shared soul/USER.md lineage; Atlas roster additions have only Atlas fixture evidence, not a Nakama behavior or journey baseline. |
| OpenClaw | **unproven** | Current documentation includes USER.md and MEMORY.md. A larger Atlas prompt is not evidence of better identity behavior. |
| Hermes | **unproven** | Both expose persistent user/memory context; different storage and budgets need comparable tasks and observed journeys. |

### 2. Tool loop + hallucination discipline

**Atlas.** `executeToolCall` (`packages/agent/src/tool-loop.ts`) returns `{ error: "Unknown tool: …" }` for missing names. Parallel batching when every call is `parallelSafe` (`canRunToolCallsInParallel` in `tool-loop.ts`, dispatch in `packages/agent/src/chat.ts`). Native schemas remain on the provider `tools` field. Allowlist is prompt-side; it does not strip schemas.

**Live evidence.** Iter2 ablation (`ablation-summary.md`): allowlist **alone** did not reduce hallucination (zero pass-rate delta with work-rules OFF). Allowlist **plus** work-rules flipped `tool_avoid_absent_web_search` on flash only (15/17 → 16/17). Iter6 unassigned decoy **6/6**; assigned decoy kimi **0/3**. Historical verification: hallucinated `nuke_database` held in the 21; unassigned decoy **8/8**; assigned decoy **kimi 0/2, v4-pro 2/2, glm 0/2, flash 2/2**; glm/flash still substitute assigned tools for missing web/email (flash absent-web **0/2**, glm **1/2**).

| Reference | Comparative quality | Observation / limit |
|---|---|---|
| Nakama | **unproven** | Shared unknown-tool recovery; Atlas roster/purpose guidance is an implementation difference, not a demonstrated comparative improvement. |
| OpenClaw | **unproven** | Gateway tool policy is documented, but its effectiveness was not measured on these fixtures. |
| Hermes | **unproven** | Atlas-only tool-selection and learning results do not measure Hermes recovery or tool selection. |

Do not claim the allowlist is a measured hallucination killer on strong models. Unassigned close-name cases passed with native schemas present even in allowlist-off runs, so those passes alone do not isolate the roster's contribution.

### 3. Memory (retrieval / FTS / summarization / recency / cross-session)

**Atlas.** `composeContinuityMemorySection` (`packages/core/src/soul/continuity-memory.ts`) bounds MEMORY.md (8192-byte default). Over-cap: newest extractive bullets plus optional `summarizeContinuityMemoryWithModel` of omitted facts (hash-cached LRU). `searchRankedMemories` (`packages/db/src/memory-rank-fts5.ts`) = lexical + FTS5 boost + recency collapse on `"X is Y"` slots. Production `memory_search` merges `loadProfileMemoryArchiveFacts` (`packages/core/src/soul/memory-archive-index.ts`). Native `search_chats` uses `searchRankedConversations` (`packages/db/src/conversation-rank-fts5.ts`) — FTS5 BM25 + recency over authorized live messages and compacted archives, falling back to weighted lexical (`ConversationKeywordSearch`) when FTS is unavailable. Literal `matchMode` callers stay `LIKE`. Persistent `conversation_messages_fts` is populated from `session_messages` and `session_history_archives`; ranking still runs only on tenant-filtered candidates. `memory_write` remains exact-reuse (`strategy: "preserve"`). Database memory and MEMORY.md do not sync. AgentService wires summarization in `resolveProfileSystemPrompt`.

**Live evidence.** Iter3: dump-only memory yardsticks **0/4 → 4/4** (n=3 both models). Iter5: `memory_summary_needle` **0/6 → 6/6** per model; `memory_archive_needle` **0/6 → 6/6** per model. Fresh verification memory dimension **18/18** on every model (n=2 × 9 memory scenarios, including summary + archive + FTS). Fresh FTS yardstick `memory_search_chats_fts`: lexical `--no-fts-chats` **0/6** → FTS **8/8**; existing `memory_search_chats` still **true** on every 21-suite run.

| Reference | Comparative quality | Observation / limit |
|---|---|---|
| Nakama | **unproven** | Atlas bounded memory, archive retrieval, and FTS changes improved some Atlas ablations; corresponding Nakama behavior remains unmeasured. |
| OpenClaw | **unproven** | Current docs describe hybrid retrieval, session recall, and consolidation; the old comparison did not establish a missing OpenClaw memory stack. |
| Hermes | **unproven** | Hermes documents bounded memory and FTS5 session search. Similar mechanisms do not establish equal long-session results. |

### 4. Skill learning / consolidation

**Atlas.** `runSkillLearningTurn` (`packages/agent/src/skill-learning-loop.ts`) after `createAgentChatSession.send`. Signals: unknown tool, requested unassigned snake_case, `no_progress`/`iteration_limit`, tool error, taught SOP (`collectSkillLearningSignals` in `packages/core/src/skills/learning-signals.ts`). Distill: `generateSkillPostTurnReview` then `distillFallbackSkill`. Merge: `consolidateSkillLearningOutcome` (`packages/core/src/skills/learned-skill.ts`). Inject: `matchSkillsForMessage` + `createFts5SkillRanker` + `composeMatchedSkillsPrompt`. Product default **off**. AgentService enables only when post-turn review is opted in, `manage-skills` is assigned, channel is web/cli (`skillLearningAllowedOnChannel`), and the principal is not a guest. Write-approval stages via `createSkillsServiceLearningStore`. `/learn` remains user-invoked. This reuses the **opt-in** Nakama-shaped flag, but the two Atlas review paths have different persistence and completion behavior. `send`/`sendStream` await this learning pass before resolving; without write approval its store writes directly. The separate service review produces suggestions/proposals. Product docs promising only nonblocking Apply suggestions need reconciliation before this difference is defended. Operators can turn it on for Super Agent on web/cli (Super Agent typically has `manage-skills`; set org/profile `skillsPostTurnReview`). There is **no** hardcoded Super-Agent default-on in code.

**Live evidence.** Iter4: two-phase yardsticks **0/6 → 6/6** per model with `--skill-learning`. Fresh verification learning **4/4** per model (n=2 × 2 scenarios) with skill-learning ON; dedicated `--no-skill-learning` **0/8** → ON **16/16**.

| Reference | Comparative quality | Observation / limit |
|---|---|---|
| Nakama | **unproven** | Nakama review stages suggestions/proposals. Atlas adds a direct learning-store path; its latency, visibility, and governance journey need proof. |
| OpenClaw | **unproven** | Ecosystem breadth and background learning are separate questions; neither was measured against this Atlas fixture. |
| Hermes | **unproven** | Hermes documents default background review and optional write approval; Atlas opt-in and two review paths need product-level evaluation. |

### 5. Compaction

**Atlas.** `compactHistory` (`packages/agent/src/history-compaction.ts`) emits a fixed Markdown template (Goal / Constraints / Progress / Decisions / Next Steps / Critical Context / Relevant Files). Triggered on token overflow (or `force`). ChatGPT subscription bypasses Atlas compaction (`ProviderClient.managesContext`). Compacted archives are indexed into `conversation_messages_fts` and ranked with live messages in `search_chats` (iter7).

**Live evidence.** Iter7 FTS yardstick proves BM25 session search over a large transcript (lexical miss inside the result limit). Historical verification: lexical **0/6** → FTS **8/8**. Production search SQL unions `session_messages` with `session_history_archives`. Long-session MEMORY.md needles still passed (**18/18** memory cells per model); `memory_search_chats` still passes with FTS on.

| Reference | Comparative quality | Observation / limit |
|---|---|---|
| Nakama | **unproven** | Shared compaction lineage and Atlas archive indexing do not prove equivalent recovery across repeated compaction/restart. |
| OpenClaw | **unproven** | Both document compaction; no comparable run was recorded. |
| Hermes | **unproven** | Session retrieval exists in both, but summary fidelity and repeated compaction were not compared. |

### 6. Channel awareness

**Atlas.** Format rules for WhatsApp/Telegram/Discord in `MESSAGING_CHANNEL_PROMPT`. Iter6 plumbed `chatKind` from `externalPrincipal.channelIsGroup` through `AgentService.buildChatSession` / `createAgentChatSession` into `buildChatSystemPrompt`. Private: `PRIVATE_CHAT_KIND_GUIDANCE`. Group: `GROUP_CHAT_KIND_GUIDANCE`. Unset kind still uses `messagingUnsetAudienceLine`. Iter7 persists `sessions.chat_kind` (`private` \| `group`) and reloads it on cold rebuild (`parseStoredChatKind`).

**Live evidence.** Iter6: prompt checks **0/24 → 24/24**; live pass **0/12 → 9/12** strong and **10/12** weak. Historical verification: every private prompt check true; group extras **8/8**; private **reply** name-addressing remains (WhatsApp private 4/8, Telegram private 4/8; glm both 0/2).

| Reference | Comparative quality | Observation / limit |
|---|---|---|
| Nakama | **unproven** | Shared channel-aware prompt lineage; Atlas has persistence tests, not a current Nakama user-journey baseline. |
| OpenClaw | **unproven** | Bindings, mention gating, and group policy need channel-level evaluation beyond prompt inspection. |
| Hermes | **unproven** | Messaging support is documented; equivalent reply behavior and delivery were not measured. |

### 7. Multi-tenant / policy / sandbox

**Atlas.** Orgs isolate profiles/sessions/tools (`org_id`; `apps/server/src/http/org-middleware.ts`, `org-guards.ts`, `requireNotViewer`). Tool workspace is `buildToolExecutionContext` (`packages/core/src/tools/context.ts`) → profile soul dir. Linux Landlock policy `linux-landlock-abi3-v2` (`apps/server/src/services/restricted-process.ts` / `restricted-process-admission.ts`). `ATLAS_PROCESS_NETWORK=deny` is macOS-enforced; invalid/deny-without-enforcement fails closed. Assigned-tool roster is the session tool policy. Guest principals get a confined tool set (`channel-guest-tool-policy.ts`).

**Live evidence.** Not a quality-yardstick dimension. Transport + assigned catalog are the eval proxies. OpenClaw policy breadth was not live-scored.

| Reference | Comparative quality | Observation / limit |
|---|---|---|
| Nakama | **unproven** | Shared org/RBAC lineage; current authorization and operator journeys require direct checks. |
| OpenClaw | **unproven** | Tool policies and sandbox configuration differ; policy breadth alone does not establish better safety or UX. |
| Hermes | **unproven** | Different tenancy models serve different audiences; added Atlas controls are not a quality win without task-specific evidence. |

---

## Comparative verdict

All seven capability areas above remain **unproven** against Nakama, OpenClaw, and Hermes. Atlas fixture improvements remain historical evidence for the specific ablations; they do not establish parity, superior UX, or goal completion. The [foundation audit](foundation-audit.md) sets the current Nakama-first priorities.

---

## Recorded residuals and limits

| residual | class | evidence |
|---|---|---|
| (a) Assigned-decoy `tool_avoid_wording_trap` on kimi/glm | **cause unresolved** | Historical verification: kimi **0/2**, glm **0/2**. Purpose roster + “choose by purpose” (iter6) did not move kimi. **Counterexample:** `deepseek-v4-pro` **2/2** and `deepseek-flash` **2/2** called the real lookup — harness can surface the distinction; kimi/glm still follow the user-named assigned stub. |
| (b) Private reply-style (`channel_telegram_private` / WhatsApp private) | **cause unresolved** | Prompt checks passed in the recorded samples; this does not isolate the cause of reply failures. Failures are `reply_does_not_address_asker`. glm both privates **0/2** (stable). Others noisy (kimi Telegram 1/2; v4-pro WhatsApp 1/2 and Telegram 1/2). The expected guidance was present; model, prompt, and harness contributions remain unresolved. |
| (c) Skill-learning default-off | **configured default; UX unmeasured** | Nakama is opt-in; Hermes documents default-on background review that can be disabled. Eval `--skill-learning` forces the session flag. Super Agent web/cli can enable it by opting in post-turn review + assigned `manage-skills` — not hardcoded on. |
| (d) `chatKind` persisted to SQLite | **implementation landed (iter7)** | `sessions.chat_kind`; adapter load + `AgentService` cold-rebuild unit test. |
| (e) Compacted / session `search_chats` FTS | **implementation landed (iter7)** | FTS5 BM25 + recency over authorized live+archive candidates; lexical fallback. Historical lexical **0/6** → FTS **8/8** (iter7 was 0/9 → 9/9). |
| (f) OpenClaw gateway-policy breadth | **scope and UX decision pending** | Current OpenClaw documentation describes tool policy and sandbox scopes; the earlier breadth/trust-tier comparison was not measured. Atlas uses org RBAC, assigned tools, and process confinement. Relative safety and operator friction remain unproven. |

Related, not in the required list: LLM continuity-summary cache is process-local LRU (cost, not a failed yardstick); `memory_write` exact-reuse is a product invariant; allowlist-off cannot live-induce an unassigned tool call because native schemas also omit the name.

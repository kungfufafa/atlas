# Atlas vs Hermes Agent, OpenClaw, and Nakama

Capability matrix for **response quality**, not product surface area. Rankings: **exceeds** / **matches** / **partial** / **gap**.

Atlas citations are current files/functions. Live evidence is OpenCode Go `createAgentHarness.createChatSession.send` from iterations 1–7 plus the final sweep (`docs/harness/eval-results/`).

Reference systems (not live-evaled here):

- **Hermes Agent** (NousResearch): bounded `MEMORY.md`/`USER.md`, SQLite FTS5 `session_search`, always-on post-turn skill/memory review ([Hermes memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory), [Hermes skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills)).
- **OpenClaw**: gateway bindings, per-agent skill allowlists, tool-policy allow/deny, sandbox scopes ([tool policy](https://docs.openclaw.ai/gateway/config-tools/tool-policy), [multi-agent](https://docs.openclaw.ai/concepts/multi-agent)).
- **Nakama** (upstream fork): soul files, `buildChatSystemPrompt` USER.md + `chatKind`, opt-in post-turn skill review that stages suggestions rather than a closed apply loop.

Eval honesty: this path does **not** boot `AgentService` (no org middleware, no tenant SQLite `memory_write`). Soul, ranking, archive parser, keyword search, and skill compose/match are the same functions production uses. Native schemas stay on.

---

## Matrix

Each row: Atlas implementation, live-eval proof, then a verdict vs each reference.

### 1. Prompt assembly (soul / USER.md / tools / channel)

**Atlas.** `composeSoulSystemPrompt` / `composeSoulSystemPromptWithSummary` (`packages/core/src/soul/compose.ts`) injects SOUL / STYLE / INSTRUCTIONS / bounded MEMORY.md. `buildChatSystemPrompt` (`packages/agent/src/chat-prompt.ts`) adds USER.md, timezone, `# Assigned tools` via `appendAssignedToolsAllowlist` / `formatAssignedToolRosterLine` (purpose lines + “choose by purpose”), and messaging blocks via `appendMessagingChannelPrompt` + `resolveMessagingChatKind`. `appendRuntimeProfileRules` / `DEFAULT_AGENT_WORK_RULES` (`packages/db/src/constants.ts`) still append “do not invent tools” on the AgentService/eval work-rules path.

**Live evidence.** Iter1 transport 0/8 → 8/8. Iter2 allowlist: 12/12 before and after on `kimi-k2.7-code` (saturated). Iter6 purpose roster did not move assigned decoy on kimi (0/3). Final sweep: unassigned decoy **8/8** (n=2 × 4 models); soul `memory_recall` and USER.md continuity held inside the 21-suite.

| vs | rank | one-line |
|---|---|---|
| Hermes | **matches** | Both freeze USER + memory into the prompt; Atlas adds a four-file soul, Hermes uses tighter char caps and a dedicated `memory` tool instead of soul files. |
| OpenClaw | **exceeds** | OpenClaw assembles workspace + skill allowlists, not a soul/USER.md identity stack; Atlas prompt assembly is the richer identity model. |
| Nakama | **exceeds** | Same soul/USER.md lineage; Atlas adds the assigned-tool roster + purpose selection that Nakama’s `buildChatSystemPrompt` did not emit. |

### 2. Tool loop + hallucination discipline

**Atlas.** `executeToolCall` (`packages/agent/src/tool-loop.ts`) returns `{ error: "Unknown tool: …" }` for missing names. Parallel batching when every call is `parallelSafe` (`canRunToolCallsInParallel` in `tool-loop.ts`, dispatch in `packages/agent/src/chat.ts`). Native schemas remain on the provider `tools` field. Allowlist is prompt-side; it does not strip schemas.

**Live evidence.** Iter2 ablation (`ablation-summary.md`): allowlist **alone** did not reduce hallucination (zero pass-rate delta with work-rules OFF). Allowlist **plus** work-rules flipped `tool_avoid_absent_web_search` on flash only (15/17 → 16/17). Iter6 unassigned decoy **6/6**; assigned decoy kimi **0/3**. Final sweep: hallucinated `nuke_database` held in the 21; unassigned decoy **8/8**; assigned decoy **kimi 0/3, v4-pro 3/3, glm 0/3, flash 1/3**; glm/flash still substitute assigned tools for missing web/email (glm absent-web **0/3**).

| vs | rank | one-line |
|---|---|---|
| Hermes | **matches** | Unknown-tool recovery and a listed catalog are equivalent discipline; Hermes additionally trains the catalog over time via always-on review (see learning row). |
| OpenClaw | **partial** | OpenClaw can omit tools from the gateway catalog per agent/sandbox; Atlas lists assigned tools and still sends native schemas, so assigned decoys remain callable. |
| Nakama | **exceeds** | Same `executeToolCall` unknown-tool path; Atlas adds allowlist + purpose + measured unassigned-decoy passes Nakama did not publish. |

Do not claim the allowlist is a measured hallucination killer on strong models. The discriminating win is **unassigned** close names, plus work-rules on weak/mid absent-web.

### 3. Memory (retrieval / FTS / summarization / recency / cross-session)

**Atlas.** `composeContinuityMemorySection` (`packages/core/src/soul/continuity-memory.ts`) bounds MEMORY.md (8192-byte default). Over-cap: newest extractive bullets plus optional `summarizeContinuityMemoryWithModel` of omitted facts (hash-cached LRU). `searchRankedMemories` (`packages/db/src/memory-rank-fts5.ts`) = lexical + FTS5 boost + recency collapse on `"X is Y"` slots. Production `memory_search` merges `loadProfileMemoryArchiveFacts` (`packages/core/src/soul/memory-archive-index.ts`). Native `search_chats` uses `searchRankedConversations` (`packages/db/src/conversation-rank-fts5.ts`) — FTS5 BM25 + recency over authorized live messages and compacted archives, falling back to weighted lexical (`ConversationKeywordSearch`) when FTS is unavailable. Literal `matchMode` callers stay `LIKE`. Persistent `conversation_messages_fts` is populated from `session_messages` and `session_history_archives`; ranking still runs only on tenant-filtered candidates. `memory_write` remains exact-reuse (`strategy: "preserve"`). Database memory and MEMORY.md do not sync. AgentService wires summarization in `resolveProfileSystemPrompt`.

**Live evidence.** Iter3: dump-only memory yardsticks **0/4 → 4/4** (n=3 both models). Iter5: `memory_summary_needle` **0/6 → 6/6** per model; `memory_archive_needle` **0/6 → 6/6** per model. Final sweep memory dimension **16/16** on every model (n=2 × 8 memory scenarios, including summary + archive). Iter7 FTS yardstick `memory_search_chats_fts`: lexical `--no-fts-chats` **0/9** → FTS **9/9** (n=3 × kimi / v4-pro / flash); existing `memory_search_chats` still **true** on every 21-suite run.

| vs | rank | one-line |
|---|---|---|
| Hermes | **matches** | Atlas matches/exceeds Hermes on over-cap MEMORY.md (Hermes does not auto-summarize) and on FTS-ranked fact search + archive; iter7 closed the session-search lag — live lexical 0/9 vs FTS 9/9 on a buried transcript needle. |
| OpenClaw | **exceeds** | OpenClaw session/workspace files are not a measured FTS+recency+archive+LLM-summary stack; Atlas retrieval yardsticks are live-proven. |
| Nakama | **exceeds** | Nakama dumped MEMORY.md; Atlas bounds, retrieves, summarizes omitted facts, indexes `memory-archive/`, and FTS-ranks `search_chats`. |

### 4. Skill learning / consolidation

**Atlas.** `runSkillLearningTurn` (`packages/agent/src/skill-learning-loop.ts`) after `createAgentChatSession.send`. Signals: unknown tool, requested unassigned snake_case, `no_progress`/`iteration_limit`, tool error, taught SOP (`collectSkillLearningSignals` in `packages/core/src/skills/learning-signals.ts`). Distill: `generateSkillPostTurnReview` then `distillFallbackSkill`. Merge: `consolidateSkillLearningOutcome` (`packages/core/src/skills/learned-skill.ts`). Inject: `matchSkillsForMessage` + `createFts5SkillRanker` + `composeMatchedSkillsPrompt`. Product default **off**. AgentService enables only when post-turn review is opted in, `manage-skills` is assigned, channel is web/cli (`skillLearningAllowedOnChannel`), and the principal is not a guest. Write-approval stages via `createSkillsServiceLearningStore`. `/learn` remains user-invoked. This is the **opt-in** Nakama-shaped gate, not Hermes always-on. Operators can turn it on for Super Agent on web/cli (Super Agent typically has `manage-skills`; set org/profile `skillsPostTurnReview`). There is **no** hardcoded Super-Agent default-on in code.

**Live evidence.** Iter4: two-phase yardsticks **0/6 → 6/6** per model with `--skill-learning`. Final sweep learning **4/4** per model (n=2 × 2 scenarios) with skill-learning ON.

| vs | rank | one-line |
|---|---|---|
| Hermes | **partial** | Closed loop is live-proven, but Hermes review is always-on (with optional write-approval); Atlas stays default-off by policy. |
| OpenClaw | **partial** | OpenClaw’s public skill registry is broader; Atlas has a measured distill→consolidate→match loop OpenClaw does not claim as a post-turn learner. |
| Nakama | **exceeds** | Same review JSON + curator idea; Atlas actually applies/consolidates and injects into a **new** session (eval 0→1), whereas Nakama’s default path persisted suggestions. |

### 5. Compaction

**Atlas.** `compactHistory` (`packages/agent/src/history-compaction.ts`) emits a fixed Markdown template (Goal / Constraints / Progress / Decisions / Next Steps / Critical Context / Relevant Files). Triggered on token overflow (or `force`). ChatGPT subscription bypasses Atlas compaction (`ProviderClient.managesContext`). Compacted archives are indexed into `conversation_messages_fts` and ranked with live messages in `search_chats` (iter7).

**Live evidence.** Iter7 FTS yardstick proves BM25 session search over a large transcript (lexical miss inside the result limit). Production search SQL unions `session_messages` with `session_history_archives`. Long-session MEMORY.md needles still passed in the final sweep; `memory_search_chats` still passes with FTS on.

| vs | rank | one-line |
|---|---|---|
| Hermes | **matches** | Structured summaries plus FTS over live and compacted archives; Hermes also recalls via FTS rather than trusting the summary alone. |
| OpenClaw | **matches** | Both compact long sessions; neither was live-compared on the OpenCode Go yardsticks. |
| Nakama | **matches** | Same `compactHistory` template lineage; Atlas now FTS-indexes the archives Nakama left lexical. |

### 6. Channel awareness

**Atlas.** Format rules for WhatsApp/Telegram/Discord in `MESSAGING_CHANNEL_PROMPT`. Iter6 plumbed `chatKind` from `externalPrincipal.channelIsGroup` through `AgentService.buildChatSession` / `createAgentChatSession` into `buildChatSystemPrompt`. Private: `PRIVATE_CHAT_KIND_GUIDANCE`. Group: `GROUP_CHAT_KIND_GUIDANCE`. Unset kind still uses `messagingUnsetAudienceLine`. Iter7 persists `sessions.chat_kind` (`private` \| `group`) and reloads it on cold rebuild (`parseStoredChatKind`).

**Live evidence.** Iter6: prompt checks **0/24 → 24/24**; live pass **0/12 → 9/12** strong and **10/12** weak. Final sweep: every private prompt check true; group extras passed every full run; private **reply** name-addressing remains (WhatsApp private kimi/v4-pro/flash 1/3, glm 0/3; Telegram private v4-pro/glm 0/3, kimi 3/3).

| vs | rank | one-line |
|---|---|---|
| Hermes | **matches** | Both tag messaging sessions and style for the channel; Atlas now has explicit private vs group prompt blocks with live prompt proof. |
| OpenClaw | **partial** | Atlas matches format+kind **prompts**; OpenClaw’s bindings, mention gating, and group policy are a broader gateway, not a prompt-quality win we claim. |
| Nakama | **matches** | Nakama already had `chatKind` in `buildChatSystemPrompt`; Atlas passes it from workers and persists it on the session row. Residual is model reply-style, not missing prompt text. |

### 7. Multi-tenant / policy / sandbox

**Atlas.** Orgs isolate profiles/sessions/tools (`org_id`; `apps/server/src/http/org-middleware.ts`, `org-guards.ts`, `requireNotViewer`). Tool workspace is `buildToolExecutionContext` (`packages/core/src/tools/context.ts`) → profile soul dir. Linux Landlock policy `linux-landlock-abi3-v2` (`apps/server/src/services/restricted-process.ts` / `restricted-process-admission.ts`). `ATLAS_PROCESS_NETWORK=deny` is macOS-enforced; invalid/deny-without-enforcement fails closed. Assigned-tool roster is the session tool policy. Guest principals get a confined tool set (`channel-guest-tool-policy.ts`).

**Live evidence.** Not a quality-yardstick dimension. Transport + assigned catalog are the eval proxies. OpenClaw policy breadth was not live-scored.

| vs | rank | one-line |
|---|---|---|
| Hermes | **exceeds** | Hermes is profile-home scoped, not multi-tenant orgs with RBAC, Landlock, and guest tool confinement. |
| OpenClaw | **gap** | OpenClaw gateway tool-policy, skill trust tiers, docker sandbox scopes, and channel bindings are broader than Landlock + assigned roster. |
| Nakama | **matches** | Same org/RBAC/sandbox lineage; Atlas did not regress it for harness work. |

---

## Compact verdict table

| capability | vs Hermes | vs OpenClaw | vs Nakama |
|---|---|---|---|
| Prompt assembly | matches | exceeds | exceeds |
| Tool loop + hallucination | matches | partial | exceeds |
| Memory retrieval/summary | matches | exceeds | exceeds |
| Skill learning | partial | partial | exceeds |
| Compaction | matches | matches | matches |
| Channel awareness | matches | partial | matches |
| Multi-tenant / policy / sandbox | exceeds | gap | matches |

---

## Known residuals (classified)

| residual | class | evidence |
|---|---|---|
| (a) Assigned-decoy `tool_avoid_wording_trap` on strong models | **model-limitation** | kimi **0/3** final sweep (only `lookup_ticket_live`); glm 0/3. Purpose roster + “choose by purpose” (iter6) did not move kimi. **Counterexample:** `deepseek-v4-pro` **3/3** called `lookup_ticket` only — harness can surface the distinction; kimi still follows the user-named assigned stub. |
| (b) Strong-model private reply-style (`channel_telegram_private` / WhatsApp private) | **model-limitation** | Prompt checks **always true**. Failures are `reply_does_not_address_asker` (name / “tell Jordan”). v4-pro Telegram private **0/3**; kimi Telegram private **3/3**. Not missing `PRIVATE_CHAT_KIND_GUIDANCE`. |
| (c) Skill-learning default-off | **deliberate-policy** | Matches Nakama opt-in; Hermes is always-on. Eval `--skill-learning` forces the session flag. Super Agent web/cli can enable it by opting in post-turn review + assigned `manage-skills` — not hardcoded on. |
| (d) `chatKind` persisted to SQLite | **closed (iter7)** | `sessions.chat_kind`; adapter load + `AgentService` cold-rebuild unit test. |
| (e) Compacted / session `search_chats` FTS | **closed (iter7)** | FTS5 BM25 + recency over authorized live+archive candidates; lexical fallback. Live yardstick lexical **0/9** → FTS **9/9**. |
| (f) OpenClaw gateway-policy breadth | **deliberate-policy** / product-scope | Per-channel allow/deny, skill trust tiers, docker sandbox scopes. Atlas uses org RBAC + assigned tools + Landlock. Not a quality-loop item we tried to close. |

Related, not in the required list: LLM continuity-summary cache is process-local LRU (cost, not a failed yardstick); `memory_write` exact-reuse is a product invariant; allowlist-off cannot live-induce an unassigned tool call because native schemas also omit the name.

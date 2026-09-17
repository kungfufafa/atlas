# Goal audit — Atlas harness vs Hermes / OpenClaw / Nakama

Goal: make the Atlas agent harness **match or exceed** Hermes Agent, OpenClaw, and Nakama on four quality dimensions, **proven by live OpenCode Go evals**.

This audit treats completion as unproven until each requirement has current-state evidence. Rankings are about **response quality** (tool hallucination, multi-step, context, long-session), not OpenClaw’s gateway surface or Hermes’ public skill registry size.

Path: `createAgentHarness.createChatSession.send` → `buildChatSystemPrompt` + `generateReply` + `executeToolCall`. Full-harness config = allowlist, work-rules, native schemas, memory retrieval + summarization + archive index, chatKind, skill-learning ON.

Sources: `docs/harness/gap-analysis.md`, `docs/harness/eval-results/iter{1,2}-summary.json`, `iter{3,4,5,6,7}-summary.md`, `ablation-summary.md`, `docs/harness/eval-results/final-sweep-summary.md`.

---

## Dimension 1 — Context-awareness

**What the goal needs.** The model should use soul/USER.md, the right channel register, retrieved memory (not a stale dump), and matched skills when they exist.

**Harness work that landed.**

| iter | change | live proof |
|---|---|---|
| 1 | `x-opencode-session` so the real loop can run | 0/8 → 8/8 including `memory_recall` + WhatsApp |
| 3 | Bounded MEMORY.md + FTS/recency `memory_search` | memory yardsticks 0/4 → 4/4 (n=3 both models) |
| 5 | LLM summary of omitted facts + production archive index | `memory_summary_needle` 0/6 → 6/6; archive 0/6 → 6/6 per model |
| 6 | `chatKind` private vs group into `buildChatSystemPrompt` | prompt checks 0/24 → 24/24 |
| 7 | Persist `chatKind` on `sessions.chat_kind`; FTS `search_chats` | unit reload; FTS yardstick 0/9 → 9/9 |
| 4 | Learned skills match/inject on a **new** session | learning extras 0/6 → 6/6 per model |

**Final sweep.** Memory dimension **16/16** on all four models (n=2). Learning inject **4/4**. Group channel extras passed every full run. Private **prompt** checks always true; private **reply** name-addressing still fails often (see caveats).

**Verdict.**

| vs | equal-or-better? | caveat |
|---|---|---|
| Nakama | **yes, exceeds** | Nakama dumped MEMORY.md and had `chatKind` in the prompt helper but not plumbed; Atlas bounds, retrieves, summarizes, and fires private/group blocks. |
| Hermes | **yes** | Over-cap MEMORY.md + FTS fact search + archive **meet or beat** Hermes’ frozen MEMORY.md (Hermes does not auto-summarize). Iter7 closed **session FTS** (`search_chats` lexical 0/9 → FTS 9/9). |
| OpenClaw | **yes, on this dimension** | Measured retrieval/channel prompts exceed a generic workspace dump. Not a claim about OpenClaw routing/bindings. |

**Still short.** Private replies still name-address (model-limitation; prompts are correct). No remaining context-awareness harness gap vs Hermes session search.

---

## Dimension 2 — Tool-hallucination reduction

**What the goal needs.** Do not invent tools; do not substitute a wrong assigned tool; prefer purpose over a user-named lookalike.

**Harness work that landed.**

| iter | change | live proof |
|---|---|---|
| 2 | `# Assigned tools` roster | 12/12 before **and** after on kimi — **no measured delta** on that strong model |
| hardening | ablation × weak model + wording trap | allowlist alone = 0 delta; allowlist+work-rules flipped flash absent-web 15/17 → 16/17; wording trap failed **8/8** cells |
| 6 | purpose: lines + unassigned-decoy extra | unassigned **6/6**; assigned decoy kimi **0/3** (classified model-limit) |

**Final sweep (full harness).** Unassigned decoy **8/8**. Hallucinated `nuke_database` held. Assigned decoy: kimi **0/3**, glm **0/3**, flash **1/3**, **v4-pro 3/3**. Absent-web substitutes: glm **0/3**, flash **2/3**, both strong models **3/3**. glm extra `write_note`/`search_kb` on channel cells pulls precision down (0.770) with recall 1.000.

**Verdict.**

| vs | equal-or-better? | caveat |
|---|---|---|
| Nakama | **yes, exceeds** | Same unknown-tool recovery; Atlas adds a roster, work-rules, and live unassigned-decoy proof. |
| Hermes | **matches, not a clean exceed** | Unassigned invention is solved. Assigned user-named decoys still fool kimi (Hermes is not proven better on that exact trap). Hermes always-on learning may reduce repeats over calendar time; Atlas learning is opt-in. |
| OpenClaw | **partial** | OpenClaw can **omit** a tool from the gateway catalog. Atlas still sends native schemas, so an assigned decoy is callable. Policy breadth is residual (f). |

**Still short.** Assigned-decoy on kimi is **not** a remaining harness prompt bug (iter6 already tried). Mid-model substitute-tool calls (`tool_avoid_absent_web_search`) are model-limit / work-rules leverage, not a missing allowlist line. Do not lengthen the roster to chase kimi.

---

## Dimension 3 — Multi-step reasoning

**What the goal needs.** Ordered tool use (lookup → note, lookup → KB, 3-hop lookup → KB via escalationKey → note) and reuse of a taught procedure next session.

**Harness work that landed.** Iter1 `multi_step_lookup_note` 8/8 after transport. Iter2 `multi_step_ticket_and_kb`. Hardening `multi_step_three_hop`. Iter4 two-phase SOP + unknown-tool recovery.

**Final sweep.** Multi-step **6/6** on all four models (n=2). Learning **4/4** on all four with `--skill-learning`. 3-hop included.

**Verdict.**

| vs | equal-or-better? | caveat |
|---|---|---|
| Nakama | **yes** | Same tool loop; Atlas adds a live 3-hop + closed learning that Nakama review did not apply by default. |
| Hermes | **yes, on measured hops** | 3-hop and SOP replay are live-perfect here. Hermes’ always-on skill write may accumulate more procedures in the wild; that was not a failed Atlas yardstick. |
| OpenClaw | **yes, on measured hops** | No evidence OpenClaw’s loop is stronger on lookup→KB→note. Ecosystem size is not multi-step quality. |

**Still short.** Nothing required on this dimension is failing the live suite. Learning remains opt-in in product (policy residual c).

---

## Dimension 4 — Long-session behavior

**What the goal needs.** Over-cap continuity without dumping the ledger; recover omitted/archived/cross-session facts; compact without losing the thread.

**Harness work that landed.**

| iter | change | live proof |
|---|---|---|
| 3 | Bound + `memory_search` / `search_chats` | overflow omitted from prompt and recovered; recency Lisbon over Berlin; dossier via `search_chats` |
| 5 | LLM summary of omitted + archive files | vault hint only via summary; badge only via `YYYY-MM.md` parser |
| 7 | FTS5 BM25 `search_chats` over live + compacted archives | `memory_search_chats_fts` lexical 0/9 → FTS 9/9 (n=3 × 3 models) |
| (pre-existing) | `compactHistory` structured Markdown | now FTS-backed via `conversation_messages_fts` + authorized-candidate ranking |

**Final sweep.** All memory long-context cells passed (bounded dump, 90-bin needle, summary needle, archive, recency, search_chats) — **16/16** memory runs per model. Iter7 re-confirmed `memory_search_chats` on the 21-suite (3/3 models) and added a discriminator that lexical ranking fails.

**Verdict.**

| vs | equal-or-better? | caveat |
|---|---|---|
| Nakama | **yes, exceeds** | Dump-only MEMORY.md is the iter3 BEFORE (0/4). Atlas no longer does that. |
| Hermes | **yes** | MEMORY.md long-context, archive retrieval, and session FTS **match or exceed**. Hermes FTS5 over all session messages is no longer a live residual (iter7 0/9 → 9/9). |
| OpenClaw | **yes, on measured needles** | Not a claim about OpenClaw session stores. |

**Still short.** Residual (d) and (e) closed in iter7. Summarization cache is in-memory LRU (restart cost, not a failed needle).

---

## Cross-cutting live floor (final sweep)

Full 29 scenarios, n=2, skill-learning ON:

| model | passRate | 21-suite | memory | learning | 3-hop | assigned decoy (n=3) |
|---|---:|---|---|---|---|---|
| `kimi-k2.7-code` | 0.931 | 20/21 | 16/16 | 4/4 | pass | 0/3 |
| `deepseek-v4-pro` | 0.948 | **21/21** | 16/16 | 4/4 | pass | **3/3** |
| `glm-5.3` | 0.862 | 19/21 | 16/16 | 4/4 | pass | 0/3 |
| `deepseek-flash` | 0.897 | 20/21 then 19/21 | 16/16 | 4/4 | pass | 1/3 |

Transport failures: **0**. All full-suite fails are completed-behavior (private name-addressing, assigned decoy, glm/flash absent-web substitutes).

---

## Goal-level verdict

**Nakama: bar met (exceeds).** Atlas is that fork plus allowlist/purpose, bounded+FTS+summary memory, closed skill learning, and plumbed `chatKind`, each with before/after live deltas.

**Hermes: bar met on all four quality dimensions; remaining difference is always-on learning policy, not unimplemented session FTS.** Context (MEMORY.md path + session FTS), multi-step, and unassigned-tool hallucination match or exceed measured Hermes analogues. Hermes always-on review is an Atlas policy choice, not a missing loop.

**OpenClaw: bar met on the four quality dimensions as scored; not met as a gateway-policy product.** Tool-loop, memory needles, multi-step, and channel prompts are live-proven. Residual (f) is explicit: we did not build OpenClaw’s allow/deny/skill-trust/bindings language, and we should not claim it.

**Equal-or-better overall?** **Yes for the stated quality bar against Nakama, and yes against Hermes on the four quality dimensions.** **No** if the bar is silently expanded to OpenClaw gateway-policy parity or Hermes always-on defaults.

### Harness work that still remains (only if we keep going)

1. Persist `chatKind` — **done (iter7)**. Residual (d) closed.
2. FTS-index conversation / compacted archives for `search_chats` — **done (iter7)**. Residual (e) closed; live lexical 0/9 → FTS 9/9.
3. Do **not** keep iterating assigned-decoy prompt text — residual (a) is model-limit (`v4-pro` already passes).
4. Do **not** default skill learning on globally — residual (c) is policy; Super Agent web/cli remains the opt-in.
5. Do **not** treat OpenClaw policy breadth as a quality iteration — residual (f).

No further prompt-length work is justified by the final sweep. No measurable Hermes **harness-gap** remains on the four quality dimensions.

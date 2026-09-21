# Goal audit — Atlas harness vs Hermes / OpenClaw / Nakama

This historical harness audit covers four Atlas quality dimensions using OpenCode Go evals through **2026-09-18**. The current goal prioritizes **Nakama, then OpenClaw, then Hermes Agent**, including stability, maintainability, and user journeys; these four dimensions cover only part of that goal.

**Cross-system parity and goal completion are unproven.** The reference systems were not live-tested in these experiments. Atlas ablations show changes on the recorded fixtures, not equal or better reference behavior. New model proof must use the goal's `https://router.rizqis.com/v1` endpoint; the older OpenCode Go results remain historical evidence. Retaining an Atlas difference also requires evidence of its user journey and how that journey can be shortened.

Path: `createAgentHarness.createChatSession.send` → `buildChatSystemPrompt` + `generateReply` + `executeToolCall`. Full-harness config = allowlist, work-rules, native schemas, memory retrieval + summarization + archive index, chatKind, FTS chats, skill-learning ON.

Sources: `docs/harness/gap-analysis.md`, `docs/harness/eval-results/iter{1,2}-summary.json`, `iter{3,4,5,6,7}-summary.md`, `ablation-summary.md`, `docs/harness/eval-results/final-sweep-summary.md`, `docs/harness/eval-results/final-verification-summary.md` (2026-09-18 live re-run). Neither dated sweep is current-goal proof. The harness path does not boot `AgentService`, org middleware, or tenant SQLite `memory_write`; it is not a full product or user-journey evaluation.

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
| 7 | Persist `chatKind` on `sessions.chat_kind`; FTS `search_chats` | unit reload; iter7 lexical 0/9 → FTS 9/9; **2026-09-18 verification lexical 0/6 → FTS 8/8** |
| 4 | Learned skills match/inject on a **new** session | learning extras 0/6 → 6/6 per model |

**Historical sweep (2026-09-18).** Memory dimension **18/18** on all four models (n=2 × 9 memory scenarios, including FTS). Learning inject **4/4**. Group channel extras **8/8**. Private **prompt** checks passed in these runs; private **reply** name-addressing still fails often (see caveats). Prior 2026-09-17 29-scenario sweep was 16/16 memory because `memory_search_chats_fts` was not in that suite.

**Verdict.**

| reference | quality parity | implementation observation / evidence limit |
|---|---|---|
| Nakama | **unproven** | Atlas adds bounded retrieval and channel plumbing to the shared prompt lineage; the Atlas before/after fixture is not a live Nakama comparison. |
| Hermes | **unproven** | Both have memory and session-retrieval mechanisms in the prior audit. Atlas's FTS fixture improved from lexical 0/9 to FTS 9/9; Hermes was not run on it. |
| OpenClaw | **unproven** | Atlas retrieval and channel fixtures passed as recorded; OpenClaw's corresponding behavior was not measured. |

**Still short.** Private replies still name-address despite the expected prompt being present. These small samples do not isolate model, prompt, or harness causes. Session FTS is implemented, but its presence does not close the comparative context-awareness question.

---

## Dimension 2 — Tool-hallucination reduction

**What the goal needs.** Do not invent tools; do not substitute a wrong assigned tool; prefer purpose over a user-named lookalike.

**Harness work that landed.**

| iter | change | live proof |
|---|---|---|
| 2 | `# Assigned tools` roster | 12/12 before **and** after on kimi — **no measured delta** on that strong model |
| hardening | ablation × weak model + wording trap | allowlist alone = 0 delta; allowlist+work-rules flipped flash absent-web 15/17 → 16/17; wording trap failed **8/8** cells |
| 6 | purpose: lines + unassigned-decoy extra | unassigned **6/6**; assigned decoy kimi **0/3** (cause unresolved) |

**Historical sweep (2026-09-18, full harness).** Unassigned decoy **8/8**. Hallucinated `nuke_database` held. Assigned decoy (n=2): kimi **0/2**, glm **0/2**, flash **2/2**, **v4-pro 2/2**. Absent-web substitutes: glm **1/2**, flash **0/2**, both strong models **2/2**. glm extra `write_note`/`search_kb` on channel cells pulls precision down (0.753) with recall 1.000. The 2026-09-17 n=3 noisy cells are historical; this verification used n=2 on the full 30.

**Verdict.**

| reference | quality parity | implementation observation / evidence limit |
|---|---|---|
| Nakama | **unproven** | Shared unknown-tool recovery; Atlas adds a roster and purpose lines. The recorded passes do not measure Nakama's behavior. |
| Hermes | **unproven** | Atlas passed the recorded unassigned-decoy cases and failed some assigned-decoy cases. Hermes was not evaluated on those cases or on repeated learning. |
| OpenClaw | **unproven** | The prior audit identified gateway catalog policies as an implementation difference. Atlas's assigned decoys remain callable; the policy difference does not establish relative response quality. |

**Still short.** Assigned-decoy and absent-tool substitution failures remain. One unsuccessful prompt intervention and successes on other models do not establish an intrinsic model limit or rule out harness improvements. Any further intervention needs a controlled, repeatable comparison.

---

## Dimension 3 — Multi-step reasoning

**What the goal needs.** Ordered tool use (lookup → note, lookup → KB, 3-hop lookup → KB via escalationKey → note) and reuse of a taught procedure next session.

**Harness work that landed.** Iter1 `multi_step_lookup_note` 8/8 after transport. Iter2 `multi_step_ticket_and_kb`. Hardening `multi_step_three_hop`. Iter4 two-phase SOP + unknown-tool recovery.

**Historical sweep (2026-09-18).** Multi-step **6/6** on all four models (n=2). Learning **4/4** on all four with `--skill-learning`. 3-hop **8/8**.

**Verdict.**

| reference | quality parity | implementation observation / evidence limit |
|---|---|---|
| Nakama | **unproven** | Shared tool-loop lineage; Atlas's 3-hop and learning fixtures passed. The prior Nakama implementation comparison is not a behavioral baseline. |
| Hermes | **unproven** | Atlas's 3-hop and SOP replay fixtures passed; Hermes was not tested on the same workflows or learning defaults. |
| OpenClaw | **unproven** | Atlas's lookup→KB→note fixture passed; no corresponding OpenClaw run was recorded. |

**Still short.** These sampled scenarios passed, but do not cover general multi-step reliability or operator journeys. Learning remains opt-in in product (policy residual c).

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

**Historical sweep (2026-09-18).** All memory long-context cells passed (bounded dump, 90-bin needle, summary needle, archive, recency, search_chats, FTS needle) — **18/18** memory runs per model. FTS ablation: lexical `--no-fts-chats` **0/6** → FTS **8/8**.

**Verdict.**

| reference | quality parity | implementation observation / evidence limit |
|---|---|---|
| Nakama | **unproven** | Atlas improved over its dump-only fixture (iter3 0/4 → 4/4); that fixture did not execute Nakama. |
| Hermes | **unproven** | Atlas now has session FTS and passed the recorded needles. A shared retrieval mechanism does not establish equivalent long-session behavior. |
| OpenClaw | **unproven** | Only Atlas ran the recorded memory needles; OpenClaw session-store behavior remains unmeasured here. |

**Still short.** The implementation work in residuals (d) and (e) landed in iter7. Repeated compaction, restart recovery, and corresponding reference journeys are not established by the needle results. Summarization cache is in-memory LRU.

---

## Historical live results (2026-09-18 verification)

Full **30** scenarios (21 default + 9 extras including FTS), n=2, skill-learning ON. **240** scenario-runs, **0** transport failures.

| model | passRate | 21-suite | memory | learning | 3-hop | assigned decoy (n=2) |
|---|---:|---|---|---|---|---|
| `kimi-k2.7-code` | 0.950 | 20/21 | 18/18 | 4/4 | pass | 0/2 |
| `deepseek-v4-pro` | 0.967 | **21/21** | 18/18 | 4/4 | pass | **2/2** |
| `glm-5.3` | 0.883 | 20/21 then 19/21 | 18/18 | 4/4 | pass | 0/2 |
| `deepseek-flash` | 0.950 | 20/21 | 18/18 | 4/4 | pass | **2/2** |

Transport failures: **0**. All full-suite fails are completed-behavior (private name-addressing, assigned decoy on kimi/glm, glm/flash absent-web substitutes).

Raw: `docs/harness/eval-results/final-verification-summary.md`. The 2026-09-17 29-scenario / 232-run sweep remains in `final-sweep-summary.md` as historical.

---

## Goal-level verdict

**Nakama: parity unproven.** The recorded Atlas changes include assigned-tool guidance, bounded memory, summary/retrieval, skill learning, and channel-kind plumbing. Before/after deltas support some Atlas fixture improvements; they do not establish a better Nakama user journey or equivalent product behavior.

**OpenClaw: parity unproven.** The Atlas fixtures do not measure OpenClaw's response quality, routing, or gateway policies. The prior audit records policy-scope differences that need a concrete user-journey comparison before deciding what Atlas should retain or simplify.

**Hermes: parity unproven.** Session FTS and learning are implemented in Atlas, but shared mechanisms and Atlas-only passes cannot establish equivalent context, learning, or multi-step quality. The consequences of differing learning defaults remain unmeasured.

**Equal-or-better overall? Unproven against all three references.** Current-goal proof needs pinned reference versions, comparable tasks and configurations, the mandated endpoint for model evaluation, and observed user journeys. The current goal is not complete on the basis of this historical audit.

### Follow-up evidence needed

1. Revalidate the historical fixtures on current Atlas using the mandated endpoint and record exact model/configuration evidence.
2. Compare pinned reference implementations, starting with Nakama, on corresponding tasks and default user journeys; do not substitute an Atlas ablation for a reference run.
3. Investigate assigned-decoy and private-reply failures without assuming their cause from these small samples.
4. Evaluate the journey to enable and use skill learning, and whether it can be shortened, before defending or changing the opt-in default.
5. Keep the completed `chatKind` persistence and FTS implementation work distinct from unproven cross-system quality claims.

This correction changes the interpretation of the historical evidence; it does not report a new product cycle or new model runs.

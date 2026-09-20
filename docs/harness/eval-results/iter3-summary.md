# Harness eval — iteration 3 (memory retrieval)

Generated: 2026-09-17T00:29:23.577Z

Strong model: `kimi-k2.7-code`
Weak model: `deepseek-flash`
Product-path flags: allowlist ON, work-rules ON, native schemas ON, memory-retrieval ON
Path: `createAgentHarness.createChatSession.send` (`buildChatSystemPrompt` + `generateReply` + `executeToolCall`)

## Question

Does bounded `MEMORY.md` injection plus shared FTS/lexical `memory_search` and `search_chats` move Hermes-style retrieval yardsticks from fail to pass without regressing the previous 16/17 suite?

## Design (maps to Hermes / Nakama)

Hermes: FTS5 over memories + LLM summarization/consolidation. Nakama: soul files including `MEMORY.md`. Atlas already had soul dump + exact-match DB `memory_write` + `search_chats` keyword scan.

This iteration:

| Piece | What landed | Hermes/Nakama analogue |
|---|---|---|
| Bounded injection | `composeContinuityMemorySection` in `composeSoulSystemPrompt`. Files under 8192 bytes are unchanged. Over cap: newest dated/preamble bullets + `memory_search` hint. | Hermes does not dump the whole ledger into the prompt. |
| Retrieval | `searchRankedMemories`: JS lexical score (existing `tokenizeMemoryQuery`) + in-memory FTS5 MATCH boost (mirrors `createFts5SkillRanker`) + recency collapse on `"X is Y"` slots. `MemoryService.searchMemories` uses this on authorized SQLite candidates. | Hermes FTS5 memory search. |
| Recency/conflict | Newer `updatedAt` wins for the same is-slot. Independent facts without a slot are not collapsed (preserves `memory_write` strategy `"preserve"`). | Hermes consolidation / corrected_fact family. |
| Cross-session | Eval `search_chats` calls production `ConversationKeywordSearch`. | Conversation retrieval already in Atlas; now on the live eval path. |
| Summarization | `summarizeContinuityMemoryWithModel` seam. Default injection is extractive recency, not a live OpenCode Go call per session. | Hermes LLM distill — seam only this iteration. |

## Memory yardsticks

| Id | What it requires |
|---|---|
| `memory_archive_needle` | Badge `QUARTZ-WALRUS-19` is only in the archive store, not injected `MEMORY.md`. |
| `memory_conflict_recency` | Stale `Berlin` in `MEMORY.md` vs newer store `Lisbon`. Correct answer is Lisbon. |
| `memory_search_chats` | Dossier `NIGHTINGALE-4` only in another transcript. |
| `memory_bounded_dump` | Overflow code `MANGROVE-DELTA-5` is in a 250-bin `MEMORY.md` dated 2024-01-01; the 2048-byte cap must omit it; retrieval must recover it. |

`--no-memory-retrieval` dumps `MEMORY.md` wholesale and omits `memory_search`/`search_chats`. That is the dump-only baseline.

## BEFORE (dump-only)

`kimi-k2.7-code`, n = 1, `--no-memory-retrieval`. File: `iter3-before-strong-dump-only.json`.

**0 / 4 passed.**

| Scenario | Result | Evidence |
|---|---|---|
| `memory_archive_needle` | fail | Called `search_kb`, did not recall `QUARTZ-WALRUS-19`. Prompt correctly omitted the badge. |
| `memory_conflict_recency` | fail | Replied `Berlin` from injected `MEMORY.md`. No retrieval. |
| `memory_search_chats` | fail | Called `search_kb`, did not recall `NIGHTINGALE-4`. |
| `memory_bounded_dump` | fail | Dump included the overflow code; model answered `MANGROVE-DELTA-5` from the prompt (`prompt_omits_overflow_code` false). This is the dump-only “success” we are trying to stop. |

meanScore 0.250, meanGradedScore 0.083.

## AFTER (bounded + retrieval)

Memory yardsticks, n = 3 (separate live runs).

| model | n | passRate | meanScore | meanGraded | notes |
|---|---:|---:|---:|---:|---|
| kimi-k2.7-code | 3 | 1.000 | 1.000 | 1.000 | 12/12 scenario-runs; precision 1 on every run |
| deepseek-flash | 3 | 1.000 | 1.000 | 0.958 | 12/12 passed; `memory_conflict_recency` also called `search_kb` (precision 0.5) on all three runs |

Every AFTER yardstick called the intended retrieval tool and returned the newer/archived value. The overflow code was omitted from the injected prompt.

## Full suite (no original-suite regression)

21 scenarios = previous 17 + 4 yardsticks. Product-path flags. n = 1.

| model | passed | failed | failed ids | original 17 |
|---|---:|---:|---|---|
| kimi-k2.7-code | 20 | 1 | `tool_avoid_wording_trap` | **16/17** (unchanged) |
| deepseek-flash | 20 | 1 | `tool_avoid_wording_trap` | **16/17** (product-default cell from iter2) |

`tool_avoid_wording_trap` still fails: `lookup_ticket_live` is in that scenario’s catalog, so native schemas advertise it. Strong called only the decoy; flash called decoy + live lookup. Same failure mode as the iter2 ablation matrix.

`memory_long_context_needle` still passes (90-bin file is under the 8192-byte cap). `memory_recall`, channel WhatsApp, and the assigned-tool allowlist section are unchanged for small souls.

`context_continuity` still passes on both models. Strong optionally called `write_note` (precision 0, same as iter2). Flash did not.

## Ablation context

The discriminating ablation for this iteration is **memory-retrieval ON vs OFF**, not allowlist × work-rules. Dump-only OFF is the BEFORE table. Product default ON is AFTER. Native schemas stayed ON (product path). Allowlist and work-rules stayed ON so the original 16/17 cell is comparable.

A full 8-cell allowlist × work-rules matrix was not re-run (21 scenarios × 8 cells). The published iter2 matrix remains the hallucination reference.

## Production path vs harness-faithful

Shared with production:

- `composeSoulSystemPrompt` → `composeContinuityMemorySection` (AgentService chat sessions now get bounded `MEMORY.md`)
- `searchRankedMemories` / FTS5 boost / recency collapse (`MemoryService.searchMemories` and `searchVisibleMemories`)
- `ConversationKeywordSearch` (eval `search_chats` and DB `searchConversationMessages`)

Eval-only / not AgentService:

- In-process fact + transcript store, not tenant SQLite or org ACLs
- No `memory_write` preserve path, no post-turn review, no org middleware
- LLM summarization seam (`summarizeContinuityMemoryWithModel`) is unit-tested with a stub; the live eval uses extractive bounding, not a per-turn OpenCode Go distill

## Recommended iteration 4

1. Wire the LLM consolidator into `AgentService.resolveProfileSystemPrompt` (or a background job when `MEMORY.md` grows), with a live eval that the injected text is a model summary rather than extractive newest-N.
2. Index profile `memory-archive/` files in production `memory_search`, not only DB rows (eval already searches parsed live + archive facts together).
3. Assigned-decoy `tool_avoid_wording_trap` (map user wording onto `lookup_ticket`, or refuse the preview). Still 0/N.
4. Unknown-tool / `no_progress` into post-turn skill review (still the remaining H-side P1).

## Files

- `docs/harness/eval-results/iter3-before-strong-dump-only.json`
- `docs/harness/eval-results/iter3-after-strong-memory-n{1,2,3}.json`
- `docs/harness/eval-results/iter3-after-weak-memory-n{1,2,3}.json`
- `docs/harness/eval-results/iter3-after-strong-full.json`
- `docs/harness/eval-results/iter3-after-weak-full.json`
- `docs/harness/eval-results/iter3-summary.json`

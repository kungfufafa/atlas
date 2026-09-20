# Harness eval — iteration 5 (LLM MEMORY.md summary + production archive index)

Generated: 2026-09-17T02:35:00.000Z

Strong model: `kimi-k2.7-code`
Weak model: `deepseek-flash`
Product-path flags: allowlist ON, work-rules ON, native schemas ON, memory-retrieval ON
Summarization ablation: `--no-memory-summarization` (extractive recency) vs `--memory-summarization` (LLM, product default when a provider exists)
Archive ablation: `--no-archive-index` vs `--archive-index` (product default ON)
Path: `createAgentHarness.createChatSession.send` (`buildChatSystemPrompt` + `generateReply` + `executeToolCall`)

## Question

Does wiring `summarizeContinuityMemoryWithModel` into the over-cap MEMORY.md path, plus indexing profile `memory-archive/` in production `memory_search`, move two Hermes-grade memory yardsticks from fail to pass without regressing 20/21 default and 22/23 with `--skill-learning`?

## Design (maps to Hermes FTS5 + summarization)

Hermes: FTS5 over memories plus LLM summarization/consolidation. Iteration 3 shipped bounded injection + FTS/recency `memory_search` but left summarization as a seam and archive search on DB rows only.

This iteration:

| Piece | What landed | Hermes analogue |
|---|---|---|
| Over-cap trigger | `composeSoulSystemPromptWithSummary` → `resolveContinuityMemorySummary` when UTF-8 bytes exceed the cap (eval 2048 for the yardstick; product 8192). Under-cap files are unchanged. | Hermes does not dump the whole ledger. |
| LLM distill | `summarizeContinuityMemoryWithModel` summarizes **omitted** facts via the session provider (`generateText`). Prompt keeps durable codes/hints verbatim and drops warehouse trivia. | Hermes LLM summarization. |
| Recent facts kept | Injected prompt = LLM summary of omitted set **plus** newest extractive bullets that still fit. Newest facts are never dropped. | Consolidation without losing the current window. |
| Cache | SHA-256 content hash + byte cap + prompt version (`continuityMemorySummaryCacheKey`). LRU `ContinuityMemorySummaryCache`. Unchanged MEMORY.md is not re-summarized every turn. | Cost bound. |
| Fallback | No model, `ATLAS_MEMORY_SUMMARIZATION=0`/`--no-memory-summarization`, empty model output, or throw → extractive recency (iter3 path). | Fail closed. |
| Production seam | `AgentService.resolveProfileSystemPrompt` supplies `client.generateText` when not guest and summarization is enabled. | Session provider, not a stub. |
| Archive parser | `parseMemoryArchiveFacts` / `loadMemoryArchiveFacts` / `loadProfileMemoryArchiveFacts` over `YYYY-MM.md` (legacy `data/memory-archive/` fallback). Mirrors skill archive file loading. | Hermes archive retrieval. |
| Archive ranking | `MemoryService.searchMemories` / `searchVisibleMemories` merge parsed archive rows (`source: "memory-archive"`) with SQLite candidates, then `searchRankedMemories` (lexical + FTS5 + recency). Disable with `indexProfileArchive: false`. | Hermes FTS5 memory search over archives. |
| Eval production path | `memory_archive_needle` writes a temp `YYYY-MM.md` and loads it through `loadMemoryArchiveFacts` (same parser as MemoryService), not the in-process `memoryFacts` dump. `--no-archive-index` skips that load. | Proves the product parser, not a parallel store. |

## Yardsticks

| Id | Discriminator | Default suite? |
|---|---|---|
| `memory_summary_needle` | Vault hint `CEDAR-FALCON-7` is dated 2024-01-01; 250 later warehouse-bin bullets squeeze it out of extractive recency. No tools. Pass requires the **injected prompt** to contain the hint (`prompt_contains_vault_hint`) and the reply to be the code. Extractive cannot pass. | Extra (not in 21) |
| `memory_archive_needle` | Badge `QUARTZ-WALRUS-19` lives only in `memory-archive/YYYY-MM.md`. Prompt omits it. Pass requires `memory_search` + recalling the badge. `--no-archive-index` searches live facts only. | In 21 (iter3) |

## BEFORE (extractive / no archive index)

n = 3 separate live OpenCode Go runs per model.

### Summarization off (`--no-memory-summarization`)

**0 / 6** scenario-runs on both models (12/12 fails).

| model | n | `memory_summary_needle` | passRate | meanScore | meanGraded |
|---|---:|---:|---:|---:|---:|
| kimi-k2.7-code | 3 | 0/3 | 0.000 | 0.333 | 0.778 |
| deepseek-flash | 3 | 0/3 | 0.000 | 0.333 | 0.778 |

Evidence: `prompt_contains_vault_hint` false on every run. Replies: “I don't see a vault passphrase hint…” / “No vault passphrase hint is present…”. Zero tool calls. The older durable fact is squeezed out of extractive recency and is not recovered.

### Archive index off (`--no-archive-index`)

**0 / 6** scenario-runs on both models (12/12 fails).

| model | n | `memory_archive_needle` | passRate | meanScore | meanGraded |
|---|---:|---:|---:|---:|---:|
| kimi-k2.7-code | 3 | 0/3 | 0.000 | 0.667 | 0.722 |
| deepseek-flash | 3 | 0/3 | 0.000 | 0.667 | 0.722 |

Evidence: `called_memory_search` true, `prompt_omits_archive_needle` true, `recalled_archive_badge` false. Replies: “No badge code found in durable or archived memory.” The production parser was not asked to load `YYYY-MM.md`.

## AFTER (LLM summary / archive index)

n = 3.

### Summarization on (`--memory-summarization`)

**6 / 6** scenario-runs on both models (12/12 passes).

| model | n | `memory_summary_needle` | passRate | meanScore | meanGraded |
|---|---:|---:|---:|---:|---:|
| kimi-k2.7-code | 3 | 3/3 | 1.000 | 1.000 | 1.000 |
| deepseek-flash | 3 | 3/3 | 1.000 | 1.000 | 1.000 |

Every AFTER run set `prompt_contains_vault_hint` true and replied `CEDAR-FALCON-7` with zero tools. The hint is absent from extractive injection and present only because the live OpenCode Go summarizer kept it from the omitted set. Delta: **0.000 → 1.000** (12/12 BEFORE fails, 12/12 AFTER passes).

### Archive index on (`--archive-index`, product default)

**6 / 6** scenario-runs on both models (12/12 passes).

| model | n | `memory_archive_needle` | passRate | meanScore | meanGraded |
|---|---:|---:|---:|---:|---:|
| kimi-k2.7-code | 3 | 3/3 | 1.000 | 1.000 | 1.000 |
| deepseek-flash | 3 | 3/3 | 1.000 | 1.000 | 1.000 |

Every AFTER run called `memory_search`, omitted the badge from the prompt, and replied `QUARTZ-WALRUS-19`. Hits come from `loadMemoryArchiveFacts` over a real `YYYY-MM.md` file. Delta: **0.000 → 1.000**.

## Full suite (no original-suite regression)

21 scenarios = previous 21, learning **off**, summarization **on**, archive index **on**. `memory_summary_needle` is extra and was not included. n = 1.

| model | passed | failed | failed ids | original 17 |
|---|---:|---:|---|---|
| kimi-k2.7-code | 20 | 1 | `tool_avoid_wording_trap` | **16/17** (unchanged) |
| deepseek-flash | 20 | 1 | `tool_avoid_absent_web_search` | **16/17** |

Strong still fails `tool_avoid_wording_trap` (`lookup_ticket_live` is in that scenario’s catalog). Flash passed wording-trap this run and called assigned substitutes on `tool_avoid_absent_web_search` — still 20/21, still 16/17 original. Same pattern as iter4.

`memory_bounded_dump` still passes with summarization ON: `prompt_omits_overflow_code` true and `MANGROVE-DELTA-5` recovered via `memory_search` (overflow bins are warehouse trivia the summarizer is told to drop). Memory retrieval 4/4 and WhatsApp channel checks held.

## Learning suite (no 22/23 regression)

23 scenarios = 21 + two learning yardsticks. Learning **on**, summarization **on**, archive index **on**. n = 1.

| model | passed | failed | failed ids |
|---|---:|---:|---|
| kimi-k2.7-code | 22 | 1 | `tool_avoid_wording_trap` |
| deepseek-flash | 23 | 0 | — |

Strong remains 22/23 (wording trap). Flash 23/23 this run: both learning yardsticks passed, wording-trap passed, absent-web passed. The required floor is 22/23; flash beating it is model variance, not a new product claim.

## Production path vs harness-faithful

Shared with production:

- `composeSoulSystemPromptWithSummary` / `resolveContinuityMemorySummary` / `summarizeContinuityMemoryWithModel`
- SHA-256 + byte-cap LRU cache; extractive fallback
- `AgentService.resolveProfileSystemPrompt` live `generateText` when not guest
- `loadMemoryArchiveFacts` / `loadProfileMemoryArchiveFacts` (`YYYY-MM.md`)
- `MemoryService.searchMemories` / `searchVisibleMemories` merge archive rows then `searchRankedMemories`
- `memory_search` tool passes `context.profileId`
- `ATLAS_MEMORY_SUMMARIZATION=0` kill switch

Eval-only / not AgentService:

- In-harness memory map, not tenant SQLite (archive eval still uses the **production file parser**)
- Eval `--memory-summarization` forces the session flag; product needs a resolvable provider client
- Eval writes a temp archive directory then deletes it; production reads `~/.atlas/orgs/{orgId}/profiles/{profileId}/memory-archive/`
- `memory_summary_needle` is eval-only (not in the 21-scenario product default)
- No org middleware, no write-approval, no `archive-profile-memory` mutation in the harness

## Recommended iteration 6

1. Assigned-decoy `tool_avoid_wording_trap` (map user wording onto `lookup_ticket`, or refuse the preview). Strong still 0/N on the 21-suite.
2. FTS-index compacted `search_chats` archives (still lexical `ConversationKeywordSearch`).
3. Persist LLM continuity summaries to disk (profile cache file) so process restarts reuse the hash, not only the in-memory LRU.
4. Optional org/profile flag for failure learning vs suggestion-only post-turn review (leftover from iter4).
5. Do not default interactive web/cli skill learning on without an explicit operator flag.

## Files

- `docs/harness/eval-results/iter5-summary-before-{strong,weak}-n{1,2,3}.json`
- `docs/harness/eval-results/iter5-summary-after-{strong,weak}-n{1,2,3}.json`
- `docs/harness/eval-results/iter5-archive-before-{strong,weak}-n{1,2,3}.json`
- `docs/harness/eval-results/iter5-archive-after-{strong,weak}-n{1,2,3}.json`
- `docs/harness/eval-results/iter5-after-{strong,weak}-full.json`
- `docs/harness/eval-results/iter5-after-{strong,weak}-learning.json`
- `docs/harness/eval-results/iter5-summary.json`

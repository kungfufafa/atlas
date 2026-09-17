# Live harness eval

Drives the real Atlas agent loop:

`createAgentHarness.createChatSession.send` → `buildChatSystemPrompt` + `generateReply` + `executeToolCall`

against OpenCode Go. This is the yardstick for harness iterations. Iteration 1–2
scored 12/12 on `kimi-k2.7-code` before *and* after because work-rules and
native tool schemas already constrained a strong model. Use the ablation flags
and weaker models below when you need a discriminating signal.

## Run

```bash
export PATH="$HOME/.bun/bin:$PATH"
source "$HOME/.opencode-go.env"   # OPENCODE_GO_API_KEY + OPENCODE_GO_BASE_URL
bun run atlas:harness-eval
bun run atlas:harness-eval -- --help
```

Do not print or commit the API key.

## Ablation flags

Defaults match the iteration-2 product path (all on). Each switch is independent.

| Flag | Env | Default | Effect |
|---|---|---|---|
| `--work-rules` / `--no-work-rules` | `HARNESS_EVAL_WORK_RULES=0\|1` | on | `appendRuntimeProfileRules` / `DEFAULT_AGENT_WORK_RULES` ("do not invent tools") |
| `--allowlist` / `--no-allowlist` | `HARNESS_EVAL_ALLOWLIST=0\|1` | on | `# Assigned tools` roster in `buildChatSystemPrompt` |
| `--memory-retrieval` / `--no-memory-retrieval` | `HARNESS_EVAL_MEMORY_RETRIEVAL=0\|1` | on | Bound MEMORY.md + `memory_search`/`search_chats` extras |
| `--memory-summarization` / `--no-memory-summarization` | `HARNESS_EVAL_MEMORY_SUMMARIZATION=0\|1` | on | LLM summary of omitted MEMORY.md facts (hash-cached); off is extractive recency |
| `--archive-index` / `--no-archive-index` | `HARNESS_EVAL_ARCHIVE_INDEX=0\|1` | on | Load profile `memory-archive/` files into `memory_search` |
| `--skill-learning` / `--no-skill-learning` | `HARNESS_EVAL_SKILL_LEARNING=0\|1` | **off** | Post-turn skill distill on `createAgentChatSession` (product default is off) |
| `--model <id>` | `HARNESS_EVAL_MODEL` | `kimi-k2.7-code` | OpenCode Go model id |
| `--native-schemas` / `--no-native-schemas` | `HARNESS_EVAL_NATIVE_SCHEMAS=0\|1` | on | Whether `generateChat`/`streamChat` receive native tool schemas |

Other flags: `--scenario <id>` (repeatable), `--prompt-only`, `--out <path>`,
`--matrix`, `--strong-model`, `--weak-model`, `--out-dir`.

CLI overrides env. Last duplicate flag wins.

### Native schemas

`--no-native-schemas` is an **eval-only** provider wrapper (`omitNativeToolSchemas`).
It does not change `packages/agent` production code. Atlas only executes
provider-emitted `toolCalls`, so stripping schemas typically prevents any tool
use. Keep schemas **on** for product-path measurements. A first-class
session option to omit schemas would require threading a new flag through
`sendMessage` / `runConversation` / `generateReply`; that is a larger refactor
than this eval wrap.

## Scoring

Each scenario still has binary `passed` (all checks true) and `score` (fraction
of checks — partial credit). Reports also include:

- `toolPrecision` / `toolRecall` from the scenario's `expectedTools` vs unique calls
- `gradedScore` = mean of check-fraction, precision, and recall

Avoidance scenarios have empty `expectedTools`: no calls → precision 1, recall 1;
any call → precision 0.

## Discriminating scenarios

Original ids are unchanged. Added in eval hardening, plus iteration-3 memory
retrieval yardsticks:

| Id | What it separates |
|---|---|
| `tool_select_near_duplicate` | `lookup_ticket` vs `lookup_ticket_by_title` |
| `multi_step_three_hop` | lookup → `search_kb` with ticket `escalationKey` → `write_note` in order |
| `memory_long_context_needle` | recall `SILVER-ORCHID-77` from a 90-bin MEMORY.md distractor list |
| `tool_avoid_wording_trap` | user says `lookup_ticket_live`; real tool is `lookup_ticket` |
| `tool_avoid_no_fit_lure` | `generate_image` / `send_email` requested; neither is assigned |
| `memory_archive_needle` | badge code only in the archive store; not in injected MEMORY.md |
| `memory_conflict_recency` | stale city in MEMORY.md vs newer store fact |
| `memory_search_chats` | dossier code only in another transcript (`search_chats`) |
| `memory_bounded_dump` | overflow code is in a huge MEMORY.md but omitted from the bounded injection |
| `memory_summary_needle` | vault hint is squeezed out of extractive recency and survives only via LLM summary |
| `learn_sop_acquisition` | two-phase: teach a quarantine-hold SOP, then a later session must follow it from a learned skill |
| `learn_unknown_tool_recovery` | two-phase: unknown `clearance_stamp` in phase 1; phase 2 succeeds only if a recovery skill was distilled |

`--memory-retrieval` (default) bounds MEMORY.md with the product composer and
attaches `memory_search` / `search_chats` that call the same
`searchRankedMemories` / `ConversationKeywordSearch` code as production.
`--no-memory-retrieval` dumps MEMORY.md wholesale and omits those tools (the
iteration-3 dump-only baseline). Live `memory_search` loads profile
`memory-archive/` files through `loadMemoryArchiveFacts` (the same parser
`MemoryService` uses) unless `--no-archive-index`. The in-harness store is not
SQLite/AgentService; it exercises those shared functions.

`--memory-summarization` (default on, matching production when a provider is
available) calls `resolveContinuityMemorySummary` with the live OpenCode Go
`generateText` path when MEMORY.md is over cap. Unchanged files are keyed by
content hash. `--no-memory-summarization` is extractive recency (the
iteration-3 over-cap path). `memory_summary_needle` is an extra yardstick, not
part of the 21-scenario default suite.

LLM continuity summarization is wired into `composeSoulSystemPromptWithSummary`
and `AgentService.resolveProfileSystemPrompt`. Disable with
`ATLAS_MEMORY_SUMMARIZATION=0`.

`--skill-learning` (default off, matching product) runs `runSkillLearningTurn`
after each `send()`. Learned SKILL.md files live in an in-harness store that
calls the same `parseSkillMarkdown` / `matchSkillsForMessage` /
`composeMatchedSkillsPrompt` / FTS5 ranker as production. Phase 2 is a **new
session** with that store and without phase-1 history. Write-approval staging
is production-only (`createSkillsServiceLearningStore`).

## Matrix

```bash
bun run atlas:harness-eval -- --matrix --out-dir docs/harness/eval-results
```

Runs `{allowlist off, on} × {work-rules off, on} × {strong, weak}` with native
schemas on. Writes per-cell JSON, `ablation-matrix.json`, and
`ablation-summary.md`. Default models: `kimi-k2.7-code` and `deepseek-flash`.

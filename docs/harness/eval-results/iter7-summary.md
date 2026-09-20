# Harness eval — iteration 7 (FTS session search + chatKind persistence)

Generated: 2026-09-17T04:25:00.000Z

Strong models: `kimi-k2.7-code`, `deepseek-v4-pro`
Weak model: `deepseek-flash`
Product-path flags: allowlist ON, work-rules ON, native schemas ON, memory-retrieval ON, summarization ON, archive-index ON, chatKind ON, FTS chats ON (except `--no-fts-chats` ablation), skill-learning OFF (except the learning suite)
FTS ablation: `--no-fts-chats` (weighted lexical `search_chats`) vs `--fts-chats` (FTS5 BM25 + recency, product default)
Path: `createAgentHarness.createChatSession.send` (`buildChatSystemPrompt` + `generateReply` + `executeToolCall`)

## Question

Does FTS5 ranking over conversation messages (and compacted archives) surface a cross-session fact that weighted-lexical ranking misses inside the result limit, and does `chatKind` survive a SQLite cold rebuild — without regressing default 20/21, memory 6/6, or learning 22/23?

## Design A — FTS session search (Hermes residual e)

Hermes Agent’s `session_search` is SQLite FTS5 over raw session messages. Atlas `search_chats` was weighted lexical (`ConversationKeywordSearch`, `matchMode: "keywords"`). The existing dossier yardstick (`memory_search_chats`) still passed lexically; that did not prove FTS.

| Piece | What landed |
|---|---|
| Persistent corpus | `conversation_messages_fts` virtual table (`tokenize='porter'`, fail-open without porter). Populated from live `session_messages` and compacted `session_history_archives` via indexer + backfill (`migrateConversationMessagesFts`). |
| Ranking | `searchRankedConversations` builds a **temp FTS5 MATCH** over **already-authorized** candidates (same org/profile/user/date/archive guards as before), then sorts FTS hits by BM25 rank, then lexical score, then recency. Persistent table is the Hermes-style corpus; BM25 is **not** computed on the shared table so IDF cannot leak across tenants. Same pattern as `searchRankedMemories` / `memory-rank-fts5.ts`. |
| Fallback | `fts: false` (`--no-fts-chats`) or FTS unavailable (`ftsRanks: null`) → existing `ConversationKeywordSearch`. |
| Contract | Default / omitted `matchMode` stays **literal** `LIKE`. Native `search_chats` still passes `matchMode: "keywords"`; keywords mode now FTS-ranks with lexical fallback. |
| Eval | `--fts-chats` (default) vs `--no-fts-chats`. Extra scenario `memory_search_chats_fts` is **not** in the 21. |

Discriminator (unit + live): 1 short needle `ZEPHYRIC-LOCKER-77` (“Zephyric cipher locker retrieval code”) plus 80 **more recent** long weekly-ops distractors that share the common terms (`zephyric`, `cipher`, `locker`, `code`, `retrieval`). Lexical term-presence + recency fills the limit (10) with distractors. FTS5 BM25 length-normalizes the short needle to rank 1.

## Design B — chatKind persistence (residual d)

Iteration 6 plumbed `chatKind` into `buildChatSystemPrompt` but stored it only on in-memory `StoredSession`. A process restart without `externalPrincipal.channelIsGroup` fell back to the unset audience line.

| Piece | What landed |
|---|---|
| Schema | `sessions.chat_kind TEXT` (`packages/db/sql/schema.sql`); migrate adds the column on legacy tables. |
| Write | `upsertSession` inserts `chat_kind` and `COALESCE(excluded.chat_kind, sessions.chat_kind)` so an omit does not wipe a stored kind. Org scope unchanged (`sessions.org_id`). |
| Parse | `parseStoredChatKind` accepts only `"private"` \| `"group"`. |
| Load | Adapter maps `row.chat_kind` onto `StoredSession.chatKind`. `AgentService` create writes it; rebuild/branch uses in-memory kind, then `parseStoredChatKind(record.chatKind)`. |
| Tests | SQLite reopen + `AgentService` cold rebuild both reload `"group"`. Not a live-eval score mover. |

## Yardstick

| Id | Discriminator | Default suite? |
|---|---|---|
| `memory_search_chats_fts` | Prompt omits `ZEPHYRIC-LOCKER-77`. Agent must `search_chats` and recall the code. Lexical ranking misses it inside limit 10; FTS returns it first. | Extra |
| `memory_search_chats` | Existing dossier needle — must still pass with FTS on (lexical was already enough). | In 21 |
| chatKind persistence | Unit only: stored session reloads `chatKind`. | n/a |

## BEFORE (`--no-fts-chats`)

n = 3 live OpenCode Go runs × 3 models. Every run called `search_chats`. Prompt omitted the needle (`prompt_omits_fts_needle` true). Models only saw weekly-ops checklist hits and did **not** recall `ZEPHYRIC-LOCKER-77`.

**0 / 9** (lexical FAIL on strong and weak).

| model | n | passed | passRate | meanScore | meanGraded | reply pattern |
|---|---:|---:|---:|---:|---:|---|
| kimi-k2.7-code | 3 | 0/3 | 0.000 | 0.667 | 0.778 | “No retrieval code recorded” / checklist only |
| deepseek-v4-pro | 3 | 0/3 | 0.000 | 0.667 | 0.722 | Weekly ops checklist; no code |
| deepseek-flash | 3 | 0/3 | 0.000 | 0.667 | 0.833 | Same checklist miss |

This is ranking, not tool-use: `called_search_chats` true on all 9. Lexical results never contained the needle inside the limit.

## AFTER (`--fts-chats`, product default)

n = 3.

**9 / 9** (FTS PASS). Every reply is `ZEPHYRIC-LOCKER-77`. Prompt still omits the needle. Typically one `search_chats` call (flash n3 used two).

| model | n | passed | passRate | meanScore | meanGraded |
|---|---:|---:|---:|---:|---:|
| kimi-k2.7-code | 3 | 3/3 | 1.000 | 1.000 | 1.000 |
| deepseek-v4-pro | 3 | 3/3 | 1.000 | 1.000 | 1.000 |
| deepseek-flash | 3 | 3/3 | 1.000 | 1.000 | 1.000 |

Delta: lexical 0/9 → FTS 9/9. The yardstick discriminates FTS from lexical; it is not a prompt-injection or MEMORY.md dump.

## Full suite (no original-suite regression)

21 scenarios = previous 21, learning **off**, FTS chats **on**. `memory_search_chats_fts` excluded. n = 1.

| model | passed | failed | failed ids | memory 6 | `memory_search_chats` |
|---|---:|---:|---|---|---|
| kimi-k2.7-code | 20 | 1 | `tool_avoid_wording_trap` | **6/6** | **true** |
| deepseek-v4-pro | **21** | 0 | — | **6/6** | **true** |
| deepseek-flash | 20 | 1 | `tool_avoid_wording_trap` | **6/6** | **true** |

Default floor **20/21** held. Memory **6/6** all models, including the existing `search_chats` dossier. Failures are the assigned-decoy wording trap (model-limitation; v4-pro still 21/21).

## Learning suite

Learning extras run separately with `--skill-learning` (same two yardsticks as the 23-scenario suite). Combined with the 21: **22/23** floor.

| model | 21-suite | learning extras | combined | notes |
|---|---|---|---|---|
| kimi-k2.7-code | 20/21 | **2/2** | **22/23** | wording_trap only |
| deepseek-v4-pro | 21/21 | **2/2** | **23/23** | — |
| deepseek-flash | 20/21 | 1/2 then **2/2** retry | **22/23** | first SOP `provider_error` (transport); retry both extras pass |

Flash SOP failure was `checks.completed=false` / `error=provider_error`, not a distill/match miss. Retry passed `learn_sop_acquisition` and `learn_unknown_tool_recovery`. Learning extras **2/2** all models after retry.

## Validation

- `bun run typecheck` — pass (`tsc --noEmit -p tsconfig.typecheck.json`)
- Focused `bun test` — **53 pass / 0 fail** across `packages/db/src/conversation-rank-fts5.test.ts`, `packages/db/src/session-chat-kind.test.ts`, `apps/server/src/services/agent-service-chat-kind.test.ts`, `scripts/harness-eval/run.test.ts`

Unit discriminator: lexical results are all `fts-distractor-*`; FTS rank-1 is `fts-needle` containing `ZEPHYRIC-LOCKER-77`. Fallback with `ftsRanks: null` matches lexical miss.

## Production path vs harness-faithful

Shared with production:

- `searchRankedConversations` on SQLite and in-memory adapters when `matchMode: "keywords"`
- Native `search_chats` still `matchMode: "keywords"` (now FTS + lexical fallback)
- Persistent `conversation_messages_fts` backfill/indexer on SQLite migrate/write
- Literal `matchMode` unchanged (`LIKE`)
- `sessions.chat_kind` upsert/load + `parseStoredChatKind`
- `AgentService` persist on create; reload on rebuild/branch from DB if the in-memory map is empty

Eval-only / not AgentService:

- `--no-fts-chats` forces lexical ranking in the in-harness `search_chats` tool; production keywords path defaults FTS on
- Extra `memory_search_chats_fts` is not in the 21
- In-harness chat store (not tenant SQLite / org ACLs); ranking function is the same
- Eval does not boot `AgentService` org middleware

## Remaining gaps (after this iteration)

Measurable **harness-gap** vs Hermes FTS session search: **closed**. `chatKind` SQLite persistence: **closed**.

Still open, not FTS/chatKind:

- Assigned-decoy `tool_avoid_wording_trap` on kimi/flash — **model-limitation** (`v4-pro` 21/21)
- Private reply name-addressing — **model-limitation** (prompts already correct, iter6)
- Skill learning default-off — **deliberate-policy** vs Hermes always-on
- OpenClaw gateway-policy breadth — **product-scope**, not a quality-loop item

## Files

FTS ablation JSON: `docs/harness/eval-results/iter7-fts-{before,after}-{kimi,v4pro,flash}-n{1,2,3}.json`

Regression: `iter7-after-{kimi,v4pro,flash}-full21.json`, `iter7-after-{kimi,v4pro,flash}-learning.json`, `iter7-after-flash-learning-retry.json`

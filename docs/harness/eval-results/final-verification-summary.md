# Harness eval — fresh final verification (2026-09-18)

Generated: 2026-09-18T06:38:00.000Z

This is a **new** live OpenCode Go measurement on `cursor/harness-iter7-bc7d` HEAD (`2ad8229899017f449c44131e505f80c7ed6f732d`), recorded on `cursor/harness-verify-bc7d`. It does **not** reuse the 2026-09-17 final-sweep JSON as proof.

Path: `createAgentHarness.createChatSession.send` (`buildChatSystemPrompt` + `generateReply` + `executeToolCall`)

Full-harness config (all features ON):

| Flag | State |
|---|---|
| `--allowlist` | ON |
| `--work-rules` | ON |
| native schemas | ON (product path) |
| `--memory-retrieval` | ON |
| `--memory-summarization` | ON |
| `--archive-index` | ON |
| `--chat-kind` | ON |
| `--fts-chats` | ON |
| `--skill-learning` | ON (eval override; product default is off) |

Suite: all **30** `EVAL_SCENARIOS` (21 default + 9 extras: `memory_summary_needle`, two learning yardsticks, four `chatKind` extras, `tool_avoid_unassigned_decoy`, `memory_search_chats_fts`). n = 2 full runs per model.

## Models

`GET https://opencode.ai/zen/go/v1/models` with `x-opencode-session` (no auth) returned **38** ids. Selected:

| class | id | why |
|---|---|---|
| strong | `kimi-k2.7-code` | Default eval model; iterations 1–7 |
| strong | `deepseek-v4-pro` | Second strong catalog model |
| mid | `glm-5.3` | Mid-tier; live on gateway (no substitute) |
| weak | `deepseek-flash` | Iterations 2–7 weak cell |

No model needed substitution.

## How the 240-run floor was counted

**240 scenario-runs = 4 models × n=2 × 30 scenarios.**

Counted as `sum(len(report.scenarios))` over the eight files:

`docs/harness/eval-results/final-verification/{kimi-k2.7-code,deepseek-v4-pro,glm-5.3,deepseek-flash}-n{1,2}.json`

Each row is one live `createChatSession.send` scenario (two-phase learning counts as one scenario-run). 8 × 30 = 240.

## Transport vs completed behavior

**Zero transport failures** on the 240 full-suite rows.

- `summary.transportOk` is **true** on all 8 reports (`session_transport` passed).
- **0** rows have an `error` field (`provider_error` / `missing_opencode_session` / `auth`).
- No `MissingSessionID`, no HTTP provider errors in scored rows.
- Wrapper retries (`/tmp/harness-eval-retry.py`) were **not** required on any full-suite file.

Ablation reports that omit `session_transport` report `transportOk: false` by construction (same reporter quirk as the 2026-09-17 n=3 noisy cells). Those BEFORE rows still have `error: null` and are completed-behavior fails.

## Typecheck + focused tests

| check | result |
|---|---|
| `bun run typecheck` | **pass** (`tsc --noEmit -p tsconfig.typecheck.json`) |
| `scripts/harness-eval/run.test.ts` | **48 pass / 0 fail** |
| `packages/agent/src/chat-prompt.test.ts` | **35 / 0** |
| `packages/core/src/soul/continuity-memory.test.ts` | **13 / 0** |
| `packages/db/src/memory-rank-fts5.test.ts` | **4 / 0** |
| `packages/db/src/conversation-rank-fts5.test.ts` | **2 / 0** |
| `packages/agent/src/skill-learning-loop.test.ts` | **9 / 0** |
| `packages/db/src/session-chat-kind.test.ts` | **2 / 0** |
| `apps/server/src/services/agent-service-chat-kind.test.ts` | **1 / 0** |
| `packages/core/src/soul/memory-archive-index.test.ts` | **4 / 0** |
| **focused total** | **118 pass / 0 fail** |

## Per-model scorecard (full 30, n = 2)

60 scenario-runs = 30 × 2. Means average those 60 rows.

| model | class | pass | passRate | meanScore | meanGraded | precision | recall | 21-suite n1 / n2 |
|---|---|---:|---:|---:|---:|---:|---:|---|
| `kimi-k2.7-code` | strong | 57/60 | 0.950 | 0.973 | 0.960 | 0.942 | 0.967 | **20/21**, **20/21** |
| `deepseek-v4-pro` | strong | 58/60 | 0.967 | 0.996 | 0.982 | 0.950 | 1.000 | **21/21**, **21/21** |
| `glm-5.3` | mid | 53/60 | 0.883 | 0.964 | 0.906 | 0.753 | 1.000 | 20/21, 19/21 |
| `deepseek-flash` | weak | 57/60 | 0.950 | 0.976 | 0.936 | 0.833 | 1.000 | **20/21**, **20/21** |

n=1 vs n=2 full 30:

| model | n1 | n2 | n1 fails | n2 fails |
|---|---:|---:|---|---|
| `kimi-k2.7-code` | 28/30 | 29/30 | Telegram private, assigned decoy | assigned decoy |
| `deepseek-v4-pro` | 29/30 | 29/30 | WhatsApp private | Telegram private |
| `glm-5.3` | 27/30 | 26/30 | both privates, assigned decoy | those plus absent-web |
| `deepseek-flash` | 28/30 | 29/30 | WhatsApp private, absent-web | absent-web |

`deepseek-v4-pro` is the only model that passed the default 21 **and** the assigned-decoy trap on both full runs. Flash also passed assigned-decoy on both full runs (2/2) but failed absent-web both times.

## Per-dimension rollup (n = 1+2 full 30)

Native eval dimensions (scenario `dimension` field):

| dimension | kimi | v4-pro | glm-5.3 | flash |
|---|---|---|---|---|
| transport | 2/2 | 2/2 | 2/2 | 2/2 |
| tool-selection | 8/10 | **10/10** | 8/10 | **10/10** |
| tool-avoidance | **10/10** | **10/10** | 9/10 | 8/10 |
| multi-step | **6/6** | **6/6** | **6/6** | **6/6** |
| memory | **18/18** | **18/18** | **18/18** | **18/18** |
| channel | 9/10 | 8/10 | 6/10 | 9/10 |
| learning | **4/4** | **4/4** | **4/4** | **4/4** |

Goal-dimension mapping (same 240 rows):

| quality dimension | evidence |
|---|---|
| context | memory **72/72**; group extras **8/8**; every private **prompt** check true |
| tool-hallucination | unassigned decoy **8/8**; `nuke_database` held; assigned decoy **4/8** (model split); absent-web **5/8** (mid/weak) |
| multi-step | **24/24** including 3-hop **8/8**; learning **16/16** |
| long-session | bounded dump, 90-bin needle, summary needle, archive, recency, `search_chats`, FTS needle all inside the **72/72** memory cells |

Memory 18/18 per model includes the iter7 FTS extra (`memory_search_chats_fts`) plus `memory_summary_needle` and `memory_archive_needle`. Learning 4/4 is both two-phase yardsticks × n=2.

Channel fails are **reply-style** (`reply_does_not_address_asker`). Every private-channel prompt check was true on every full-suite run. Group extras passed on every full-suite run.

Tool-selection fails on kimi / glm are `tool_avoid_wording_trap` (assigned decoy `lookup_ticket_live`). Unassigned-decoy extra: **8/8**.

Tool-avoidance fails: flash **0/2** on `tool_avoid_absent_web_search`; glm **1/2** (n1 pass, n2 `search_kb`/`write_note` substitutes). Strong models **4/4**.

glm precision 0.753 is extra `write_note` / `search_kb` on channel and avoidance cells, not missing required tools (recall 1.000).

## Key yardsticks — live BEFORE / AFTER

AFTER = the 8 full-harness reports above (same flags). BEFORE = dedicated ablation files under `docs/harness/eval-results/final-verification/ablations/`.

| yardstick | BEFORE | AFTER | delta |
|---|---|---|---|
| Memory retrieval (`--no-memory-retrieval` → retrieval) | **0/16** (4 ids × kimi/flash × n=2) | **32/32** (those 4 ids × 4 models × n=2) | 0 → full |
| LLM summarization (`--no-memory-summarization` → summary) | **0/4** (`memory_summary_needle` × kimi/flash × n=2); `prompt_contains_vault_hint` false | **8/8** | 0 → full |
| Archive index (`--no-archive-index` → index) | **0/4** (`memory_archive_needle` × kimi/flash × n=2) | **8/8** | 0 → full |
| FTS session search (`--no-fts-chats` → FTS) | **0/6** (`memory_search_chats_fts` × kimi/v4-pro/flash × n=2); every run called `search_chats`, omitted the needle, missed `ZEPHYRIC-LOCKER-77` | **8/8** (incl. glm) | 0 → full |
| Skill-learning loop (`--no-skill-learning` → learning) | **0/8** (2 ids × kimi/flash × n=2) | **16/16** (2 ids × 4 models × n=2) | 0 → full |
| Unassigned-decoy disambiguation | no 0/x BEFORE (native schemas also omit `lookup_ticket_live`) | **8/8** | full on product path |

Matching-model AFTER for retrieval on the same kimi/flash cells is **16/16**. Matching FTS AFTER on kimi/v4-pro/flash is **6/6**. Matching learning AFTER on kimi/flash is **8/8**.

## Residuals (completed behavior only)

| residual | class | this verification |
|---|---|---|
| Assigned-decoy `tool_avoid_wording_trap` | **model-limitation** | kimi **0/2**, glm **0/2**. **Counterexample:** v4-pro **2/2**, flash **2/2**. Prompt already lists purpose; do not prompt-game. |
| Private reply-style | **model-limitation** | Prompt checks **always true**. Failures are `reply_does_not_address_asker`. glm WhatsApp+Telegram private **0/2** each (stable). Others noisy (kimi Telegram 1/2; v4-pro WhatsApp 1/2 and Telegram 1/2; flash WhatsApp 1/2). Group extras **8/8**. |
| Mid/weak absent-web substitutes | **model-limitation** | flash **0/2**, glm **1/2**. Strong **4/4**. Work-rules already on. |
| Skill-learning default-off | **deliberate-policy** | Eval `--skill-learning` forces the flag. Product stays opt-in. |
| OpenClaw gateway-policy breadth | **deliberate-policy** | Not scored as a quality-loop item. |
| `chatKind` SQLite persistence | **closed (iter7)** | Unit: `session-chat-kind` + `agent-service-chat-kind`. |
| FTS `search_chats` | **closed (iter7)** | Live lexical **0/6** → FTS **8/8**. |

**No harness-gap remains** on the four quality dimensions. The only full-suite fails in this 240-run set are assigned-decoy, private name-addressing, and mid/weak absent-web substitutes.

## Files

Raw JSON: `docs/harness/eval-results/final-verification/`

- `{model}-n{1,2}.json` — full 30, skill-learning ON
- `ablations/memory-retrieval-before-{kimi,flash}-n{1,2}.json`
- `ablations/summary-before-{kimi,flash}-n{1,2}.json`
- `ablations/archive-before-{kimi,flash}-n{1,2}.json`
- `ablations/fts-before-{kimi,v4pro,flash}-n{1,2}.json`
- `ablations/learning-before-{kimi,flash}-n{1,2}.json`

Aggregate: `docs/harness/eval-results/final-verification-summary.json`

Artifact copy: `/opt/cursor/artifacts/harness_final_verification_summary.json`

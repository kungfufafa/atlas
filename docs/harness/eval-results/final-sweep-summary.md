# Harness eval — final multi-model live sweep

Generated: 2026-09-17T03:44:37.839Z

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
| `--skill-learning` | ON (eval override; product default is off) |

Suite: all 29 `EVAL_SCENARIOS` (21 default + 8 extras: `memory_summary_needle`, two learning yardsticks, four `chatKind` channel extras, `tool_avoid_unassigned_decoy`). n = 2 full runs per model. n = 3 on four noisy ids.

## Models

`GET https://opencode.ai/zen/go/v1/models` returned 38 ids (session header, no auth). Selected:

| class | id | why |
|---|---|---|
| strong | `kimi-k2.7-code` | Default eval model; iterations 1–6 |
| strong | `deepseek-v4-pro` | Second strong catalog model |
| mid | `glm-5.3` | Mid-tier; live on gateway (no substitute) |
| weak | `deepseek-flash` | Iterations 2–6 weak cell |

Smoke `--scenario session_transport` on all four: **4/4 transportOk**. No model needed substitution.

## Transport vs completed behavior

**Zero transport failures** on the 8 full 29-scenario runs (232 scenario-runs) and on the 16 n=3 noisy extras. No `MissingSessionID`, no HTTP provider errors, no `error` fields on scored rows.

The n=3 noisy JSON files report `transportOk: false` because they omit `session_transport`. That is a reporter construction, not a gateway fault. Completed-behavior scoring below is the only failure mode.

## Per-model scorecard (full 29, n = 2)

58 scenario-runs = 29 × 2. Mean metrics average those runs.

| model | class | pass | passRate | meanScore | meanGraded | precision | recall | 21-suite n1 / n2 |
|---|---|---:|---:|---:|---:|---:|---:|---|
| `kimi-k2.7-code` | strong | 54/58 | 0.931 | 0.970 | 0.961 | 0.948 | 0.966 | **20/21**, **20/21** |
| `deepseek-v4-pro` | strong | 55/58 | 0.948 | 0.993 | 0.986 | 0.966 | 1.000 | **21/21**, **21/21** |
| `glm-5.3` | mid | 50/58 | 0.862 | 0.951 | 0.907 | 0.770 | 1.000 | 19/21, 19/21 |
| `deepseek-flash` | weak | 52/58 | 0.897 | 0.965 | 0.954 | 0.897 | 1.000 | 20/21, 19/21 |

n=1 vs n=2 full 29:

| model | n1 | n2 | n1 fails | n2 fails |
|---|---:|---:|---|---|
| `kimi-k2.7-code` | 27/29 | 27/29 | WhatsApp private, assigned decoy | same |
| `deepseek-v4-pro` | 28/29 | 27/29 | Telegram private | WhatsApp + Telegram private |
| `glm-5.3` | 25/29 | 25/29 | both privates, absent-web, assigned decoy | same |
| `deepseek-flash` | 27/29 | 25/29 | WhatsApp private, assigned decoy | those plus Telegram private + absent-web |

`deepseek-v4-pro` is the only model that passed the default 21 **and** the assigned-decoy trap on both full runs.

## Per-dimension rollup (n = 1+2 full 29)

| dimension | kimi | v4-pro | glm-5.3 | flash |
|---|---|---|---|---|
| transport | 2/2 | 2/2 | 2/2 | 2/2 |
| tool-selection | 8/10 | **10/10** | 8/10 | 8/10 |
| tool-avoidance | **10/10** | **10/10** | 8/10 | 9/10 |
| multi-step | **6/6** | **6/6** | **6/6** | **6/6** |
| memory | **16/16** | **16/16** | **16/16** | **16/16** |
| channel | 8/10 | 7/10 | 6/10 | 7/10 |
| learning | **4/4** | **4/4** | **4/4** | **4/4** |

Memory 16/16 includes `memory_summary_needle` (LLM distill of `CEDAR-FALCON-7`) and `memory_archive_needle` (`QUARTZ-WALRUS-19` via production `loadMemoryArchiveFacts`). Learning 4/4 is both two-phase yardsticks × n=2. Multi-step includes the 3-hop.

Channel fails are **reply-style** (`reply_does_not_address_asker`). Every private-channel prompt check was true on every run (n=1, n=2, n=3). Group extras passed on every full-suite run.

Tool-selection fails on kimi / glm / flash are `tool_avoid_wording_trap` (assigned decoy `lookup_ticket_live`). Unassigned-decoy extra: **8/8** on n=1+2 (all models, both runs).

Tool-avoidance fails: glm **0/2** on `tool_avoid_absent_web_search` (`write_note` / `search_kb` substitutes). Flash **1/2** (n1 pass, n2 `search_kb`). Strong models **4/4**.

glm precision 0.770 is extra `write_note` / `search_kb` on channel and avoidance cells, not missing required tools (recall 1.000).

## Noisy scenarios (n = 3)

| scenario | kimi | v4-pro | glm-5.3 | flash |
|---|---|---|---|---|
| `channel_whatsapp_private` | 1/3 | 1/3 | 0/3 | 1/3 |
| `channel_telegram_private` | **3/3** | 0/3 | 0/3 | 1/3 |
| `tool_avoid_wording_trap` | 0/3 | **3/3** | 0/3 | 1/3 |
| `tool_avoid_absent_web_search` | **3/3** | **3/3** | 0/3 | 2/3 |

Honest variance:

- Assigned decoy is **stable** on kimi (0/3, only `lookup_ticket_live`) and glm (0/3, decoy + canonical). It is **solved** on `deepseek-v4-pro` (3/3, `lookup_ticket` only). Flash is noisy (1/3). This is a **model-judgment** split, not a missing roster line (iter6 purpose instruction did not move kimi).
- Private name-addressing is noisy on WhatsApp for kimi/v4-pro/flash and **stable-fail** on Telegram for v4-pro and glm. Prompt plumbing is not the residual.
- Absent-web substitute calls are a **mid/weak** pattern (glm 0/3, flash 2/3). Strong 6/6.

## What held on every model, every full run

- Transport
- Memory retrieval + recency + bounded dump + archive + LLM summary needle
- Learning SOP + unknown-tool recovery (skill-learning ON)
- Multi-step 2-hop and 3-hop
- Unassigned close-name decoy
- Group WhatsApp + Telegram `chatKind` extras
- Hallucinated `nuke_database` refusal (in the 21)

## Files

Raw JSON under `docs/harness/eval-results/final-sweep/`:

- `smoke-{model}.json`
- `{model}-n{1,2}.json` (full 29)
- `{model}-n3-noisy.json` (four noisy ids)
- Aggregate: `docs/harness/eval-results/final-sweep-summary.json`
- Artifact copy: `/opt/cursor/artifacts/harness_eval_final_sweep_summary.json`

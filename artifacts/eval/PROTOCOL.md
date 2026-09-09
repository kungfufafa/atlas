# Atlas vs Hermes — pre-registered live comparison

Frozen before any scored run. Do not change this file after the first scored
cell except to append a dated amendment that does not drop cells after seeing
scores.

**Date (UTC):** 2026-09-09T03:25:13.579Z (roster fetch) / 2026-09-09 protocol lock  
**Claim scope:** equal or better **only** on the registered matrix below.  
Not a universal superiority claim. Not a leaderboard of winners only.

## Pins (recorded before scored runs)

| Pin | Value |
|---|---|
| Atlas branch | `cursor/opencode-go-eval-12be` cut from `main` |
| Atlas main SHA | `3eb1551dfe63ce4e3b6646129f30c3191bd413d4` |
| Atlas dirty tree at pin | clean (`git status --porcelain` empty) |
| Hermes repo | https://github.com/NousResearch/hermes-agent |
| Hermes release | v0.21.1 / tag `v2026.9.7` |
| Hermes SHA | `2237be355906fbe6065ce1815711eee52b2d646e` |
| Hermes checkout | `git clone https://github.com/NousResearch/hermes-agent.git /tmp/atlas-eval/hermes-agent && git checkout v2026.9.7` |
| Provider | OpenCode Go only for scored LLM calls |
| Chat base | `https://opencode.ai/zen/go/v1` |
| Auth | `Authorization: Bearer $OPENCODE_GO_API_KEY` (env only; never written to repo, commits, logs, artifacts, or reports) |
| Roster file | `artifacts/eval/model-roster.json` |
| Roster hash | `da388a47c29410f71ea719088fd7684a7e74adde62329ada43e3c3746827c188` (SHA-256 of JSON array of snapshot `apiId`s in listed order) |
| Roster fetch | `GET https://opencode.ai/zen/go/v1/models` with authorized key, HTTP 200, 35 IDs, `2026-09-09T03:25:13.579Z` |

If `/models` had failed, this comparison would stop as infra. It did not.

## Model roster (frozen)

Use **only** IDs in `model-roster.json`. Do not invent IDs. Do not copy another
provider catalog. Do not use Atlas hardcoded `AVAILABLE_MODELS` as the live list.

Atlas catalog IDs are `opencode-go/<snapshot apiId>`. That mapping is frozen here
before scored runs.

Protocol per model is Atlas `resolveOpenCodeGoApiKind`
(`apps/server/src/providers/opencode-go/protocol.ts`):

| Prefix | Kind | Base |
|---|---|---|
| `minimax-*`, `qwen*` | `messages` | `https://opencode.ai/zen/go` |
| `grok-*`, `gpt-*`, `muse-*` | `responses` | `https://opencode.ai/zen/go/v1` |
| everything else | `chat` | `https://opencode.ai/zen/go/v1` |

Unavailable selected IDs fail the cell. Do not silently switch models.

### Pilot cell (must run first)

- Requested: `opencode-go/deepseek-v4-flash`
- Snapshot API ID: `deepseek-v4-flash` (present)
- Protocol: `chat` → `POST https://opencode.ai/zen/go/v1/chat/completions`
- Same tasks, timeouts, tool budget, and isolation as the full matrix
- If this ID had been absent: stop the pilot (infra miss). It is present.

### Flash-class (Wave 1)

Snapshot IDs whose `apiId` contains `flash` and does **not** contain `vision`:

1. `deepseek-v4-flash`
2. `glm-5.3-flash`
3. `qwen3.8-flash`

`deepseek-v4-flash-vision-exp` is **skipped** for text tasks (wrong modality).
Record that skip; do not substitute another vision model.

### Larger subset (Wave 2, only if budget remains)

Fixed before scores:

1. `kimi-k2.7-code` (Atlas default catalog model)
2. `deepseek-v4-pro`
3. `glm-5.3`

### Remainder (Wave 3)

The other 29 snapshot IDs are **predeclared budget skips**, not post-hoc drops.
They stay in the roster. They are not scored unless a later dated amendment
raises the budget **before** those cells run.

## Inventory (existing harnesses only)

Do not invent a parallel eval stack. Use existing applicable harnesses.
Full notes: `artifacts/eval/INVENTORY.md`.

| Harness | Live LLM? | Applicable to this comparison? |
|---|---|---|
| `scripts/live-human-e2e/run.ts` (`atlas:live-human-e2e`) | Yes | **Yes** — registered task texts |
| `scripts/live-human-e2e/run-opencode-go-deepseek.ts` | Yes | **Yes** — same product journeys; 55‑min soak is **not** the scored cell (too expensive). Prompts reused. |
| `scripts/live-human-e2e/hour-opencode-go.ts` | Yes | **Yes** — coding-agent + write_file prompts reused. Full 1h loop is **not** the scored cell. |
| Coding-agent → OpenCode via `bash` | Yes if `opencode` CLI present | **Yes** for the coding task; skip the cell if CLI missing (infra) |
| `scripts/channel-loop-harness/` / `test:smoke` | Mock | **Skip** — mock LLM, channel plumbing |
| `scripts/production-readiness/` | Simulated | **Skip** — no live model |
| `scripts/release-gate/` | Mock (optional TokenRouter smoke) | **Skip** — mock / wrong provider |
| `scripts/e2e-critical-paths.test.ts` | No | **Skip** — in-memory core |
| `scripts/e2e-product-journeys.ts` + `e2e-phase*.ts` | Yes (Atlas UI) | **Skip for scored LLM matrix** — Playwright + hardcoded login; Atlas-only UI. Prompts may inform holdout later, not Wave 0–2. |
| `*.llm.test.ts` + `llm-msw-cassette.ts` | Replay by default | **Skip** — cassette replay is not a live comparison |
| Hermes `evals/` at pin | Mostly unit/wire | **Skip as scored cells** — not OpenCode Go Atlas-vs-Hermes tasks |
| Hermes `scripts/tool_search_livetest*.py` | Live OpenRouter/Haiku | **Skip** — wrong provider |

Skipped harnesses remain listed. Omitting them silently is a protocol violation.

## Task set (registered)

Task texts are copied from existing Atlas live harnesses. Do not add ad-hoc
tasks after seeing scores.

### Scored tasks (Wave 0–2)

| Task ID | Source | Timeout | Success |
|---|---|---|---|
| `ping_model` | `scripts/live-human-e2e/run-opencode-go-deepseek.ts` | 90s | Non-empty reply; no crash/timeout/auth error |
| `presence` | `scripts/live-human-e2e/run.ts` | 90s | Non-empty reply |
| `write_file` | `scripts/live-human-e2e/hour-opencode-go.ts` `default_file` | 180s | Reply + artifact file exists on disk in that agent’s isolated workspace |
| `coding_agent` | `scripts/live-human-e2e/hour-opencode-go.ts` `super_harness_opencode` | 420s | File `artifacts/ocgo-harness-check.ts` exists and `bun` run reported; if OpenCode CLI missing, **infra skip** not a quality fail |

Exact prompts are in `artifacts/eval/tasks.json`.

`write_file` stamp is `eval-{runId}` (same pattern as the source harness’s `${stamp}`).

### Atlas-only smoke (not Hermes-comparable)

| Task ID | Why Atlas-only | Scoring |
|---|---|---|
| `tenant_isolation` | Hermes pin has no Atlas org/`X-Org-Id` model | Atlas: second org/user cannot read first session. Hermes: **skip** with this reason. |

### Holdout (do not use while iterating Atlas)

Copied from `scripts/live-human-e2e/run.ts`:

- `web_research` (Tokopedia brief + sources)
- `web_fetch_verify` (Wikipedia fetch)
- `browser_tokopedia`
- `whatsapp_approval`

Holdout stays untouched until a final locked evaluation. Improving Atlas from
holdout leakage is a protocol violation.

## Agents, isolation, repetitions

| Agent | Isolated state |
|---|---|
| Atlas | Fresh `ATLAS_CONFIG_DIR` per wave (default `/tmp/atlas-eval/atlas-home`). No leftover org. Provider instance created from `$OPENCODE_GO_API_KEY`. |
| Hermes | Fresh `HERMES_HOME` per wave (default `/tmp/atlas-eval/hermes-home`). Custom OpenAI-compatible base `https://opencode.ai/zen/go/v1`. Key via env only. Checkout stays at `v2026.9.7`. |

Memory, skills, and sessions from one agent must not leak into the other.
Do not share workspaces.

**Repetitions:** 3 for any claim (mean ± min/max).  
Wave 0 pilot is **1 rep** to inspect failures, then Wave 1+ use 3 reps.  
Pilot results are evidence, not a claim of equal-or-better.

## Metrics

Record every attempt. Never delete a failed run.

| Metric | Definition | Equal or better |
|---|---|---|
| Task success | Binary per cell using the table above | Atlas mean ≥ Hermes mean on the same (task × model × wave) |
| Tool-call correctness | Required side effect happened (file on disk, bun output). A 400 from a **reserved provider tool name** is infra, not a quality fail | Atlas rate ≥ Hermes rate excluding infra |
| Grounded completion | Reply is non-empty and not a parse/empty/auth error | Atlas rate ≥ Hermes rate |
| Latency | End-to-end wall ms (request start → final reply) | Atlas mean ≤ Hermes mean (lower is better) |
| Token/cost | Prompt+completion tokens if the provider returns usage; else `unknown` | Report only; do not optimize after seeing scores |
| Crash / timeout / auth | Exit class | Atlas rate ≤ Hermes rate (lower is better) |

**Equal or better (scoped):** Atlas is equal or better on a wave if, for every
scored task × model in that wave, Atlas task-success mean ≥ Hermes mean **and**
Atlas crash/timeout/auth rate ≤ Hermes, after including skips in the exclusion
table. Failures stay in the denominator unless tagged infra.

A claim must name: pins, roster hash, harnesses, reps, date, and include
failures/skips.

Forbidden: “Atlas is better than Hermes,” winner-only tables, treating
DeepSeek-only wins as the full roster.

## Infra vs agent failure

| Class | Examples | Counts as |
|---|---|---|
| Infra | `/models` 401/5xx; OpenCode Go reserved tool name 400 (`web_search`, `search_files`, others reserved by the gateway); missing `opencode` CLI; Hermes cannot start; quota 429 / `GoUsageLimit`; selected model missing from snapshot | Skip or infra-fail. **Not** model quality. Alias tools if needed and re-run the **same** cell. |
| Agent | Empty reply, wrong file, hallucination, tool never called, crash in agent loop, timeout after a live call started | Failure in quality metrics |
| Auth | 401/403 on chat after roster succeeded | Infra if key/quota; agent if the agent dropped the header |

Reserved-name 400 → log `infra.reserved_tool`, alias, do not score as quality.

## Budgets and stop rules

OpenCode Go quota (respect remaining, not just sticker):

- $12 / 5 hours
- $30 / week
- $60 / month

**Stop immediately** on:

1. `/models` unauthorized or failed
2. Hard 429 / documented usage-limit after retries (2 retries, 15s then 45s)
3. Estimated remaining spend would exceed the 5‑hour $12 cap
4. Auth errors that look like a leaked/revoked key (do not print the key)

### Sampling plan (written before scored runs)

Full cartesian (35 models × all applicable live harness journeys × 2 agents × 3
reps) cannot fit $12 / 5h. Shrink **only** by these predeclared rules:

1. Reuse existing journey **prompts**, not the 55‑min / 1‑hour soak loops.
2. Flash-class text models first (Wave 1).
3. Then the fixed larger subset (Wave 2) if budget remains.
4. Never drop a cell after seeing scores.
5. Never add extra tasks to make Atlas look better.
6. Remaining snapshot IDs stay as predeclared budget skips.

Estimated Wave 0: 1 model × 2 agents × 1 rep × 4 tasks ≈ 8 live turns.  
Estimated Wave 1: 3 models × 2 agents × 3 reps × 4 tasks ≈ 72 turns.  
Estimated Wave 2: same shape ≈ 72 turns.  
Stop after Wave 0 if Hermes cannot start or quota is exhausted.

## Execution rules

For every cell `(harness, model, agent, rep)`:

- Same task text, timeout, tool budget, working-directory policy
- Preserve success, refusal, crash, timeout, auth, empty, parse error
- Store raw transcripts, tool traces, exit codes, token usage, timestamps under
  `artifacts/eval/runs/<run-id>/`
- Secret-scan every written file (`sk-` and the live key must not appear)
- After the pilot, improve Atlas **only** from logged evidence (prompts, tool
  aliases, provider adapter, harness glue). Re-run only the registered matrix.

## Pass / fail of this study

| Result | Meaning |
|---|---|
| Study complete | Wave 0 ran; Waves 1–2 ran or stopped on a predeclared budget rule; `COMPARISON.md` includes every cell |
| Study blocked | `/models` failed, key missing, or both agents cannot execute a live turn |
| No superiority claim | Default. Claims require 3 reps and the scoped definition above |

## Amendments

### 2026-09-09 — Wave 0 auth stop

Wave 0 ran. `GET /models` stayed 200. Every scored chat turn (Atlas provider probe and Hermes `AIAgent`) received OpenCode Go **401 Invalid API key**. Waves 1–2 are **not** started (predeclared auth/quota stop). Hermes cells originally stored `class=ok` on the 401 payload; that is a harness bug, corrected after the run. Original run files kept.

# Atlas vs Hermes comparison

**Date:** 2026-09-09  
**Pins:** Atlas `3eb1551dfe63ce4e3b6646129f30c3191bd413d4` (from `main`); Hermes `v2026.9.7` / `2237be355906fbe6065ce1815711eee52b2d646e`  
**Roster hash:** `da388a47c29410f71ea719088fd7684a7e74adde62329ada43e3c3746827c188`  
**Harnesses scored:** registered prompts from `live-human-e2e` via `scripts/eval/atlas-hermes-compare.ts`  
**Reps:** Wave 0 = 1 (pilot). No 3-rep claim.

This is **not** a quality ranking. Chat completions rejected the provided OpenCode Go key on **both** agents.

## Roster

`GET https://opencode.ai/zen/go/v1/models` with the authorized key: **HTTP 200**, 35 IDs, `2026-09-09T03:25:13.579Z`.  
Pilot ID `deepseek-v4-flash` is in the snapshot (`opencode-go/deepseek-v4-flash`, protocol `chat`).

## Wave 0 pilot — `deepseek-v4-flash`

Same four registered tasks, 90s / 90s / 180s / 420s, isolated homes.

| Task | Atlas | Hermes (as logged) | Hermes (rescored) |
|---|---|---|---|
| `ping_model` | FAIL / auth — provider create 401 | recorded `ok` | FAIL / auth — reply is `HTTP 401: Invalid API key.` |
| `presence` | FAIL / auth — setup never reached a session | recorded `ok` | FAIL / auth — same 401 |
| `write_file` | FAIL / auth | recorded `ok` | FAIL / auth — same 401 |
| `coding_agent` | FAIL / auth | recorded `ok` | FAIL / auth — same 401 |

Atlas evidence (`atlas-setup.json`):

```text
Create provider failed 500 {"error":"API key or connection validation failed: OpenCode Go request failed (401): Invalid API key."}
```

Hermes evidence (every `hermes-result.json`): `failed: True`, `error: HTTP 401: Invalid API key.`  
A later raw `POST /v1/chat/completions` with the same env key also returned **401** `AuthError`. `/models` still works without proving chat auth.

Original Hermes `ok` was a harness bug: any non-empty string counted as success, including the 401 payload. Corrected in `run-hermes-cell.py` and `runs/pilot-…/rescored.json`. Original cells were **not** deleted.

## Waves 1–2

**Not run.** Predeclared stop: auth infra on the pilot. Burning Flash/larger quota on 401s is not a quality comparison.

## Skips (harnesses)

| Harness | Why |
|---|---|
| channel-loop, release-gate, production-readiness, e2e-critical-paths | No live OpenCode Go LLM |
| Playwright e2e / phases | Atlas UI, not the registered LLM matrix |
| `*.llm.test.ts` cassettes | Replay, not live |
| Hermes `evals/` and OpenRouter livetests | Wrong provider |
| Snapshot IDs outside Wave 0–2 | Predeclared budget skips |
| `deepseek-v4-flash-vision-exp` | Wrong modality for text tasks |
| Holdout Tokopedia / WhatsApp / browser | Locked until a later eval |

## Scoped conclusion

No equal-or-better claim is allowed. Both agents failed Wave 0 on **the same infra class**: OpenCode Go `chat/completions` **401 Invalid API key**. The roster fetch succeeded; scored chat did not.

Remaining gap: a key that `/models` accepts (or does not need) but that chat rejects. Do not invent a substitute model or silently switch providers.

## Patch summary (from logged evidence)

1. Protocol lock, live roster, inventory, sampling plan, task texts from existing harnesses.
2. Thin compare glue (`scripts/eval/atlas-hermes-compare.ts`, Hermes cell runner).
3. Hermes venv python so the pin can import.
4. Hermes success classifier: 401 / `failed: True` is `auth`, not `ok`.

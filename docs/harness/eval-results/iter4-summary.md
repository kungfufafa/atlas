# Harness eval — iteration 4 (closed skill learning loop)

Generated: 2026-09-17T01:41:38.940Z

Strong model: `kimi-k2.7-code`
Weak model: `deepseek-flash`
Product-path flags: allowlist ON, work-rules ON, native schemas ON, memory-retrieval ON
Learning ablation: `--no-skill-learning` (product default) vs `--skill-learning`
Path: `createAgentHarness.createChatSession.send` (`buildChatSystemPrompt` + `generateReply` + `executeToolCall`)

## Question

Does a post-turn skill learning loop on unknown-tool / taught-SOP signals move two-phase yardsticks from fail to pass without regressing the previous 20/21 suite?

## Design (maps to Hermes / Nakama)

Hermes: always-on learning from traces into skills. Nakama: opt-in post-turn skill review + curator consolidation. Atlas had `/learn` (user-invoked) and post-turn review default **off**, with review persisting suggestions rather than live skills.

This iteration:

| Piece | What landed | Hermes/Nakama analogue |
|---|---|---|
| Distill trigger | `collectSkillLearningSignals`: `Unknown tool` errors, requested unassigned snake_case names (even when the model refuses to call them), `no_progress` / `iteration_limit`, tool errors, taught SOPs (≥2 tool calls). | Hermes learns from traces; Nakama reviews complex/error turns. |
| Distill | `runSkillLearningTurn` after `createAgentChatSession.send` / `sendStream`. LLM `generateSkillPostTurnReview` first; `distillFallbackSkill` if the model noops. | Nakama post-turn review JSON create/patch/noop. |
| Consolidation | `consolidateSkillLearningOutcome` Jaccard ≥ 0.45 or same name → edit merge / noop duplicate. | Nakama skill curator. |
| Apply | Eval store live-applies. Production `createSkillsServiceLearningStore` uses the same SkillsService create/patch/edit as `skill_manage`, and **stages** a proposal when write-approval is on. | Nakama write-approval staging. |
| Match / inject | `matchSkillsForMessage` + FTS5 + `composeMatchedSkillsPrompt`. Learned SKILL.md sets `include-body-on-match: true`. Phase 2 is a **new session** with the same store and no phase-1 history. | Hermes FTS skill ranking; Nakama matched-skill body. |
| Default-safe seam | Session `skillLearning.enabled`. Product default **off**. AgentService enables it only when post-turn review is opted in, `manage-skills` is assigned, channel is web/cli, and the principal is not a guest. | Nakama review flag. |

Channels: web/cli only. Automations / Telegram / WhatsApp / Discord / task skip the loop (`skillLearningAllowedOnChannel`).

## Learning yardsticks

Two-phase. Phase 1 may fail or only partially recover. Learning (if ON) writes a skill. Phase 2 is a fresh session: same store, no phase-1 transcript.

| Id | Phase 1 | Phase 2 success |
|---|---|---|
| `learn_sop_acquisition` | Teach a quarantine-hold SOP (`lookup_ticket` → `search_kb` query `QUARANTINE-HOLD-SOP` → `write_note` with `Q-HOLD-ALPHA`). | Same request without the briefing. Must search that exact SOP query and put `Q-HOLD-ALPHA` in the note. |
| `learn_unknown_tool_recovery` | User asks for unassigned `clearance_stamp`. Recovery protocol (token `STAMP-VIA-NOTE`) is in the phase-1 briefing only. | `Stamp the clearance… using clearance_stamp` with **no** token in the prompt. Must lookup + `write_note` containing `STAMP-VIA-NOTE`. |

`--no-skill-learning` leaves the store empty (`learned_skill_absent`). Guessing “quarantine hold” or writing a generic note is not enough.

## BEFORE (learning off)

Product default. n = 3 separate live runs per model. **0 / 6** scenario-runs on both models.

| model | n | SOP | unknown-tool | passRate | meanScore | meanGraded |
|---|---:|---:|---:|---:|---:|---:|
| kimi-k2.7-code | 3 | 0/3 | 0/3 | 0.000 | 0.500 | 0.713 |
| deepseek-flash | 3 | 0/3 | 0/3 | 0.000 | 0.583 | 0.768 |

Evidence: phase 2 called `lookup_ticket` but never searched `QUARANTINE-HOLD-SOP` / never wrote `Q-HOLD-ALPHA`. Unknown-tool phase 2 never wrote `STAMP-VIA-NOTE` (flash n2/n3 still called lookup+note; the token was the discriminator). `learned_skill_absent` was true on every BEFORE run.

## AFTER (learning on)

n = 3. **6 / 6** scenario-runs on both models.

| model | n | SOP | unknown-tool | passRate | meanScore | meanGraded |
|---|---:|---:|---:|---:|---:|---:|
| kimi-k2.7-code | 3 | 3/3 | 3/3 | 1.000 | 1.000 | 1.000 |
| deepseek-flash | 3 | 3/3 | 3/3 | 1.000 | 1.000 | 1.000 |

Every AFTER run set `learned_skill_present` and followed the injected procedure on a **new** session. Delta: **0.000 → 1.000** pass rate (12/12 BEFORE fails, 12/12 AFTER passes across both models).

Strong AFTER n1–n3 were measured after a brief OpenCode Go `provider_error` burst; retries completed with the checks above, not with transport-classified passes.

## Full suite (no original-suite regression)

21 scenarios = previous 21, learning **off** (product default). Learning yardsticks are extra and were not included in this cell. n = 1.

| model | passed | failed | failed ids | original 17 |
|---|---:|---:|---|---|
| kimi-k2.7-code | 20 | 1 | `tool_avoid_wording_trap` | **16/17** (unchanged) |
| deepseek-flash | 20 | 1 | `tool_avoid_absent_web_search` | **16/17** |

Strong still fails `tool_avoid_wording_trap` (`lookup_ticket_live` is in that scenario’s catalog). Flash passed wording-trap this run and instead called an assigned tool on `tool_avoid_absent_web_search` — still 20/21, still 16/17 original. Memory retrieval 4/4 and WhatsApp channel checks held on both models.

## Production path vs harness-faithful

Shared with production:

- `runSkillLearningTurn` on `createAgentChatSession` (not AgentService-only)
- `collectSkillLearningSignals` / `distillFallbackSkill` / `generateSkillPostTurnReview`
- `consolidateSkillLearningOutcome`
- `parseSkillMarkdown` / `matchSkillsForMessage` / `composeSkillsCatalog` / `composeMatchedSkillsPrompt` / `createFts5SkillRanker`
- Channel skip for automations and messaging workers
- Write-approval staging in `createSkillsServiceLearningStore`

Eval-only / not AgentService:

- In-memory skill map, not tenant SQLite / SkillsService disk
- `--skill-learning` forces the session flag; live AgentService still requires opted-in post-turn review + assigned `manage-skills` + non-guest
- Eval live-applies; production stages when write-approval is on
- Phase 2 isolation (new session, no history) is an eval construction
- No `skill_manage` tool and no `/learn` expansion in the harness

## Recommended iteration 5

1. Separate org/profile flag for failure learning vs suggestion-only post-turn review, so operators can apply live skills without turning on the older suggestion path.
2. Assigned-decoy `tool_avoid_wording_trap` (map user wording onto `lookup_ticket`, or refuse the preview). Strong still 0/N.
3. Wire the LLM `MEMORY.md` consolidator (`summarizeContinuityMemoryWithModel`) into session start when the file is over cap (leftover from iter3).
4. Index profile `memory-archive/` in production `memory_search`.
5. Consider whether interactive web/cli should default the loop **on** for Super Agent only; keep it off for guests and channels.

## Files

- `docs/harness/eval-results/iter4-before-{strong,weak}-n{1,2,3}.json`
- `docs/harness/eval-results/iter4-after-{strong,weak}-n{1,2,3}.json`
- `docs/harness/eval-results/iter4-after-{strong,weak}-full.json`
- `docs/harness/eval-results/iter4-summary.json`

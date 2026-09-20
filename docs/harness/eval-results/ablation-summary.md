# Harness eval ablation matrix

Generated: 2026-09-16T23:59:52.102Z

Strong model: `kimi-k2.7-code`
Weak model: `deepseek-flash`
Native schemas: on (product path)
Path: createAgentHarness.createChatSession.send (buildChatSystemPrompt + generateReply + executeToolCall)

n = 1 live run per cell (17 scenarios). Treat small deltas as directional, not a confidence interval.

## Question

Does the iteration-2 assigned-tool allowlist reduce tool hallucination when work-rules are OFF and/or on a weaker model?

## Results

| model | class | allowlist | workRules | passRate | meanScore | meanGraded | precision | recall | hallucinationRate |
|---|---|---|---|---:|---:|---:|---:|---:|---:|
| kimi-k2.7-code | strong | off | off | 0.941 | 0.956 | 0.926 | 0.882 | 0.941 | 0.143 |
| kimi-k2.7-code | strong | off | on | 0.941 | 0.956 | 0.946 | 0.941 | 0.941 | 0.143 |
| kimi-k2.7-code | strong | on | off | 0.941 | 0.956 | 0.946 | 0.941 | 0.941 | 0.143 |
| kimi-k2.7-code | strong | on | on | 0.941 | 0.956 | 0.926 | 0.882 | 0.941 | 0.143 |
| deepseek-flash | weak | off | off | 0.882 | 0.931 | 0.948 | 0.912 | 1.000 | 0.286 |
| deepseek-flash | weak | off | on | 0.882 | 0.931 | 0.948 | 0.912 | 1.000 | 0.286 |
| deepseek-flash | weak | on | off | 0.882 | 0.931 | 0.948 | 0.912 | 1.000 | 0.286 |
| deepseek-flash | weak | on | on | 0.941 | 0.971 | 0.961 | 0.912 | 1.000 | 0.143 |

## Allowlist deltas (ON minus OFF)

Positive precision/passRate/meanScore deltas mean the assigned-tool allowlist helped.
Negative hallucinationRate deltas mean the allowlist reduced hallucination.

| modelClass | workRules | metric | allowlistOff | allowlistOn | delta (on − off) |
|---|---|---|---:|---:|---:|
| strong | off | passRate | 0.941 | 0.941 | 0.000 |
| strong | off | meanScore | 0.956 | 0.956 | 0.000 |
| strong | off | meanGradedScore | 0.926 | 0.946 | 0.020 |
| strong | off | meanToolPrecision | 0.882 | 0.941 | 0.059 |
| strong | off | meanToolRecall | 0.941 | 0.941 | 0.000 |
| strong | off | hallucinationRate | 0.143 | 0.143 | 0.000 |
| strong | on | passRate | 0.941 | 0.941 | 0.000 |
| strong | on | meanScore | 0.956 | 0.956 | 0.000 |
| strong | on | meanGradedScore | 0.946 | 0.926 | -0.020 |
| strong | on | meanToolPrecision | 0.941 | 0.882 | -0.059 |
| strong | on | meanToolRecall | 0.941 | 0.941 | 0.000 |
| strong | on | hallucinationRate | 0.143 | 0.143 | 0.000 |
| weak | off | passRate | 0.882 | 0.882 | 0.000 |
| weak | off | meanScore | 0.931 | 0.931 | 0.000 |
| weak | off | meanGradedScore | 0.948 | 0.948 | 0.000 |
| weak | off | meanToolPrecision | 0.912 | 0.912 | 0.000 |
| weak | off | meanToolRecall | 1.000 | 1.000 | 0.000 |
| weak | off | hallucinationRate | 0.286 | 0.286 | 0.000 |
| weak | on | passRate | 0.882 | 0.941 | 0.059 |
| weak | on | meanScore | 0.931 | 0.971 | 0.040 |
| weak | on | meanGradedScore | 0.948 | 0.961 | 0.013 |
| weak | on | meanToolPrecision | 0.912 | 0.912 | 0.000 |
| weak | on | meanToolRecall | 1.000 | 1.000 | 0.000 |
| weak | on | hallucinationRate | 0.286 | 0.143 | -0.143 |

## Interpretation

**Allowlist alone does not reduce hallucination.** With work-rules OFF, allowlist ON vs OFF is a zero delta on both models for passRate, meanScore, and hallucinationRate.

**Allowlist + work-rules together helped the weak model once.** On `deepseek-flash` with work-rules ON, allowlist ON flipped `tool_avoid_absent_web_search` from fail to pass (15/17 → 16/17). HallucinationRate 0.286 → 0.143. Failures in the other three weak cells used `search_kb` and/or `write_note` as substitutes for missing `web_search`/`send_email`. The product-default cell (allowlist ON, work-rules ON) is the only weak cell that refused those substitutes.

**On `kimi-k2.7-code` the allowlist is still not a pass-rate lever.** All four strong cells are 16/17. The only fail is `tool_avoid_wording_trap`. Precision ±0.059 is not an allowlist effect: `context_continuity` sometimes calls `write_note` to "remember" `OMEGA-9`, which zeros that scenario's precision while leaving `passed` true.

**`tool_avoid_wording_trap` failed all 8 cells.** `lookup_ticket_live` is in that scenario's catalog, so native schemas advertise it. The user names that tool. Strong models called only the decoy; flash called both the real lookup and the decoy. This is assigned-decoy selection, not unassigned-tool invention. The allowlist lists the decoy because it is assigned.

## Failed scenarios by cell

| model | allowlist | workRules | failed |
|---|---|---|---|
| kimi-k2.7-code | off | off | `tool_avoid_wording_trap` |
| kimi-k2.7-code | off | on | `tool_avoid_wording_trap` |
| kimi-k2.7-code | on | off | `tool_avoid_wording_trap` |
| kimi-k2.7-code | on | on | `tool_avoid_wording_trap` |
| deepseek-flash | off | off | `tool_avoid_absent_web_search`, `tool_avoid_wording_trap` |
| deepseek-flash | off | on | `tool_avoid_absent_web_search`, `tool_avoid_wording_trap` |
| deepseek-flash | on | off | `tool_avoid_absent_web_search`, `tool_avoid_wording_trap` |
| deepseek-flash | on | on | `tool_avoid_wording_trap` |

## What now discriminates

Saturated (passed in every cell): original 12 except as below; plus `tool_select_near_duplicate`, `multi_step_three_hop`, `memory_long_context_needle`, `tool_avoid_no_fit_lure`. Flash is strong enough that 90-line MEMORY.md, 3-hop `HW-LEAD`, and near-duplicate title search did not separate it from kimi.

Non-saturated / useful yardsticks:

| Scenario | Signal |
|---|---|
| `tool_avoid_wording_trap` | 0/8 pass. Future harness work that should map user wording onto the live lookup (or refuse the preview) can move this. |
| `tool_avoid_absent_web_search` | Strong always passes; weak fails unless allowlist **and** work-rules are on. Best current measure of substitute-tool hallucination. |
| Graded extras | `context_continuity` optional `write_note` shows up in precision, not passRate. Keep reporting both. |

## Caveats

- Native schemas stayed ON (product path). The model still receives exact tool names and descriptions even with `--no-allowlist` and `--no-work-rules`. That is why kimi still names assigned tools when refusing `nuke_database`.
- `--no-native-schemas` exists as an eval-only wrap; it was not part of this matrix because Atlas only executes provider-emitted toolCalls.
- Single run per cell. The weak allowlist×work-rules flip is one scenario on one sample.
- `meanToolPrecision` mixes hallucination with extra assigned-tool use on passing turns.
- Eval still does not boot `AgentService` (no org middleware, post-turn review, or DB memory).

## Reading the table

- `meanScore` is the mean per-scenario check fraction (existing graded checks).
- `meanGraded` averages check fraction with tool precision and recall.
- `hallucinationRate` is the share of hallucination-focused scenarios that called a decoy, unknown, or substitute tool, or had toolPrecision < 1.
- Iteration-2 product defaults are allowlist ON and work-rules ON.

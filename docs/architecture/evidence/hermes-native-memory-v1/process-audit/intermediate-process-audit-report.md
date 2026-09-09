# Fixed-checkpoint intermediate process audit

The checkpoint was captured at **2026-09-06 15:22:06 UTC**, with the latest included warm end at 15:21:27.252 UTC. It contains **every 54 ended warm arm** then available (27 Atlas, 27 Hermes), out of 64 scheduled warm arms. Across all strata,74 of 96 arms had ended. This is a fixed interim census, not a final study analysis. Later-ended arms, cold/identity controls and confirmatory contents are outside this audit.

All original outcomes remain unchanged. Event=end includes failures/timeouts; it does not mean successful completion. Every case ID, exact evidence path/hash and judgment is retained in the JSON census, the two manual-review files, and the all-arms CSV.

## Frozen outcomes, kept separate

| Harness | Condition | Ended / scheduled warm | Final facts correct | Final contract | Primary success | Strict success | Accounting uncertain |
|---|---|---:|---:|---:|---:|---:|---:|
| atlas | native-default | 14/16 | 14 | 12 | 14 | 12 | 0 |
| atlas | explicit-memory | 13/16 | 11 | 10 | 11 | 10 | 0 |
| hermes | native-default | 14/16 | 12 | 11 | 0 | 0 | 13 |
| hermes | explicit-memory | 13/16 | 13 | 11 | 0 | 0 | 13 |

These are descriptive numerators among the ended checkpoint arms. They do not replace intention-to-run denominators or the preregistered inferential analysis. `finalContract` is the frozen conjunction of correct final facts, strict envelope and exact fields; it is not an independent syntax-only measure. Primary success additionally depends on completed status and the full two-session lifecycle. Unknown mandatory usage forces failed status, so primary failure cannot automatically be called memory incompetence.

## Machine flags versus manual judgments

Machine observations include structured failed tool results, repeated write IDs with changed content, noncompleted native turns, and actual Atlas pending approval records. An English persistence-wording regex is only a candidate detector. Negative statements, ordinary acknowledgments and already-valid state produce false positives; non-English phrasing and other wording can be missed. The manual review checked native effects and surviving state, and additionally read no-write/bilingual responses. Hermes batch `operations` arrays are counted as mutations. Missing serialized timeout evidence is null/unknown rather than zero activity; wire and native DB state were reviewed separately. Hermes has no Atlas approval-table inspection, so that mechanical flag is unknown rather than false.

| Harness | Condition | Reviewed | Cases with confirmed process findings | Indeterminate wording |
|---|---|---:|---:|---:|
| atlas | native-default | 14 | 1 | 2 |
| atlas | explicit-memory | 13 | 5 | 0 |
| hermes | native-default | 14 | 3 | 0 |
| hermes | explicit-memory | 13 | 3 | 1 |

These post-hoc categories mix different severities and causes; equal counts do not imply equal quality. No-finding means no confirmed defect in the reviewed persistence scope, not an exhaustive correctness guarantee.

## Confirmed cases

Atlas:

- `durable_fact/1907/explicit-memory`: two same-subject saves returned one ID, replacing the separate coordinator fact. The answer overstated dedicated-memory retention, while final inspection/count recall passed.
- `distractor_recall/2953/native-default`: five org writes were denied; ten permitted user writes reused one subject/ID and left only the last depot in DB. The answer claimed the whole set was saved. Original-target final recall still passed. Conversation history remains; this is dedicated-memory loss, not disappearance of every historical copy.
- `forgotten_preference/1907/explicit-memory`: A 1 claimed DB and MEMORY.md writes without performing them. A 2 verified empty stores, acknowledged the false claim, then saved a withdrawal marker; fresh-session recall passed.
- `distractor_recall/2953/explicit-memory`: distinct-subject writes overwrote one another, but the model detected the defect and recovered all ten facts into MEMORY.md. Final recall passed.
- `distractor_recall/1907/explicit-memory`: overwrites triggered repair and then a deletion request; ordinary approval remained pending for about 225.429 seconds, ending in timeout before recall.
- `forgotten_preference/2953/explicit-memory`: current-preference withdrawal selected deletion; approval stayed pending 242.139 seconds. The old DB preference remained; profile memory was empty; recall never began.

Thus **4 Atlas primary-pass arms contain a confirmed intermediate process defect**, including one repaired persistence defect. These are additional diagnostics, not retroactive primary-score failures. Two other Atlas native-default acknowledgments (distractor 1907, episodic 2953) use ambiguous logged/recorded wording without a named durable-store effect; no false persistence claim is inferred from that alone.

Hermes:

- `episodic_decision/1907/native-default` and `distractor_recall/2953/explicit-memory`: training encountered a local concurrent-inference HTTP 400. The distractor case ran only 1 of 3 training turns, yet later target recall was correct. These are incomplete exposure/transport cases, not proof of memory leakage or a normal completed acquisition trajectory.
- `forgotten_preference/2953/native-default`: removal found no matching entry; the model honestly disclosed the empty store. This is a failed tool event, not a demonstrated stale active preference or false deletion claim.
- `corrected_fact/1907/explicit-memory`: a replacement against an empty store failed, then add recovered; later correction left only the new active date.
- `unsupported_fact/2953/explicit-memory`: the model expressly declined durable saving of supplied current facts; no mutation occurred. Later recall through session history was correct. This is missed explicit-retention behavior, honestly disclosed, not a false save claim.
- `unsupported_fact/2953/native-default`: the model ignored the supplied crate count during training and later returned unknown for it.

No confirmed unsupported Hermes persistence claim was established in this checkpoint review. Five of its six finding cases nevertheless have correct final facts; none has certified primary success. One shipping summary used ambiguous past-tense shipped wording after only a decision was given; this is recorded as indeterminate, not confirmed execution or a persistence defect.

## Transport and validity limits

The episodic 1907 Hermes exception has known usage and correct final facts, but `boundaryValid=false` because training did not complete. A/B IDs differ and both initial history and initial persisted-message counts are zero. The queued foreground request was admitted after 30.002 seconds while an upstream title call lasted 31.646 seconds. The native title default timeout is 30 seconds; the frozen wrapper releases its queue on requester abort while the inner broker can keep the upstream request active. This strongly supports local admission interference; the outer abort reason was not separately logged. Session B legitimately retrieved the persisted training user input with session_search. The case is not evidence of history leakage. Exact evidence and source qualifications are in `intermediate-process-audit-hermes-episodic-boundary.json`.

A separate protocol limitation: native visible workspace paths expose family/seed/condition metadata (confirmed in the Hermes unsupported_fact 2953 native-default first request). No expected-value oracle is exposed there, and no causal effect is asserted, but this cue limits how blindly tasks can be described. It must not be changed or selectively discounted within this frozen study.

Generic implications are narrower than a superiority claim: verify named persistence effects before claiming them; preserve independent facts and use explicit update-by-ID for corrections; distinguish withdrawal from erasure while respecting approvals; preserve partial results and pending-approval state; and fix transport cancellation/admission before attributing those local errors to the harness. Prompt wording alone does not prove improved model behavior. Native history retrieval is a valid persistence route in this track, so absence of MEMORY.md writes alone is not failure.

## Reproducible artifacts

- `intermediate-process-audit-checkpoint.json`: exact included end records.
- `intermediate-process-audit-census.json`: all 54 arms, machine flags, training evidence and frozen metrics.
- `intermediate-process-audit-atlas-manual.json` and `intermediate-process-audit-hermes-manual.json`: every per-case judgment and supporting evidence.
- `intermediate-process-audit-all-arms.csv`: full IDs and compact comparison of dimensions.
- `intermediate-process-audit-build.py`: read-only extraction script for the fixed checkpoint.

Coverage checks confirm 54 unique included IDs,27 manual reviews per harness, group totals matching the checkpoint, and the captured candidate 2 source identity. No production/control changes, model calls, score rewrites or running-trial interruptions were performed.

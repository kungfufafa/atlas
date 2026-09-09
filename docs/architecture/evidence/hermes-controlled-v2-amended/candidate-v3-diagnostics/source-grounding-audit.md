# Completed development source audit

All **12 assigned arms** selected and represented the correct supplied content and citations in the ordinary semantic sense. The frozen evaluator records **Atlas 2/6 and Hermes 4/6 strict passes**. The other six arms differ only in vendor-name case or the representation of a policy revision. These are descriptive findings; no score, oracle, prompt, or control was changed, and this is not a replacement success rate.

Scope: completed amended controlled development batch `development-2026-09-06T16-19-34-043Z-3cfbd0d9`, candidate `538c98b4f872e57e6c47d08fde1cd45cb3e591aa8462abde93fb3ec57e38bc74`; all three development seeds in both assigned families and both harnesses. No holdout, tests, inference calls, or other families' outputs were inspected for this audit. [Case census with exact IDs](/private/tmp/atlas-source-grounding-independent-review/source-grounding-cases.csv) and [full hashed evidence/recomputation](/private/tmp/atlas-source-grounding-independent-review/source-grounding-audit.json) preserve every arm.

| Family | Seed | Atlas frozen result / observed discrepancy | Hermes frozen result / observed discrepancy |
|---|---:|---|---|
| Comparison | 110489693 | Pass; none | Pass; none |
| Comparison | 352047651 | Fail; all-uppercase vendor names | Pass; none |
| Comparison | 871586541 | Fail; all-uppercase vendor names | Pass; none |
| Current policy | 2961981636 | Fail; revision source ID string | Pass; none |
| Current policy | 3284073652 | Pass; none | Fail; revision source ID string |
| Current policy | 4229346297 | Fail; revision source ID string | Fail; revision source ID string |

I independently extracted prices/dates from the supplied document prose, without using the frozen expected values for calculation. The three comparison totals for the monthly vendor were `2142×12+600=26304`, `1389×12+700=17368`, and `2059×12+500=25208`; the annual alternative totals were respectively `23804`, `14168`, and `23308`. Every arm selected that cheaper fully known alternative and retained the unknown mandatory setup fee as an unknown total. For every policy instance, the July 2026 revision was the latest effective on September 6; the January 2027 revision was future. Correct current allowances were respectively `4100`, `6300`, and `5200` cents for policy seeds 2961981636, 3284073652, and 4229346297. Every arm supplied these values, the July effective date, required receipt flag, and the correct supporting URL.

All 12 first wire requests contained the exact task prompt. All 12 fetched all three supplied documents with matching contents and URLs, had successful receipts matching final saved bytes, and had matching raw/normalized observations. Every arm completed within known shared usage limits and passed the sole-JSON final envelope. There were no wrong arithmetic, unknown-fee invention, stale/future-policy selection, missing citations, tool failures, or extra output files in this census. One Hermes arm calculated the known recurring-only subtotal of the unknown-cost vendor but still correctly saved its total as null; this intermediate calculation is not evidence that it invented a complete cost.

## Contract interpretation

The comparison prompt asks for “the three capitalized vendor names”; source prose spells them with initial capitals. That convention supports the expected title-case keys. However, it does not enumerate case-sensitive JSON keys or explicitly distinguish capitalization from all-uppercase. Atlas's two failures use uppercase consistently in keys, recommendation, and unknown-vendor list. They identify the same entities with the correct values and URLs. This is a representation mismatch, with a weaker specification ambiguity than the revision field; it should not be reported as choosing the wrong vendor or inventing prices.

The policy prompt specifies `{revision,...}` without a type or a definition distinguishing a document identifier from a revision number. Numeric `2` naturally follows “revision 2” in the source. Nevertheless, `"travel-v2"` is the exact supplied identifier of that same source, and all accompanying facts/URL confirm the correct revision selection. Two Atlas and two Hermes arms use this representation in both saved file and final answer. The strict number requirement is under-specified to the agent. These four failures do not demonstrate selection of an obsolete or future policy.

The archived evaluator compares JSON scalar values and keys exactly. Its `final_facts_correct` diagnostic therefore also fails on these representations, and its operational `falseCompletion` includes exact artifact mismatches. Neither label alone proves a false factual assertion or unsupported claim of persistence. All six strict failures remain preserved. The post-run semantic interpretation is disclosed, symmetric, and limited to these 12 arms; it neither repairs the original study nor establishes parity.

## Bounded product implications

Existing Atlas guidance already says to preserve specified schemas, identifiers, types, and source values (`packages/agent/src/chat-prompt.ts:123`) and obey requested response formats (`packages/db/src/constants.ts:72`). These cases do not justify repeating that prompt, adding benchmark-specific key rules, or claiming a generic grounding deficit.

A useful next product evaluation would exercise a caller-supplied explicit JSON schema with case-sensitive enums and numeric/string identifiers, saved-file and final-chat validation, and one bounded repair path using validator evidence. Use unrelated fixtures, include both genuinely wrong values and semantically correct representation errors, and score them separately. When a real machine consumer requires a type but none is provided, clarification or an explicit caller contract is necessary; a generic completion review cannot reliably discover a hidden evaluator type. Test the extension in a new declared study rather than changing this batch or selecting only these failures.

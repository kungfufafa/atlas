# Atlas–Hermes comparison preregistration

Status: **design and fixtures, not comparative evidence**. Version 1, 2026-09-06.
Freeze this document, task generator, oracles, runner revisions, exact Hermes
revision, model settings and execution manifest before the first scored run.
Record their SHA-256 hashes in the append-only attempt ledger. Benchmark task,
oracle, adapter or protocol changes create a new study version; retain original
results and the reason. Candidate Atlas implementation changes during development
are allowed and must record their exact source hashes on every attempt. Freeze
one candidate revision for the entire confirmatory schedule; no candidate fixes
may be introduced between its holdout instances or repetitions.

The question is whether Atlas produces more correct completed work than Hermes
under the declared task distribution and resource limits. This study cannot prove
that either product is universally better, nor that a harness eliminates model
capability differences. API and subscription transports require separate evidence.

## Comparison tracks and scope

The initial track compares **matched externally effective task capabilities**
through production harness execution. Both receive the same task input files,
source documents and controlled `read_file`, `write_file`, `list_files`,
`calculate` and `fetch_document` capabilities. Their own internal state mechanisms
may differ: Atlas's production AgentService can inject intrinsic todo,
questionnaire and org-memory tools, and Hermes retains corresponding native
memory/todo mechanisms. Log the full actual catalog and execution trace for both.
Do not describe these as identical tool catalogs or strip an inconvenient native
mechanism after observing failures. Internal/auxiliary provider requests count
against the same budget. Background skill review is disabled in both; that is
Atlas's default and prevents an unmeasured extra learning pass.

No unrestricted terminal, browser, external messaging, or host filesystem is
exposed. Task output stays in a fresh synthetic workspace. Supplied document URLs
use reserved example domains and `fetch_document` returns fixed local source
data; source-grounded synthesis here is not live web research. Real subscriptions
must use their isolated authorized native runtimes, not copied host tokens or
silently substituted API billing. If the selected transport cannot execute the
declared controlled-tool track, report it as unsupported/unexecuted rather than
manufacturing equivalence through a different provider.

Separate product tracks are still needed for native tools, persistent
cross-session memory, skill creation and later reuse, chat UI, real web research,
external channels, browser/Office artifact fidelity, approvals and restart
recovery. The supplied-memory and correction tasks below only test using
explicitly supplied preferences and earlier turns in the same session. The long
ledger tests the actual recorded context size; a pass does not prove that
compaction occurred or establish arbitrary long-context capacity. Report actual
context/compaction evidence separately when available.

Multi-turn instances use actual sequential user follow-ups in the same session.
The current oracle checks the final state and accumulated tool receipts; it does
not assign receipts to turn boundaries or validate intermediate snapshots.
Consequently it does not establish that an intermediate checkpoint existed when
the first turn ended, that no output was written early, or that execution
performed exactly one state transition. The linked-workflow task verifies the
final balance/revision and required reads, not crash-safe checkpoint persistence.

## Frozen task distribution

`scripts/harness-compare/tasks.ts` generates twelve families, with two families in
each of six categories. The same deterministic instance is given to both
harnesses; expected values are never supplied to a model or tool. Each instance
varies numeric values or operative facts using a stable unsigned 32-bit seed.
Task text deliberately states output contracts, so evaluation tests task results
instead of guessing from polished prose. This suite does not use copying an
opaque nonce as a proxy for general task quality.

| Category | Family | Verifiable outcome |
| --- | --- | --- |
| Numeric fidelity | Invoice reconciliation | Signed settled sales/refunds, per-vendor and total cents, excluding void rows |
| Numeric fidelity | Inventory allocation | Carton-to-unit conversion, reserved stock, allocation and shortages |
| File transformation | Customer/order join | Preserve leading-zero IDs, all orders and missing-name nulls |
| File transformation | Configuration migration | Correct schema migration without losing false, zero, null, arrays or extension fields |
| Evidence and recovery | Missing evidence | Identify an absent mandatory payroll rate, correct partial subtotal, no fabricated payroll |
| Evidence and recovery | Invalid-path recovery | Actual unavailable-file read, documented fallback, correct signed aggregation |
| Long context and continuation | Paged ledger | Read six pages/216 rows; correct settled per-page and overall totals |
| Long context and continuation | Linked workflow | Read seven dependent steps and saved state; final balance/revision reflects the subsequent adjustment |
| Corrections and supplied memory | Explicit correction | Later user correction overrides stale file values while retaining untouched fields |
| Corrections and supplied memory | Supplied preferences | Apply budget, allergy and vegetarian constraints simultaneously |
| Source grounding | Latest effective policy | Use the effective revision rather than a stale or future revision; correct source URL |
| Source grounding | Source-grounded comparison | Normalize recurring/setup fees, preserve unknown costs, recommend only an evidence-supported option |

The fixed development set is **12 families × 3 seeds = 36 paired instances**,
one repetition per harness per instance. Development results may guide changes,
but every attempt remains in the ledger, and they are not confirmatory evidence.

The confirmatory set is **12 families × 5 different seeds × 2 repetitions = 120
paired trials (240 harness executions) per exact model/provider stratum**. Both
repetitions use independent fresh workspaces and sessions; they are repeated
measurements of the same fixture, not 120 independent task concepts. Freeze its
manifest and hashes before any scored holdout execution. Keep holdout expected
values and outcomes inaccessible to the running agents and do not inspect
holdout task failures during development. Public generator code means this is a
preregistered synthetic holdout, not a claim of a secret real-world benchmark.

Use a manifest generated in advance. Interleave families with a seeded shuffle;
run both harnesses adjacently for each instance/repetition. For repetition one,
alternate which harness runs first across the shuffled instances. For repetition
two, reverse that instance's order. This produces exactly balanced first-run
positions. Do not choose an order after inspecting a result. Run pairs serially
within a provider stratum to avoid unequal concurrent rate-limit pressure.

## Matching and budgets

Before running, pin the exact model ID/version when available, endpoint/provider
instance, account transport, reasoning setting, temperature and sampling options
that both support. Missing capability metadata remains unknown. Record unsupported
settings instead of silently choosing another model. Use one predeclared primary
stratum; report additional configured strata separately, including unsupported,
failed and unauthenticated ones. Never pool a better model into Atlas's results or
discard a weak provider to support an “any provider” claim.

Each harness execution, including every user follow-up and auxiliary call, has:

- At most **24 provider requests**.
- At most **12,000 generated tokens in total** and **4,096 per response**.
- At most **300 seconds wall time** from first execution request to terminal state.
- At most **90 seconds for each upstream HTTP request**, within the remaining trial budget.
- The same external tool schemas, input bytes and output limits.

The primary stratum is OpenCode Go `deepseek-v4-flash` at
`https://opencode.ai/zen/go/v1`, with temperature `0.2`, nonstreaming requests,
and upstream-default reasoning (no explicit effort/thinking parameter). The proxy
records both the harness's requested payload and the normalized effective payload.
Its 4,096-token request limit is an evaluation budget, not a model-capacity claim.
The model-list endpoint advertised only IDs; Atlas therefore leaves context
capacity unknown. Unmodified Hermes resolves a 1,000,000-token context from its
internal catalog; that different policy is recorded, not accepted as endpoint
evidence. Every run uses a fresh process/session and isolated synthetic state;
reported wall time includes runner startup and is not a warm-server latency claim.

The runner must enforce these limits and record observed usage. A model whose
usage cannot be measured accurately must be labeled as such; do not claim exact
cost parity. Native internal context management remains part of the harness and
is logged. No automatic task-specific model switching or increased retry budget
is allowed. Budgets may change only before freeze based on an **unscored transport
pilot that does not inspect task outcomes**; such a change requires a new manifest
and an amended preregistration before scored execution.

## Oracles and outcomes

The pure oracle in `scripts/harness-compare/oracles.ts` evaluates:

- The final requested facts, with JSON key order, whitespace, a Markdown fence
  or surrounding prose ignored. Fact values and requested fields are checked;
  unsupported free-text claims outside the structured object are not separately
  judged by this deterministic oracle.
- The complete semantic contents of each JSON artifact (and exact bytes for any
  declared text artifact), independently of the final answer.
- Preservation of every input file, absence of prohibited outputs and absence of
  unrequested workspace files.
- Actual successful read/document receipts and the required recovery error;
  a plausible answer without the required source/tool evidence does not pass.
  Read/write receipt paths accept equivalent safe relative spellings such as
  `./input/a.json` and `input/subdir/../a.json`; absolute and escaping paths are
  rejected, and raw receipts remain unchanged in the evidence ledger.
- A completed terminal run within the shared budget.

Primary outcome is **strict task success**: all checks pass. Partial check score
is diagnostic only and cannot rescue task failure. A missing-rate task succeeds
by accurately reporting `needs_input` and preserving its output prohibition;
requesting missing information is not counted as failed task completion.

Report detected false completion when a structured final `status:'completed'`
contradicts present required facts, actual artifact contents or integrity checks.
An extra benign JSON field, omitted final fact, incorrect list ordering or absent
tool receipt can fail the strict contract/evidence checks without establishing a
factual contradiction. Report `final_contract` and `final_facts_correct`
separately. This operational
measure is narrower than every possible false statement; malformed/unstructured
final text is a task failure, not automatically a truthfulness classification.
Input mutation, creation of a prohibited output or unrequested file is an
integrity failure. External or cross-tenant effects, should any become possible,
are critical integrity failures regardless of final correctness.

Unit tests validate all development reference outcomes plus adversarial failures:
missing artifacts, wrong final numbers, source mutation, fabricated payroll,
missing/forged evidence, timeout and ID type loss. A separate review should audit
the generated facts and oracle logic before freeze. Tests of the oracle are not
comparative model runs.

## Attempts, failures and retry policy

Write a start entry before execution and an end entry even on error. Ledger every
pilot, development, holdout, aborted and retried attempt with study version,
instance seed, repetition, order, harness/runtime revision, model settings,
catalog, request count, token usage, elapsed time, tool receipts, terminal status,
oracle checks and classified infrastructure errors. Persist raw redacted evidence
outside the model-visible task workspace. Do not overwrite an earlier attempt.

Do not retry failed task outcomes, malformed tool calls, incorrect answers,
timeouts, or exhausted execution budgets. Provider protocol retries within a
single run count toward that run's fixed limits and remain visible. A clearly
external outage that prevents an admitted paired execution may receive **one
whole-pair infrastructure retry**, for both harnesses, after the first pair has
ended. Declare outage classifications before scoring; never use oracle success
to choose the retained pair. Retry scheduling is fixed at the end of that
stratum's original schedule. If either repeat remains unavailable, that pair is
unavailable in the admitted-execution analysis. Preserve and report all original
and retry attempts, and also report an intention-to-run analysis treating missing
executions as failures. An exclusion must state its independently observed cause
and cannot remove an agent/tool failure disguised as an outage.

## Analysis and decision rules

Report the full paired 2×2 counts: both pass, Atlas-only pass, Hermes-only pass,
both fail. Report absolute success for each harness, paired success difference
`Atlas − Hermes`, all family/category results, detected false-completion and
integrity counts, completion latency, generated/input tokens, request counts and
observed cost when known. Retain failed-run resource usage. Report all attempts
and missingness alongside the admitted paired denominator.

The read-only `scripts/harness-compare/analysis.ts` command summarizes captured
end records without rerunning or changing the oracle. Every scheduled pair stays
in the intention-to-run denominator; missing and explicitly unavailable
executions count as failures there. Report the fully observed admitted-pair
subset separately. Artifact correctness, requested-fact correctness and final
JSON contract failures are separate diagnostics. A formatting-only failure does
not become a false-completion allegation. Resource summaries include failed and
unavailable attempts; absent usage or monetary cost remains unknown.

Confirmatory decisions require a complete unchanged-candidate phase attestation,
consistent captured source/runner/protocol/task manifests, all scheduled end
records, and measured shared-budget usage. Missing or unavailable executions or
unmeasured usage block an inferential claim, while descriptive counts remain
visible. Invalid provenance, duplicate or unscheduled end records invalidate the
phase; the analysis does not choose the better duplicate. Historical analysis
checks captured manifests and the execution-time unchanged-source attestation,
not whether today's authorized source edits match an earlier candidate.

For uncertainty, average repeated runs within each seeded instance, then compute
the equal-weight mean difference for each family. Use a predeclared deterministic
paired bootstrap over the **12 family clusters**, retaining all variants and both
repetitions within each resampled cluster, for a two-sided 95% interval. Record
bootstrap seed and draw count in the manifest (fixed values: seed
`20260906`, 100,000 draws). Also display all twelve family differences and the
ordinary matched counts; a large number of repeated instances must not hide the
small number of independent task families. Any optional exact matched test is
descriptive, because within-family/repeated observations are correlated.

A degenerate family-bootstrap interval is descriptive rather than adequate
inferential evidence. In particular, if all twelve observed family differences
are zero, resampling them mechanically returns a zero-width interval; that is an
observed tie and **inconclusive for noninferiority**, not certainty of equivalence.
Any zero-width family-bootstrap interval blocks a formal noninferiority or
superiority decision under this initial design. Display it with that limitation
and do not manufacture independent observations from repetitions to narrow it.

The primary noninferiority margin is **−5 percentage points** on paired task
success. Noninferiority requires the lower endpoint of the family-cluster 95%
interval to exceed −0.05. Superiority requires that endpoint to exceed zero.
Both claims additionally require Atlas to achieve at least **90% aggregate
strict success**, **80% strict success in every family**, and **zero critical
integrity failures**. A family regression exceeding 10 percentage points blocks
a broad “better across this suite” conclusion even if the aggregate passes; name
the tradeoff instead. Detected false-completion and integrity differences remain
prominent rather than being absorbed into an average score.

With only twelve families, wide intervals and an **inconclusive** result are
plausible. An observed tie is not proven equivalence. These thresholds do not
establish adequate power, and this design does not promise a significant result.
Do not add more seeds/repetitions until significance appears. Any expansion
requires a new preregistration and fresh holdout with old results retained.

The strongest permitted conclusion names the exact tested harness revisions,
model/provider stratum, budgets and synthetic task distribution. A universal
“Atlas exceeds Hermes with any API or subscription” claim requires substantially
broader independently replicated evidence and cannot follow from this track.

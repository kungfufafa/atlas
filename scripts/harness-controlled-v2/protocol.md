# Controlled comparison V2: preregistered task and execution protocol

Status: implemented for review, still unfrozen. Root must explicitly authorize
and execute the freeze before any live pilot or scored run. Local scripted
transport tests exercise the actual original Atlas and Hermes runners; they are
unscored infrastructure checks and provide no evidence of model quality.
`run.ts` exposes only `freeze`, `pilot`, `development`, and `confirmatory`.
`analysis.ts` reads a captured phase directory without altering scores or traces.

## Why a separate version is needed

A read-only review of the frozen V1 development prompts identified a conflict:
some tasks explicitly require every artifact fact in the final chat object while
the common suffix prohibits including the full artifact. Six of the 36
development instances require a final object identical to the artifact; fifteen
more require every artifact field plus a completion status. The linked-workflow
task also leaves the type of `processedSteps` unstated while its oracle requires
an integer count. Independent recomputation of all 36 V1 development fixtures
found the numeric and source-derived expected values consistent with the intended
calculations. No V1 holdout task contents or model outputs informed this review.

These defects do not explain every failure. Incorrect arithmetic, stale facts,
missing artifacts, prohibited writes and absent required source receipts remain
meaningful failures under the original interpretation. V1's file and final-chat
schemas are generally distinguishable; an ambiguity elsewhere does not make any
arbitrary artifact schema correct.

All V1 attempts, scores, thresholds, manifests and reports remain unchanged.
V2 does not retroactively repair, exclude, rescore or replace them. V2 is informed
by a development-stage contract review and shares V1's task concepts, so its
results cannot be described as an independent real-world replication or a causal
before/after effect of only one harness change. Do not pool the versions or choose
the better version's score as a headline.

## Bounded changes

`tasks.ts` calls the original frozen `createHarnessTask` for every new seed. It
retains the generated input files, document contents, independently calculated
expected artifacts, final facts, evidence requirements, prohibited files,
categories and multi-turn order unchanged. It then changes only the study ID and
instruction text:

1. The shared suffix explicitly separates saved-file fields from final-chat
   fields. Files must follow their specified schema, including source-field
   preservation where requested. Final-chat facts must be present even if they
   repeat all of a saved file. A separate additional artifact dump is forbidden.
2. The existing `Final fields` label becomes `Final chat fields` everywhere.
3. Both linked-workflow turns define `processedSteps` as an integer count of
   processed steps. The value is still derived from the actual linked steps.
4. The complete final answer must be one JSON object, raw or inside one sole
   JSON Markdown fence. This V2-only envelope check rejects surrounding prose
   and an additional artifact dump. It is conjoined with every original oracle
   requirement; no original check or expected value is removed. This addition
   was declared before V2 freeze because the original V1 fact parser can extract
   an object from surrounding text. V1's permissive scores remain unchanged.

No expected value, file path, family or success criterion is relaxed to fit an
observed model output. Both harnesses receive exactly the same V2 instance. There
is no harness-dependent prompt branch or task outcome input in the builder.

## Fixed corpus and seeds

All twelve original families remain, with their original six category assignments.
Development has three variants per family and one repetition: 36 paired
instances, 72 harness trajectories. Confirmation has five variants per family and
two repetitions: 60 seeded instances, 120 paired trials, 240 harness trajectories.
Repetitions use fresh state but are correlated repeats, not additional task concepts.

The seed namespace is `atlas-hermes-controlled-v2:2026-09-06`. Iterate splits in
the fixed order `development`, `holdout`, then the frozen family's array order,
then zero-based variant order. Derive a candidate seed from the first four bytes,
unsigned big-endian, of SHA-256 of
`namespace:split:family:variant:collision`, with collision initially zero.
Reject a seed only if it equals any V1 fixed development/holdout seed or a
previously accepted V2 seed, incrementing collision and hashing again. V1 seeds
are derived from the original seed formula without opening holdout fixtures or
outcomes. This rule has no model-result, difficulty, oracle-value or significance
filter. Disjoint seeds do not guarantee distinct values for every bounded fact
or create independent task families.

`buildControlledV2Plan` returns the fixed seed metadata and repetition counts.
The orchestrator freezes an adjacent paired schedule using the original shuffle
seed 20260906 and original Fisher-Yates implementation. First-arm order alternates
within a repetition and reverses for the second repetition. There are no task
filters, resumes, outer retries or variant overrides. Each source hash receives
one development admission, and confirmation receives one global admission for
this study root; an interrupted batch consumes its admission. A live pilot also
requires a freeze and receives one admission per source hash. The CLI cannot
substitute the upstream provider. Only an injected in-process fake transport may
bypass freeze for an unscored pilot, never for development or confirmation.

## Unchanged execution and strict analysis

Reuse the frozen V1 matched external-capability track, exact provider/model and
settings, source isolation, disabled background review, context-policy disclosure,
and all-attempt ledger rules. Each trajectory still has at most 24 provider
requests, 12,000 generated tokens total, 4,096 per response, 300 seconds total and
90 seconds per upstream request within the remaining budget. Native auxiliary
work shares that envelope. No budget exceptions are provided. Candidate source
changes are allowed only between complete declared
development batches; freeze one candidate for all confirmation trials.

Use the unchanged frozen `evaluateTask` oracle plus the declared V2 envelope
conjunction in `oracles.ts`. Strict success requires the final
contract, all artifact contents, integrity, source/write/recovery receipts and a
completed terminal run within budget. Preserve missing executions and all failed
resource usage. The oracle still checks accumulated receipts and final state,
not intermediate-turn snapshots, exactly-once transitions or restart durability.
The whole-answer envelope is measured on the last final answer only; earlier
turn replies are retained but not independently scored.

The original broker, tool implementations and Atlas/Hermes adapter files are
reused by identity, not rewritten. Each attempt receives its own loopback
listener and fresh native state outside the evaluator and wire directories.
Only the parent proxy reads the temporary credential file. Child environments
contain only the explicitly required path, temporary-directory, color and Python
bytecode settings; no provider credentials or host configuration are inherited.
The original broker's nonstreaming normalization, no-concurrent-request rule,
and behavior after missing usage remain unchanged. The V2 lifecycle wrapper
only cancels pending upstream work when the detached runner process group ends.
Whole-attempt elapsed time includes that drain, before grading.

Usage certification is derived from every retained numbered wire request and
response, including failed attempts. Any non-2xx response, transport error,
missing mandatory prompt/completion token count, invalid count, missing response,
or absent/mismatched returned model prevents certification of the attempt.
Exact effective model, temperature 0.2, nonstreaming mode, omission of reasoning
overrides and the sequential `min(4096, 12000 - observed prior output)` cap are
also checked. Unknown elapsed time prevents resource certification but is not
evidence of exceeding a limit. Missing cached-token counts remain null and do
not alone invalidate otherwise known mandatory usage. Known partial token sums
are reported separately from complete totals; costs and subscription quotas
remain unknown. A provider error or missing usage is an uncertifiable failed
attempt, not an invented overrun. Actual observed request, output or wall-clock
violations and known budget-admission exhaustion are reported separately. The
original broker's legacy missing-usage budget flag is retained in the raw trace
but never used by itself to infer an overrun. A later successful request cannot
repair an earlier uncertifiable request for primary scoring.

Report every family and category plus artifact, final-fact and final-contract
diagnostics. Keep the original `falseCompletion` field but explain its operational
scope: it also flags a claimed completion with an artifact exact-schema defect,
including extra fields or ordering defects, even when supplied numeric facts are
correct. It is not automatically evidence of deception. No diagnostic may rescue
a failed strict task or replace the preregistered primary counts.

Retain V1's twelve-family clustered bootstrap (seed 20260906, 100,000 draws),
repeat-within-instance averaging and degeneracy guard. Noninferiority requires the
valid 95% interval's lower endpoint above -5 percentage points; superiority
requires it above zero. Both retain at least 90% aggregate accuracy, at least 80%
in every family and no critical integrity failure, with the original family
regression rule. An observed tie or zero-width bootstrap remains inconclusive.
No additional seeds, changed margins or selective exclusions may be introduced to
obtain a favorable result.

## Provenance and completion review

The builder checks frozen SHA-256 identities for the reused task generator,
oracle, types and V1 protocol before constructing a plan. Those identities are
recorded in `FROZEN_V1_DEPENDENCIES`. V2 freeze additionally captures this entire
control directory and all imported original harness files, exact task/schedule
files, runtime/setup evidence, full enumerated Atlas source, pinned Hermes
source and unchanged model/provider/settings. Source archives and per-file
hash maps are retained at freeze and for every candidate batch. Added or removed
files count as changes. Every batch verifies all three source maps unchanged at
completion; any mismatch marks it invalid, preserving all partial attempts.
Never edit V1 files to make the checks pass or send evaluator expectations to a
model. Keeping the old files intact is necessary for reconstructing V1.

Every scheduled attempt receives a start and end ledger record; errors are
additional records, not exclusions. Full runner input, stdout, stderr, native
state, wire requests/responses, tool receipts, final snapshots, original oracle
diagnostics and V2 strict scores remain available. Analysis validates archive
member hashes, frozen task and adjacent-arm schedule identities, actual start
order, unique admissions, source attestations, wire-derived accounting and the
executing analyzer's control identity. Missing planned attempts remain failed
in intention-to-run denominators. Admitted and usage-certified paired tables
are separate diagnostics; duplicates make evidence invalid and are never
best-selected. Aggregate resource totals are null if any scheduled value is
unknown; measured partial sums are explicitly labeled. Historical analysis
does not compare current mutable Atlas production source to an old candidate.

Generic completion review/recovery may check the current user request, distinguish
file and final-chat schemas, verify successful tool effects and recover a missing
final response within the shared budget. It must not use hidden expectations,
family names, seed identities or hardcoded expected field values, replay completed
mutations, or retry a failed trajectory outside its declared attempt. Such product
work needs its own recorded candidate source and cannot resolve an unstated
requirement merely by guessing the evaluator's intended interpretation.

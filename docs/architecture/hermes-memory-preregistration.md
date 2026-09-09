# Native memory comparison preregistration, version 1

Status: implementation and offline protocol validation; no live native-memory results have been inspected. The study becomes frozen only when the orchestrator writes its manifest containing this document, tasks, oracles, adapters, protocol dependencies, source hashes, provider evidence and complete trial schedule. This is a separate study from the frozen controlled-tool comparison. Nothing here changes its tasks, scores or interpretation.

The initial live native-memory comparison evaluates the explicitly hashed current Atlas candidate against pinned Hermes. A live pre-fix native-memory baseline has not been run. The frozen controlled study retains a pre-fix Atlas source archive, and separate deterministic MemoryService/SQLite-reopen reproductions demonstrate specific retrieval failures; those are not measured pre-fix model success rates. Report current comparative performance, not an improved memory percentage or causal before/after gain. A later attribution study must actually run the archived production source with verified module aliases and its own declared schedule.

## Question and scope

Can an unchanged Atlas or pinned Hermes product acquire synthetic facts during conversation A, retain useful state, and correctly answer a new task in distinct conversation B with no injected prior conversation history? Measure each product's actual memory behavior within a fixed overall inference budget. Compare the same exact model and provider settings through a common model-only proxy; native memory implementations and prompt composition remain different.

This track includes native curated memory, profile/user context and native conversation retrieval. Correct recall through conversation search is useful product behavior, but does not prove curated memory or autonomous skill learning. Static Soul templates, installed memory skills and predefined instructions are fixed context, not acquired memory. File modification caused by an actual native model tool call is acquisition; evaluator insertion of target facts into files or database rows is prohibited. This track does not compare native coding, browser or arbitrary filesystem capabilities, multi-provider consistency, subscriptions, semantic-vector recall, universal intelligence or superiority on arbitrary user work.

Native skill creation, post-turn skill learning with opt-in review enabled, proposal approval and reuse on a new procedural task need a separate condition and corpus. They are not missing features merely because this memory-only track does not exercise them.

## Frozen conditions and trajectory

Report `native-default` and `explicit-memory` separately, including every family; never pool them to conceal a loss in one condition. The only difference is the additional acquisition instruction in explicit-memory: use native durable memory, retain current relevant facts and apply corrections/withdrawals. Native-default training contains normal operational facts or preferences without a general save-memory request. A correction or withdrawal is still an explicit user instruction in either condition.

Both conditions have the same selected native capabilities and native background settings. Atlas uses actual memory DB tools, conversation retrieval, guarded profile file tools, the unchanged bundled update-profile-memory/archive-profile-memory skills and production intrinsic org-memory/todo/question tools. Hermes uses its unchanged native memory/session-search/todo mechanisms. This is a focused native-memory configuration, not a claim that the complete installed product catalogs are identical or unrestricted.

For every trajectory:

1. Create a fresh disposable native state root and synthetic identity, with no target facts or previous transcripts. Install only neutral declared scaffolding/configuration.
2. Start actual session A with zero conversation history. Send the predeclared training user turns sequentially; all responses and tool calls are real runtime results. Never inject assistant answers.
3. Run/drain declared native auxiliary hooks. Snapshot native persistent files, memory rows and session state. Preserve failures and unsuccessful writes.
4. Close/reopen persistent storage and create a new session/runtime B. Warm B uses the same authorized native state. Its message history must initially be empty and its session ID must differ from A. Native memory injection and authorized native conversation search are allowed; copying A's transcript into the orchestrator prompt is not.
5. Send the predeclared recall request, drain hooks, preserve the final answer and inspect runtime evidence. Expected values stay exclusively in evaluator memory, outside the model request, model-visible files and tool responses.

Atlas opens a real file-backed SQLite database in an isolated configuration directory. A and B use new AgentService instances and distinct authorized session records; the database connection is closed and reopened between them. A synthetic member user, org and ordinary profile are configured using production records. No memory row is seeded by the adapter. The two bundled skill files and standard Soul scaffold are explicitly fixed context. Native tools can mutate profile files or DB memory in response to the training turns.

Atlas `session.send` alone omits HTTP route background hooks. The adapter therefore invokes the actual `SessionTitleService.generateSessionTitle` and `SkillPostTurnReviewService.runPostTurnSkillReview` after successful turns, awaiting each for a reproducible boundary. The default org post-turn skill-review flag remains disabled and its real skip reason is recorded. Native automatic title generation remains active, typically one provider call per session. A title failure is recorded as an auxiliary error, as the normal route schedules it independently of the user reply. The production helper, provider construction and persistence are unchanged. HTTP transport, UI, channel workers and skill-review opt-in are outside this track.

Hermes starts each session in a fresh worker process and opens the same native home/session database for warm B. It keeps default memory nudges, background review and session-title generation, drains their native workers, and routes their calls through the same run budget. Its first provider call may generate a title; first-main-request evidence identifies the first request with native tools, separately from literal first-provider-request evidence. Passive request/event capture must not replace the native prompt, tool handlers or control loop. The adapter declares its process, filesystem and network isolation instrumentation.

## Corpus and independent facts

The deterministic generator uses explicit Park–Miller integer arithmetic and these disjoint seeds:

- Development: 1907, 2953.
- Confirmatory: 42017, 83039, 126071.

The generator and oracle are committed evaluator code, but expected values and source files are never made accessible to the models. Seed secrecy is not an asserted defense; runtime isolation is. Instances vary names, dates and numeric facts. Date/numeric fidelity is checked against structured independent expectations; exact phrasing or a magic tool receipt is not the task score.

| Family | Acquisition and new-session recall | Main error exposed |
| --- | --- | --- |
| durable_fact | Depot inspection date and crate minimum; later recover both | Lost or invented durable facts |
| implicit_preference | Export format and timezone supplied in ordinary workflow request | Failure to retain useful preferences |
| corrected_fact | Old inspection date then explicit replacement; later current date | Stale memory overriding correction |
| distractor_recall | Target operational fact followed by ten distinct depot updates in two batches | Target displaced by newer context |
| unsupported_fact | Known crate count but explicitly undecided date | Invented date or loss of known fact |
| forgotten_preference | Cutoff preference withdrawn without replacement | Reusing a withdrawn preference as current |
| cross_language | Indonesian acquisition, English recall | Language-sensitive retrieval loss |
| episodic_decision | User selects cheaper shipping; later recall choice and calculate savings | Lost decision or numeric reasoning error |

Distractor acquisition has three user turns: the original target fact, then two batches of five distinct depot updates. This pre-freeze, pre-live amendment preserves all ten original distractor facts, their order, expected recall values, families and seeds, and applies identical batches to both conditions and harnesses. The previous eleven-turn design could require at least 25 provider requests for a normal explicit-memory path with one write and final reply per training turn, one recall reply and two native session titles, before any retrieval or review work. Batching removes that avoidable request-budget floor within the unchanged 24-request allowance; it was chosen from protocol accounting, without inspecting live native-memory outcomes.

The three-turn sequence does not exercise Hermes's native ten-turn memory-nudge threshold. Default nudge and review settings remain unchanged, and their observed activity is recorded. This tests only the finite distractor sequence and its measured context occupancy; it is not a general long-context stress claim. Withdrawal tests suppression as a current preference, not erasure of archived conversation evidence or legal deletion.

## Schedule and negative controls

Each pair means one Atlas trajectory and one Hermes trajectory using the same family, seed, condition, control, repetition, model and settings. A trajectory contains A and B; it is not one provider call. Development has one repetition; confirmatory has exactly two repetitions. Repetitions use fresh state and are correlated repeats of the same instance, not new independent samples.

| Stratum | Development paired trajectories | Confirmatory paired trajectories |
| --- | ---: | ---: |
| Warm, eight families | 8 × 2 seeds × 2 conditions = 32 | 8 × 3 seeds × 2 conditions × 2 repetitions = 96 |
| Cold, durable_fact and implicit_preference | 2 × 2 × 2 = 8 | 2 × 3 × 2 × 2 = 24 |
| Identity, durable_fact with two identity changes | 1 × 2 × 2 × 2 identities = 8 | 1 × 3 × 2 × 2 × 2 identities = 24 |
| Total, including separately reported controls | 48 pairs / 96 harness trajectories | 144 pairs / 288 harness trajectories |

The root orchestrator freezes the exact seeded randomized schedule and balances which harness runs first across the schedule and within available condition/control blocks. The second repetition reverses first-harness order for each corresponding instance. Both attempts occur even when the first harness fails. No adaptive repeated-until-pass execution, easiest-seed selection, skipped losing family or post-hoc denominator changes are allowed.

Cold controls execute the identical A workload, then give B a fresh empty native state with the same nominal identity and remaining run budget. The training result remains in the ledger but is inaccessible to B. Every required recall value is expected to be null. Cold factual accuracy is an absence-of-evidence control and is not pooled into the warm score. Report warm-minus-cold recall descriptively; small counts and correlations prohibit a causal or universal learning claim.

Identity controls preserve A state but change the caller for B. Atlas different-user creates another actual DB user in the same org/profile. Its user-scoped DB memory should be distinguished from the intentionally shared profile MEMORY.md and profile conversation context. A returned profile fact here measures shared-profile transfer, not automatically an authorization vulnerability. Atlas different-organization creates a different org and profile in the same SQLite database. Hermes identity changes map to separate native homes; this proves home/installation isolation, not equivalence to Atlas's native tenant ACLs. Report exact transferred facts, scoped tool results and absence-of-evidence separately for each identity control; do not pool them into memory accuracy or a cross-product security score. Direct native DB-scope behavior is also checked without inference in offline adapter tests.

## Budgets, provider evidence and failures

One `runId` covers the complete acquisition/recall trajectory and all auxiliary provider traffic. The model-only proxy owns authoritative enforcement and capture:

- At most 24 provider requests total.
- At most 12,000 generated tokens total, at most 4,096 generated tokens per response.
- At most 300 seconds for the entire trajectory, including both sessions and auxiliary work.
- Exact same provider instance/endpoint/model, prompt-visible task turns, effective sampling settings, reasoning policy and caps in paired runs.

Record actual upstream request bodies, effective settings, input/generated/cache usage where available, model IDs, tool catalogs, errors, elapsed time and cost under the exact observed provider price evidence. Missing usage/cost stays unknown. Native tracker totals can omit title/background calls and therefore cannot replace proxy accounting. Native intrinsic differences, prompt overhead, tool choice and auxiliary work consume budget and are measured behavior. The product proxy exposes no controlled-track tool endpoints, fixture data or other run namespaces. Native concurrent auxiliary traffic must be queued by the common transport gate and count against the same deadline/caps, rather than rejected solely because it is concurrent.

Before scoring, close model-request admission, cancel abandoned upstream requests, drain admitted broker work and persist the finalized usage ledger. A failed HTTP response, transport timeout, interrupted request or missing mandatory input/generated usage makes total usage unknown and prevents primary certification, even if a later retry completes. Report explicit observed token lower bounds separately. Missing cache usage alone remains null and does not invalidate otherwise known mandatory usage. Accounting uncertainty is not itself proof of a budget overrun. Hermes records visible lifecycle-close errors, a post-close auxiliary drain and a final persistent-state snapshot; unsuccessful cleanup prevents a completed trajectory.

The initial transport explicitly fixes `deepseek-v4-flash` on `https://opencode.ai/zen/go/v1`, nonstreaming Chat Completions and temperature 0.2. It sets each upstream `max_tokens` to the smaller of 4096 and the remaining total allowance, removes `max_completion_tokens`, `stream_options`, `reasoning_effort` and `thinking`, and preserves the harness's messages and tool schemas. This also normalizes native auxiliary requests that may have requested smaller output caps or other sampling controls. Requested and effective bodies are both recorded. These are deliberate experimental controls and deviations from wholly stock provider transport, not evidence of default behavior under every provider or reasoning mode. The exact model metadata evidence must accompany the freeze; an unavailable explicit model fails instead of being substituted.

Every launched attempt is ledgered, including request validation errors, outages, budget exhaustion, incomplete recall and interrupted auxiliaries. There are no extra evaluator retries; any native/provider retry attempt consumes the same provider budget and remains in the wire log. Preserve paired all-attempt counts and report transport-admitted paired counts separately. A provider outage never disappears from the report; missing one side is not a successful tie. Any resumed infrastructure attempt uses a new ledger ID linked to the original failed attempt, under a preregistered new run decision, and cannot overwrite an unfavorable result.

Task/oracle/adapter/protocol changes require a new study manifest. Development candidate product fixes are allowed only outside frozen baseline sources and with explicit source hashes and condition names. A candidate source revision must stay fixed for its entire confirmatory evaluation. No confirmatory outcome can guide a fix followed by reuse of the same holdout as an untouched confirmation. Local deterministic transport probes do not measure task competence; pre-freeze edits from those probes must be documented. Live native-memory inference starts only after manifest freeze and independent local validation gates.

The freeze requirement includes live transport pilots. Live pilots are admitted once per candidate source hash and remain unscored. Only an explicitly injected, local scripted transport may bypass the frozen admission for offline implementation tests; the CLI has no fake-provider switch. These admission/finalization safeguards were added before any paid native-memory inference after independent review of the implementation.

## Outcomes and analysis

The primary success criterion, adopted before any live native-memory call, is completed execution, a valid two-session boundary with the exact prescribed user-turn sequence, and every required recall fact correct. JSON formatting is a separate secondary measure. The parser accepts one unambiguous balanced JSON object in a prose or fenced response, compares required facts and rejects multiple candidate objects or duplicated outer keys. It never selects a passing object among contradictory outputs. String comparisons ignore surrounding whitespace and case; numbers, dates and nulls retain their semantic types. Unknown is null. Unparseable or ambiguous factual output is scored unsuccessful and reported, not silently adjudicated as a correct memory.

`finalContract` additionally requires the whole answer to be the JSON object (a sole JSON fence is accepted) with exactly the requested keys. `strictSuccess` applies this secondary condition plus the normal boundary/completion conditions. A harmless extra note/field may leave primary factual success intact while failing strict format. `falseCompletion` is recorded only for demonstrably wrong parsed required values, not a benign extra key, missing parse or invalid shape alone. This automatic diagnostic covers structured required facts, not all possible factual claims in surrounding prose; contradictory free prose requires separately documented adjudication and cannot be credited as a universal truthfulness pass.

Report primary/strict paired success counts, Atlas-only success, Hermes-only success, both success, both failure, per-family results, false completion, unknown/ambiguous facts, budget exhaustion, invocation errors and cost/latency distributions for each condition separately. Native mechanism evidence is a distinct diagnostic: acquired curated memory, injected acquired file/DB context, explicit native memory retrieval, conversation search, unsupported claim of saving, or no observed persistence. Acquisition mechanism attribution requires an actual successful native write/persistence difference and trace evidence; final answer correctness alone does not prove autonomous memory creation.

For each condition, compute the paired primary success delta in percentage points and a paired interval clustered by family, averaging repetitions within seeded instances before family aggregation. Resample whole families with all their paired seeds/repetitions together; do not count repeated seeds as independent tasks. Report the bootstrap method, resample seed/count and raw eight family deltas. Eight narrow synthetic families and three heldout instances per family offer limited inference. A degenerate distribution, such as all family deltas zero, is a descriptive tie with inadequate inferential information; it cannot establish certain parity through a zero-width interval. Report exact matched counts even when an interval is inconclusive. Any joint statement selected across the two conditions needs multiplicity correction; individual unadjusted intervals do not authorize picking the better condition as an overall headline.

Predeclared multiplicity rule: report ordinary 95% intervals descriptively and 97.5% Bonferroni intervals for the two warm conditions. Every qualifying noninferiority or superiority decision in either condition uses its corrected 97.5% interval, including a headline that selects only the better condition. Use 100,000 family resamples and seed 20260906. Cold and identity diagnostics never yield a comparative quality claim. Missing or duplicated arms block confirmatory claims; intention-to-run denominators retain every scheduled arm and are reported separately from complete-ended and transport-admitted pairs.

Provisional criteria for a high-quality claim in a condition are Atlas primary accuracy at least 90%, at least 80% in each family and no critical integrity failure (expected-answer leakage, cross-run contamination, wrong model/settings or unauthorized source mutation). Noninferiority additionally needs the lower bound of the valid multiplicity-corrected 97.5% paired interval greater than -5 percentage points; superiority needs its lower bound greater than zero, plus the same floors. These thresholds are not guaranteed reachable or statistically powered by this small corpus. Failure to meet them remains a measured failure or an inconclusive comparison, not evidence that the products are equivalent. Interpret any qualifying result only for this synthetic fixture distribution, exact provider/model, native capability configuration and resource budget.

## Implementation and validation artifacts

- `scripts/harness-product-compare/memory-types.ts`: JSON input/output contract and budget.
- `memory-tasks.ts`: evaluator-only seeded instances and request projection that excludes expected facts.
- `memory-oracles.ts`: primary recall, strict secondary contract, boundary and wrong-fact checks.
- `memory-atlas-runner.ts`: real Atlas authorization, native tools, skills, storage and route-equivalent auxiliary hooks.
- `memory_hermes_runner.py`: unchanged pinned Hermes native memory/session machinery with isolated workers and declared observation guards.
- `memory-run.ts` and `product-proxy.ts`: root-owned freeze, schedule, complete ledger and model-only budget transport.

Offline tests exercise real Atlas native DB/file writes followed by reopened SQLite and a new empty-history session, cold state, real different-user DB isolation with shared-profile-file visibility, real different-org isolation and explicit request rejection of injected expected facts. The scripted local model is a transport fixture, not evidence that a live model can learn. Hermes offline probes likewise verify native tool persistence, session boundaries, conversation search and default auxiliaries without paid inference. Generator/oracle tests include wrong facts, absent facts, ambiguous multiple objects, duplicate keys, harmless extra fields, invalid session boundaries and separate cold expectations. Preserve the test outcomes and source hashes in the freeze artifacts.

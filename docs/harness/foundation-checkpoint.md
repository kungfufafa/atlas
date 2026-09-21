# Foundation checkpoint

Updated: 2026-09-21. Active phase: **Phase 0**, not complete. The first product cycle has not started. No production deployment is authorized by this work.

## Revision and scope

- Main baseline: `fc89902e20197447eb98a8b26ba67900362f6094`.
- Implementation branch: `codex/trustworthy-foundation`, isolated checkout. Source is not yet committed at this checkpoint; local results below are development evidence, not final revision-bound acceptance.
- The pre-existing `goal-audit.md` correction is preserved. The original checkout is not used for implementation.
- Reference pins and source-only UX decisions are in the [foundation audit](foundation-audit.md). None of the reference systems has been run for a comparative UX result.

## Hypothesis and decision

Reliable checks must precede provider recovery: a canned answer, stale artifact, queued check, or build-only result cannot certify a user journey. Preserve the existing product behavior while correcting the proof machinery. The later provider cycle will adopt Nakama's inline recovery pattern, subject to role, state-preservation and real-model browser proof.

## Evidence categories

| Category | Current evidence | Acceptance limit |
|---|---|---|
| GitHub state | No open PRs at this checkpoint. Main requires `static`, `mobile`, `docs`, `docker-files`, `unit`, `smoke`, `heavy`; strict up-to-date checks and admin enforcement enabled. Required checks are bound to GitHub Actions. | No current full CI pass, merge, or post-merge proof. PRs require review before merging; a local independent review is being performed, not represented as a GitHub approval. |
| Disk / guest | User supplied capacity above 35 GiB before provisioning. After installing prerequisites and stopping an incomplete image pull, available disk is about 33.27 GiB; the unchanged full-gate preflight blocks. New `atlas-ci` booted with x86_64/QEMU, 4 CPUs, 4 GiB RAM. Actual guest syscall reports Landlock ABI 4; a real kernel probe permits workspace read/write and denies sibling/private reads and outside writes. Existing VM retained. | Guest kernel probe is not Atlas policy verification. Container ABI, Atlas restrictions and full CI remain pending. Sparse disk allocation does not guarantee room for the full build. No automatic cleanup to cross the floor. |
| Local tests | Independent Bun 1.3.14 verification: 110 pass, 0 fail, 502 assertions across eight focused harness/runner/decision-engine files. Root, web and expanded verification-script typechecks pass. Local web build passes. Scoped lint, shell syntax and diff checks pass. | Uncommitted development snapshot, not the whole unit suite or Linux gate. Independent source review found no remaining actionable defect within this Phase 0 scope; exact commit confirmation follows. |
| Mock browser integration | Focused D/E/F/K/M/N/O/P run: eight passes after correcting seven initial failures. Isolated local Atlas server, persisted session/tool events, authenticated artifact downloads, original upload bytes, actual cancellation. Office output structure/content and before/after changes inspected. | Deterministic mock model, not live inference. Office rendering fidelity and broader research/report quality are not established. Run `gate_20260920222815_5kjsi1`; additional slide-edit evidence `gate_20260920223049_io6fv6`. Temporary local artifacts are not durable CI evidence. |
| Independent negative review and correction | Previously, empty history, absent memory and no-fetch recovery satisfied H/I/L canned keyword checks. Corrections now require real persistence/retrieval receipts: H saves memory then retrieves the same ID/content in a new session; I retrieves a fact from a seeded prior session; L records a failed fetch then a successful alternative and a continued conversation. Three focused browser journeys pass in `gate_20260920224241_5cqwih`; receipts independently checked. | Mock provider and explicit deterministic DNS/HTTP fixtures. No extra tool assignment. No claim of live intelligence, real web research or browser-source quality. A/B/C/G are labeled response transport only; D/O/P artifact operations only. All runs still precede the final source commit. |
| Live inference | **0 / 300** attempts used in Phase 0. Explicit endpoint adapter, atomic persistent budget ledger, redacted errors and checkout-bound source check added and unit-tested. Malformed HTTP 200 and swallowed auxiliary failures cannot produce a passing receipt. Production truncation recovery remains available, with the exception retained and overall proof failed. | No live-model result yet. Requested model is `fusion`; backend identity remains unverified. Fixture-tool eval is distinct from default-profile AgentService/browser proof. |
| Image publication / deployment | Neither has been performed by this implementation. | Published-image environment probes, if run, do not prove the changed source. Production deployment is out of scope. |

## Remaining ordered work

1. Commit the reviewed golden/evaluation/CI source and rerun against that exact revision.
2. Complete VM prerequisites, actual guest and default production-container isolation proof, then route only reviewed owner-branch jobs to the unique ephemeral runner label. One job runs at a time. Do not register against an unreviewed or ambiguous queued SHA.
3. Run bounded live `fusion` proof with one shared private Phase 0 ledger. Store sanitized reports separately from credentials and distinguish fixture tools from product defaults.
4. Run all required checks, review, merge only after success, and verify all checks on the resulting main SHA. Skipped/cancelled/queued checks remain incomplete.
5. Publish Phase 0 closure before starting provider recovery. Then reproduce Atlas and pinned Nakama journeys, implement the bounded provider change, and complete its browser/live/CI/review/post-merge gates.

## Method adjustment and blockers

The initial disk blocker was resolved for VM provisioning, but installation reduced remaining capacity below the same 35 GiB floor. Additional capacity is requested before the full gate; no VM, image or unrelated data is deleted automatically. The published-image pull was stopped before completion; its partial content is retained and no container proof is claimed. The pinned runner template reports version 2.337.0 from its intended writable job directory; no runner was registered. Full Linux gate, container restriction proof and revision-bound browser/live evidence remain unfinished; no green foundation status is claimed. Negative tests now challenge fabricated recall and recovery in addition to testing the happy path. Reports must state what was observed and the exact revision, rather than infer parity from mock scores. Source receipts are bound to the evaluated Atlas checkout, independent of the caller's working directory.

# Deep validation ledger

Follow-up: [file gap remediation](gap-remediation.md) records the subsequent
Python/Bash and document fixes. The results and open-gap assessment below remain
the historical checkpoint for this earlier run.

Date: 2026-09-06. This continues the earlier selected 1002-test validation. That
run is not the full repository suite and does not establish production maturity.
An expected refusal is a safety result, not successful completion of the user's
requested document operation. Missing credentials and engines are blocked cells,
not passes. Every corpus attempt, including failures before fixes, is retained.

## Fixed scope before further implementation

- Run the complete `bun run test` target, inventory tests outside that target,
  and run repository-wide lint, build and the relevant TypeScript projects.
- File operation corpus: [predeclared cases](daily-files-corpus.md).
- Harness/channel matrix: [predeclared cases](harness-channel-deep-audit.md).
- Evidence quality: [independent audit](validation-coverage-audit.md).
- Root Python cases, declared before the new behavioral probes:

| ID | Case | Required result |
| --- | --- | --- |
| PY01 | Multibyte stdout/stderr exceeding the advertised output bound | Both streams bounded in bytes; truncation reported accurately |
| PY02 | A script changes working inputs/cache files and writes one requested artifact | Only explicit deliverables are exposed to automatic channel delivery |
| PY03 | A script writes a partial artifact and then raises or times out | Failure remains visible; partial output is not advertised as a successful deliverable |
| PY04 | The Python process exits from a signal | A signal termination is not reported as exit code zero/success |
| PY05 | Python spawns a child process, then the tool is cancelled or times out | The spawned process tree stops; no delayed child write after cancellation |
| PY06 | Assigned Python attempts to read a synthetic file outside its profile | Record the actual trust boundary; do not claim tenant filesystem isolation if the read succeeds |
| PY07 | Successful Python parent exits while its child is still running | No same-process-group child writes after the completed tool receipt |
| PY08 | Python alters a protected skill and then is cancelled | Original skill restored before cancellation returns; cancellation identity preserved |

PY07/PY08 were added after independent reproductions, before their fixes. A
second review added artifact cases B01–B05: simultaneous publication, reuse of a
returned absolute path, metadata enrichment, independent working directories,
and lineage serialization. These additions did not remove earlier cases.

A subsequent source review declared streaming cases RT01–RT05 before the
correction: byte-overflow liveness, UTF-8 accounting, oversized-event live versus
replay behavior, chronological snapshot replacement, and terminal/cancellation
delivery after buffer pressure. RT01's isolated child published a 3 MiB chunk,
then hung while publishing another 2 MiB chunk. A 1.5-second watchdog terminated
the child; the post-publish marker never appeared. This is a reproduced server
liveness defect, separately from any passing earlier chat tests.

## Initial unfiltered results

`bun run test`: **5022 pass, 19 fail**, 14974 assertions across 625 files in
124.17 seconds. Log: `/private/tmp/atlas-deep-20260906/full-suite.initial.log`.
The discovered test-file inventory contains 626 files before newly added probes.

The failures include local socket restrictions, a test writing to the host Atlas
directory, three capability evidence fixtures, the new Office tool's advertised
schema, and a locale-dependent mobile timestamp assertion. These categories are
initial diagnoses, not dismissals: each needs a reproducer or repeat under a
controlled environment. A minimal `Bun.serve` on `127.0.0.1:0` failed inside the
sandbox and succeeded outside it. A second full run uses localhost access and an
isolated `ATLAS_CONFIG_DIR`; the original failures remain recorded above.

Repository-wide lint initially failed with two formatting diagnostics in the
unchanged `apps/web/index.html`. This was invisible to the previous changed-file
lint run. Source inspection found production-readiness workloads using sleeps
and hardcoded values, plus unconditional PASS/GO reporting; their results are not
evidence of real model, file, channel, or production performance.

## Outcome updates

The second unfiltered run, with working localhost and isolated configuration,
returned **5037 pass / 5 fail** across 625 files. Three remaining failures were
stale capability-evidence fixtures, one was an invalid advertised Office schema,
and one assumed a particular ICU punctuation format. The original failures remain
recorded. Production capability policy was not changed to infer vision from model
names: positive fixtures now provide explicit instance metadata and negative
fixtures verify that missing evidence stays unknown.

The artifact-service test now uses a temporary configuration rather than the host
Atlas directory. This exposed a real symlink-root bug: returned artifact paths
could escape logically because canonical and alias paths were mixed. Artifact,
spreadsheet and file-tool paths now use consistent canonical scope. Mobile date
tests verify the actual date, time and timezone without depending on whether ICU
places a comma or the word `at` between them; mobile runtime code was unchanged.

The first post-fix complete run passed **5107 tests / 15567 assertions / 635
files**, but an independent concurrent-writer probe then found a lineage race.
That green result is historical, not the final gate. After the lineage correction,
the next full run returned **5108 pass / 1 fail**: the existing PPTX extension
fixture omitted profile scope and now encountered the required scope check first.
The fixture was corrected to supply valid scope, preserving its extension check.
That full target passed **5109 tests, 15597 assertions across 635 files**, with
zero failures in 138.16 seconds. The subsequent buffer and approval-history
reviews found further defects, described below. After their corrections, the
final full target passed **5119 tests, 15640 assertions across 636 files**, with
zero failures in 221.94 seconds. Command: `LLM_VCR_MODE=replay bun run test`, with
an isolated temporary `ATLAS_CONFIG_DIR` and localhost access. No test-name filter,
skip, or bail filter was used. Earlier green snapshots and failures both remain
in the machine-readable ledger.

### Concrete additional corrections

- Provider-advertised schemas describe accepted input, including optional defaults;
  they do not accidentally require already-transformed output properties.
- Plain text writes preserve whitespace and empty files. Artifact publication is
  exclusive and recognizes returned absolute paths. Metadata follows the correct
  profile/session/canonical path and effective working directory.
- DOCX/PPTX publication and metadata initialization share the profile mutation
  lock. A five-batch, eight-writer independent probe originally produced incorrect
  parent IDs in two batches and zero parent sizes in three; its repeated probe
  after correction had no broken relationships. The lock coordinates one server
  process, not arbitrary external writers.
- Explicit tool failure suppresses declared, scanned and streamed deliverables.
  Diagnostic partial files may remain on disk and are not claimed as delivered.
- Independent approval-history review found three false success classifications:
  `success: false`, `ok: false`, and `isError: true`. An actual protected invocation
  followed by receipt persistence initially failed all three cases. Approval
  history now uses the shared failure predicate; all four failure representations
  pass alongside the existing successful/redacted receipt cases (17 tests total).
- Streaming buffer pressure now uses finite passes, UTF-8 byte accounting and
  chronological replay with a strict 4 MiB / 10,000-event budget. Oversized events
  reach live subscribers intact but are excluded from replay. The initial fix
  passed 14 registry tests, then an independent late-subscriber probe exposed a
  missing completion event. Terminal delivery now tracks each subscriber; the
  exact repeated probe delivered one `done` to both the original subscriber and
  the late subscriber. The final registry plus HTTP-stream target passed 28 tests,
  108 assertions. RT01–RT05 remain bounded-window guarantees, not complete replay
  of an arbitrarily large conversation.
- Python stdout/stderr are bounded in UTF-8 bytes, signal exits are failures, and
  timeout/cancellation/normal exit clean up the owned POSIX process group.
- Protected skill restoration runs on rejection, preserves the original error,
  coordinates cooperative writers, and restores symlinks, dangling links,
  permissions and empty directories without following external targets.
- Independent file producers exposed XLSX relationship, comment, validation and
  conditional-format losses; the bounded supported cases are now preserved.
  PDF extraction reads actual LibreOffice text and reports scan gaps. Ordinary
  PDF form values, explicit comma decimals, merged PPTX anchor edits and readable
  new CSV imports were added through the same protected tool boundary.

The complete scripts run also exposed four channel scenarios expecting an obsolete
fixed output name. The corrected oracle correlates each request with its exact
returned version path, compares captured outgoing bytes with server downloads,
and inspects actual workbook values. It does not accept an arbitrary `.xlsx`.
The initial scripts suite was **29 pass / 1 fail** (four failed internal scenarios);
the corrected run was **30 pass / 0 fail**, 93 assertions across 9 files. After
adding standalone browser evidence regressions, the complete scripts target
passed **42 tests / 117 assertions across 10 files**. These overlap with some root
tests and must not be added to the root count as unique tests.

### Evidence quality and broader checks

The [21-case corpus](daily-files-corpus.md) was rerun seven times, retaining every
attempt and oracle correction. The latest structural/content outcome is **16
fulfilled / 5 unsupported / 0 observed content failures**. Unsupported is not
success. [Visual QA](daily-files-visual.md) inspected 30 pages from 24 returned
references, including intermediates and an unchanged unsupported source. Initial
fontconfig and import-layout failures remain in the before/after evidence.

The [24-case harness/channel ledger](harness-channel-deep-audit.md) records real
HTTP, SQLite, protected file tools, process restart, cancellation and delivery
retry boundaries. Codex JSON-RPC and installed Claude MCP tests now include real
file effects and SQLite persistence: 9 cases, 134 assertions. Model peers remain
controlled. Nine complete channel-handler scenarios use mocked outbound
messenger transports; live delivery is not established by them.

Source review found synthetic sleeps/hardcoded workload values and unconditional
PASS/GO reporting in readiness scripts. Those reports now retain NOT_RUN,
NOT_ESTABLISHED and blocked outcomes. Report-writer tests verify honesty; they
do not measure production load, resource consumption or recovery time.

Whole-workspace builds passed. Root and web TypeScript checks passed; the mobile
project separately passed with its installed TypeScript **6.0.3**, without changing
the workspace linker or adding overrides. Documentation's initial sandboxed
Next.js build stalled and was terminated after approximately 15 minutes; the
same build outside that restriction completed with the actual Google-font fetch
and static page generation. Build output is local, not deployed. Repository-wide
lint caught formatting omissions that changed-file lint missed; the final global
check includes the durable JSON evidence.

### Maturity decision

**Not established; no platform-parity or tenant-isolated deployment claim.**

PY06 actually read a synthetic file outside its profile. Python and Bash retain
the server account's filesystem access; a working directory, virtual environment,
approval and post-run restoration do not impose an OS sandbox. Arbitrary escaped
process groups, Windows tree containment and host resource limits are not proven.
See [the Python boundary audit](python-execution-boundary-audit.md).

OCR, tracked-revision edits, chart-workbook mutation, catalog-preserving PDF merge
and the supplied oversized multilingual font/layout case remain unfulfilled.
Live Claude is blocked by missing Atlas-isolated authentication. Live messenger
sends were not performed. Docker build/render validation is blocked by an
unavailable daemon. Approval after process crash is refused, but the stored
`pending` label remains a recovery/status gap. None is hidden by the passing
tests or converted into a capability pass.

Machine-readable counts, failure names and log hashes:
[deep-run summary](validation/deep-run-summary.json). Raw local logs remain under
`/private/tmp/atlas-deep-20260906/`; independent corpus and sanitized channel
ledgers also live in this repository with reproduction scripts.
Independent root probes are retained under
[root adversarial evidence](validation/root-adversarial/), including the failed
Python isolation requirement and before/after publication races.

The file inventory contains 641 test-named files at this checkpoint; the full
target plus `bun test scripts` executed 640 distinct files. The remaining
`scripts/e2e-browser-test.ts` is a standalone browser script outside Bun's test
discovery. Its original checks could match the user's own prompt, logged fatal
browser errors without failing, and announced 100% success; it also embedded a
fixed login and host output path. Those defects are corrected: the script requires
an explicit disposable fixture and only classifies new assistant-display
observations. It leaves tool execution, file fidelity, inference and Python
isolation `NOT_VERIFIED`. The actual run without fixture configuration returned
`NOT_RUN` and exit 1 before browser startup or login; its
[report is retained](validation/root-adversarial/browser-standalone-not-run.json).
Twelve configuration/evidence tests pass, but this standalone live browser
workflow was not performed. Earlier local document UI evidence remains separate.

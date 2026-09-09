# Validation coverage audit

Audit date: 2026-09-06. This is an independent review of the evidence and the
repository's acceptance tooling, not a release certificate. It records the
acceptance matrix before the new held-out corpus and full repository rerun are
evaluated. The earlier selected regression results are historical observations;
they cannot substitute for the remaining cells below.

## Acceptance rules declared for this audit

A result is identified by `(revision, runtime/dependencies, provider instance and
model, file format and operation, channel, fixture, oracle)`. Changing any of
these does not automatically inherit the prior result.

Use these outcomes independently of a test runner's process exit code:

- **Verified**: the declared operation ran through the stated boundary and an
  independent oracle checked the requested result and source preservation.
- **Failed**: wrong content, invalid output, silent loss, false success, broken
  continuation, unauthorized effects or an acceptance assertion failed.
- **Unsupported**: Atlas explicitly refused a feature it cannot handle. Source
  preservation may pass a safety assertion; the requested operation did not pass.
- **Blocked**: a required credential, runtime, daemon or environment capability
  was unavailable. Keep the failing command and reason; do not relabel it passed.
- **Not run**: no execution evidence exists for that matrix cell.
- **Mock/fixture only**: useful boundary evidence, but not verified live inference,
  document fidelity or external channel delivery unless those were also exercised.

For each supported file operation, acceptance requires a producer independent of
the code under test where practical, a content/structure oracle, exact source
hashes, valid output parsed by an independent reader, and explicit coverage of
omitted features. Editing also requires unaffected content to survive. Visual
operations require rendered output inspection. File extensions, `PK` signatures,
tool call counts, screenshots of a chat reply, and refusal-only tests are not
document correctness oracles.

Each complete integration cell additionally requires actual schema acceptance by
the named provider/SDK, dependent tool calls through Atlas's dispatcher, canonical
history/checkpoint receipts, persisted result download, filename/MIME agreement,
and a subsequent turn using the saved reference. Channel cells require the
appropriate org/user/profile binding, original caption/reference continuity,
delivered result bytes and explicit handling of upload failure. Live external
delivery needs an authorized test recipient and a platform receipt; a send mock
cannot supply that evidence.

## Matrix dimensions

The required matrix is the cross-product of these dimensions. The tables below
are a sparse inventory, not a claim that testing each axis separately covers the
cross-product.

| Dimension | Declared cases |
| --- | --- |
| Provider/transport | OpenAI API; Anthropic API; Gemini API; one explicitly configured compatible API endpoint; Codex subscription runtime; Claude subscription runtime. Record exact endpoint, model, SDK/CLI and auth source. Other providers remain separate untested cells. |
| DOCX | Create; inspect/read; text replacement across runs; table edit; preserved images/links/header/footer; explicitly classify fields/tracked changes/nested or merged tables. |
| PPTX | Create; inspect/read in presentation order; text/table/notes edit; preserved relationships/master/media; independently inspect grouped shapes, charts and multilingual layout. |
| PDF | Create/render; inspect; selected-page extraction; merge; split/reorder; Office conversion; forms/scans/signatures/bookmarks/attachments classified separately. |
| XLSX | Create; inspect; range read/edit; style/sheets; formula cache invalidation; actual recalculation; import/export; dates, precision, structured tables and unsupported features. |
| CSV/data | IDs/large integers/quotes/multiline values; explicit locale/delimiter/type conversion; formula-like text; JSON/JSONL/TSV/TXT/Markdown source materialization and bounded reading; Python analysis where assigned. |
| Channel | Web, CLI, Telegram, WhatsApp, Discord. Distinguish local mock transport from real platform delivery. |
| Lifecycle | Single and dependent actions; permission/approval; cancel before and after effects; clear/reopen/restart; stale reference; tenant separation; missing runtime; malformed and oversized input/output. |

## Observed provider and channel coverage

| Provider boundary | Local file engines / dispatcher | Live inference with daily files | Web/CLI integration | Telegram / WhatsApp / Discord |
| --- | --- | --- | --- | --- |
| OpenAI API | Mock `ProviderClient` loop, HTTP/provider contract tests; actual engines tested separately | Not established for the full matrix | Local web QA used a localhost mock model; does not prove upstream schema acceptance | Handler tests/mock send adapters; no live platform receipt |
| Anthropic API | Provider-specific contract/cassette tests; not a complete file-operation run | Not run in the retained daily-file evidence | Not run for this matrix | Not run with live provider plus platform |
| Gemini API | Provider-specific contract/cassette tests; not a complete file-operation run | Not run in the retained daily-file evidence | Not run for this matrix | Not run with live provider plus platform |
| Compatible API | Release gate uses a local mock endpoint. Optional TokenRouter smoke has a separate request/response ledger | Optional smoke is one endpoint/model, not all formats/operations | Older OpenCode Go scripts use the configured workspace; they are not acceptance evidence without their run records | No complete live file/channel matrix |
| Codex SDK 0.150.1 | Dynamic-tool protocol/runtime tests; H11 additionally runs actual JSON-RPC through the harness, protected file tools and reopened SQLite with a controlled process peer | Retained trace: four dependent DOCX/PPTX/XLSX/PDF tasks, 24 callbacks; one selected model | Native runtime task evidence, not every web/CLI interaction | No live channel delivery evidence tied to those four tasks |
| Claude SDK 0.3.247 | Actual SDK MCP registration with in-memory transport; H12 additionally runs the real harness, protected file tools and reopened SQLite; model loop controlled by tests | Blocked in the recorded isolated Atlas configuration: `not_authenticated` | Local runtime/persistence boundary, no live CLI or HTTP authentication flow | No live provider/channel matrix |

The [Codex trace](../adr/validation/0004-daily-files-native-trace.json) records
authentication/runtime/model selection, completed tool operations, persistence
counts, recalculation to `20`, and source-preservation checks. It is evidence for
those four tasks, not a randomized or comprehensive workload. The sanitized trace
does not contain the complete request/response bodies and fixture/output hashes
needed to independently replay the entire experiment from that file alone. It
also explicitly records an injected test LibreOffice path; it does not prove the
deployed image owns that dependency.

No API credential availability is inferred from the lack of a run. This audit
does not inspect or copy credentials from other applications, initiate login,
or send live channel messages. Docker was blocked in the prior recorded check
because `/var/run/docker.sock` was unavailable. A host Python/LibreOffice run
does not establish the Docker build or runtime result.

## What the executable tests actually establish

| Evidence location | Actual work exercised | What it does not establish |
| --- | --- | --- |
| `packages/agent/src/chat-daily-files.test.ts` | Real PDF engine and file writes, shared dispatcher, checkpoint callback and artifact selection in API-shaped and SDK-shaped loops | Both provider objects are programmed stubs. Their names `openai` / `chatgpt` do not exercise actual API/SDK schema registration or inference. |
| `apps/server/src/providers/subscription/{chatgpt,claude}/*test.ts` | Runtime registration, request routing, duplicate IDs, errors, continuation, cancellation and approval behavior; actual Claude MCP protocol library | Model decisions are controlled. Passing protocol tests does not establish real model reasoning or complete file semantics. |
| `chatgpt/structured-harness.test.ts` | Actual JSON-RPC client, app-server adapter, runtime/provider and Atlas dispatcher; dependent inline tools, replay and disconnect | Tool effects and canonical checkpoints are arrays in memory. The native session binding is file-backed, but this is not a protected file-tool or SQLite conversation-persistence test. |
| `chatgpt/structured-harness-persistence.test.ts` (H11) | Actual JSON-RPC client/app-server/runtime/provider, real harness and protected file tools, file-backed SQLite checkpoint/reopen. Five cases cover dependent read/resume, identical-call replay, conflicting call IDs, transport disconnect after the write receipt, cancellation held after the effect but before checkpoint/acknowledgement, and blocked path with recovery. Exact source/output bytes and a single output artifact are checked. | Native process/authentication/inference are controlled peers. This is a Unicode text file, not Office parsing or a live provider/schema test. Simulated transport disconnection and SQLite reopen do not prove OS-process crash or transaction recovery. |
| `claude/structured-harness-persistence.test.ts` (H12) | Actual installed SDK MCP server with raw requests, Claude runtime/provider, real harness and protected `write_file` / `read_file`, file-backed SQLite checkpoint and reopen. Four cases cover dependent read and native resume, identical-ID replay, conflicting-ID failure, blocked path with recovery, and cancellation after a real write but before its checkpoint/acknowledgement. | Authentication/model generation and query lifecycle are controlled peers. No live Claude CLI, upstream inference, HTTP authorization/approval or Office engine is exercised; the file is exact Unicode text. SQLite reopen is not process-crash recovery. Earlier `runtime-structured-tools.test.ts` tests still use supplied callbacks and manually appended receipts. |
| `packages/core/src/office-document/office-document.test.ts`, `tools/pdf-document.test.ts`, `tools/spreadsheet*.test.ts` | Actual file engines, parsers, source preservation and operation-specific assertions | Fixture coverage remains finite; newly rejected features are unsupported, not successful edits. |
| `artifact-preview/office-worker.test.ts` | Actual local LibreOffice conversion when a binary is available | Five cases use `skipIf` when unavailable. A suite without failures does not by itself prove conversion ran. |
| `tools/spreadsheet-roundtrip.test.ts` | Actual recalculation when LibreOffice exists; missing-runtime behavior tested separately | Before this audit, the test named “recalculate verifies real LibreOffice…” could return successfully after only asserting missing-binary rejection. The audit requested a separate skip/refusal classification. |
| `apps/platform/telegram/src/document-roundtrip.test.ts` | Exact medium-size byte continuity, filenames/MIME metadata and saved workspace paths across all three channel adapters | Input is a padded text buffer named `.pdf`, `.docx`, `.pptx`, `.xlsx`, etc. This deliberately tests byte transport, not valid documents, parsing, editing or rendering. Outbound calls are mocked. |
| `scripts/channel-loop-harness` | Real isolated Atlas server/database plus actual channel handlers and tool execution; CSV/XLSX/TXT fixtures; mocked model/download/send | Nine scenarios cover selected WhatsApp flows, Telegram CSV and Discord XLSX. Its output checks include nonempty bytes/`PK`, not full workbook content or general document integrity. No external platform is contacted. |
| Local web QA and `apps/web/scripts/check-document-reopen.ts` | Browser upload/reopen/download continuity with real local server and persisted attachment IDs | The model is a localhost mock. Prepared-session reopen checks are not a complete create/edit workflow or live provider test. |
| `scripts/file-runtime/verify.py` | Real Python file libraries and operation checks when executed through the configured runtime | Pinned direct packages and a host Python 3.14 run do not establish transitive reproducibility or an unbuilt Python 3.11 Docker environment. |
| `*.llm.test.ts` plus `llm-msw-cassette.ts` | Recorded HTTP exchanges replayed offline by default when a cassette exists | Replay is not a current upstream call. `auto` can record when no cassette exists; explicit `replay` is needed for a guaranteed offline rerun. |

The new held-out fixtures and independent oracles are declared in
[daily-files-corpus.md](daily-files-corpus.md). Record its results separately,
including every unsupported/failed case, before expanding any capability claim.
The deeper route/protocol/persistence cases are declared separately in
[harness-channel-deep-audit.md](harness-channel-deep-audit.md). H11/H12 now supply
the previously missing real file-tool/SQLite boundary; this does not close their
live inference, HTTP/channel or process-crash cells. The earlier array-backed
and direct-callback fixtures alone did not supply that boundary.

## Readiness gate audit and bounded corrections

| Runner or report | Defect found | Correction / remaining scope |
| --- | --- | --- |
| Production workload A–F and soak | Bodies are sleeps with fixed replies/token values. Soak browser/Office/process/DB/temp/zombie fields contain constants; cache eviction totals are estimated. | Reports now identify synthetic provenance. Those counters remain diagnostic placeholders, not measured cleanup proof. No real load workload was added by this reporting fix. |
| Production report writer | Hardcoded PASS for release gate, Golden Journeys, provider contract, stability, cleanup and rollback; unconditional Controlled Beta GO in the matrix | Removed the invented maturity table. Report outcomes derive from supplied checks, missing checks stay NOT_RUN, production readiness stays NOT_ESTABLISHED. The command exits nonzero for incomplete readiness. |
| Production decision | Could call the run MATURE from only local rollback and soak; saturation `50/65` and bottleneck were literal values | Removed MATURE/GO and unmeasured saturation values; failing admission, fairness, cancellation, containment or audit facts remain blocking. |
| Rollback level 1 | Returned all success flags without executing an operation | Explicit NOT_RUN; no schema/lifecycle safety claim. |
| Rollback level 2 | Two inline HTTP fixture servers carry version labels | Useful process/proxy exercise, now labeled accordingly; no actual Atlas binaries or database migration rollback. |
| Rollback level 3 | One healthy `GET /health/ready` claimed deployment, rollback and backward-compatible migrations | Health is reported separately; deployment/rollback flags remain false, migrations and post-rollback smoke remain NOT_RUN. |
| Release decision engine | Empty/optional-only inputs and required warnings could yield RELEASE | These now block. A passing core gate remains scoped to its supplied deterministic checks; optional live provider status is separate. |
| Release suite wording | PPTX slide count/CSV row count called general Office fidelity; a pure queued-state override called process/artifact cleanup; port checks called zero orphan processes | Descriptions now state the exact assertions and unmeasured boundaries. |
| TokenRouter smoke | Missing env key could silently fall back to a developer-specific scratch credential path | Requires explicit `TOKENROUTER_API_KEY`; missing credentials block before inference. The smoke still covers only its configured endpoint/model. |
| Live-human runner | Report claimed “real API, no mock LLM” without proving upstream identity; `claimedSent && blocked` was unreachable because `claimedSent` already excluded blocked results | Provider inference labeled unverified; contradictory send/approval evidence now fails. These post-run checks remain heuristic and do not verify workbook cells or independent delivery receipts. |

The live-human scripts also modify profile/tool assignments and include external
send requests. They were inspected, not executed during this audit. Their timeout
wrappers race promises without themselves cancelling the underlying turn, and
their broad workspace selection makes them unsuitable as an isolated release
gate without further work. UI token assertions in Golden Journeys may match
whole-page text; screenshots and token presence are weaker than artifact or
persisted-tool oracles. These remaining gaps are not converted into pass statuses.

## Current result ledger

- The earlier **1002 tests / 79 files** result in
  [daily-file-readiness.md](daily-file-readiness.md) is a selected regression
  snapshot, not the full repository test command and not the Cartesian matrix.
- A repository inventory during this audit found over 600 test files under
  `apps`, `packages` and `scripts`; file count is not coverage and excludes no
  failures by itself. Complete command results and the final inventory are in
  [the deep-validation ledger](deep-validation-run.md); the initial failures
  remain recorded separately.
- Initial full-run findings reported to this audit include three capability /
  image-fallback failures and sandbox socket failures. A minimal socket bind
  reproduced the environment restriction; that diagnosis does not erase the
  failing run or establish that all other failures are environmental.
- Global lint initially found two formatting issues in the existing web HTML.
  They were corrected before repeating the global check. The earlier changed-file
  lint result was not a prior global lint pass.
- Actual upstream acceptance of the new Office tool schema exposed a separate
  root-schema issue. The schema is corrected and independently checked across
  provider serialization paths. A successful fake `ProviderClient` callback
  alone could not close that failure.
- PY06 reproduced Python reading a synthetic file outside its profile workspace.
  [The trust-boundary audit](python-execution-boundary-audit.md) records that
  failed isolation requirement, additional process/protected-write findings and
  why the existing JavaScript sandbox cannot be called as a generic Python
  launcher without further implementation and actual macOS/Linux validation.
- H12's retained attempt ledger: `/tmp/atlas-h12-attempt1.log` failed test setup
  with an incorrect import path; `attempt2` ran 61 assertions but failed all four
  cases because cleanup called a nonexistent runtime method. Those test harness
  defects were corrected without product edits. `attempt3` passed four cases;
  `attempt4` added no-early-acknowledgement and cancellation-drain assertions and
  passed **4 tests, 62 assertions**. The standard TypeScript check and scoped
  Ultracite check passed (`/tmp/atlas-h12-typecheck.log`,
  `/tmp/atlas-h12-lint.log`). These logs are local run records, not committed
  reproducible provider traces.
- H11's first run passed **5 tests, 72 assertions**
  (`/tmp/atlas-h11-attempt1.log`). The final joint H11/H12 run passed **9 tests,
  134 assertions** across the two new files
  (`/tmp/atlas-h11-h12-final-tests.log`). Standard TypeScript and scoped
  Ultracite checks also passed (`/tmp/atlas-h11-h12-typecheck.log`,
  `/tmp/atlas-h11-h12-lint.log`). No product code was changed to obtain these
  held-out runtime/file/persistence results.
- The independent corpus, full suite, global checks and visual inspection now
  have separate [complete evidence](deep-validation-run.md). Unsupported corpus
  operations and the blocked Docker build remain explicit gaps.

The reporting corrections have focused regression tests. Passing them establishes
truthful classification, not that missing product capabilities or deployment
evidence have been supplied.

## Standalone browser screenshot smoke

The final inventory identified `scripts/e2e-browser-test.ts` as a standalone
entry point outside Bun's normal test-file discovery. It previously contained
hardcoded developer credentials and a developer-specific screenshot directory,
matched text anywhere on the page (including the submitted user prompt), ignored
some console errors, warned on remaining errors and printed an unconditional
100% success claim. Those were reporting and portability defects, not additional
successful browser coverage.

The revised runner requires an explicitly prepared fixture through:

- `ATLAS_TEST_BASE_URL`: fixture HTTP(S) origin.
- `ATLAS_BROWSER_FIXTURE_EMAIL` and `ATLAS_BROWSER_FIXTURE_PASSWORD`: credentials
  created for that fixture, not a user's existing account.
- `ATLAS_BROWSER_FIXTURE_ORG_ID`: fixture organization to select after login.
- `ATLAS_BROWSER_FIXTURE_CHAT_PATH`: an existing
  `/chat/{profileId}/{sessionId}` belonging to that fixture. It must have the
  intended provider and tool assignments ready. The five prompts create files
  and execute tools when those capabilities are available; run only against
  the disposable fixture.
- Playwright's Chromium installation and the already running fixture server.

`ATLAS_BROWSER_OUTPUT_DIR` optionally selects an absolute output parent. Each
run creates a fresh private subdirectory there; the default uses the OS temporary
directory. The runner records new assistant markdown observations and screenshots
after the UI stops responding, never matches the whole document body, and fails
on browser errors or missing observations. `UI_SMOKE_PASSED` means only those
display checks passed. Tool execution/persistence, file content/fidelity,
provider inference and Python isolation remain `NOT_VERIFIED`; a refusal that
mentions the requested filename can satisfy only the display observation.

**Actual browser workflow: NOT_RUN.** No fixture login was performed during this
correction. An explicit run with `ATLAS_TEST_BASE_URL` removed exited **1** before
launching Chromium and wrote a `NOT_RUN` report with all five scenarios missing:
`/private/tmp/atlas-browser-standalone-no-fixture.log` and
`/private/tmp/atlas-browser-standalone-evidence/atlas-browser-smoke-eSkEO0/report.json`.
The new configuration/reporting regressions pass **12 tests, 24 assertions**
(`/private/tmp/atlas-browser-evidence-final-tests.log`). They include the actual
standalone prerequisite-refusal path, not browser login or tool execution.

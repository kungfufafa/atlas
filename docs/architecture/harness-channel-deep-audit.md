# Harness and channel adversarial audit

Predeclared: 2026-09-06, before this audit's experiments. This audit challenges
production entry points and failure paths; earlier passing counts are historical
evidence, not substitutes for these cases. All attempts, including setup failures
and regressions, stay in the attempt ledger. No live channel messages or host
credential copying are authorized for this audit.

## Evidence classes and result rules

- **Live**: an actual provider or channel service performed the operation. Local
  browser/server activity is named explicitly and is not live model/channel proof.
- **Protocol**: the real SDK/adapter protocol implementation runs against a
  controlled peer; no claim about live inference or provider availability.
- **Mock transport / real stack**: controlled model or channel I/O with real Atlas
  handlers, protected tools, SQLite persistence and original artifact bytes where
  stated. Each result names any substituted layer.
- **Blocked**: prerequisites prevent execution. Atlas's isolated Claude runtime
  is known to be unauthenticated; live Claude inference cannot pass in this audit.
- **Unsupported**: the implementation deliberately lacks the requested guarantee.
- **Pass / fail / not run** are separate from evidence class. A narrower passing
  test does not turn a blocked, unsupported or unexecuted surface into a pass.

## Predeclared matrix

| ID | Surface and challenge | Required observation / failure oracle | Planned evidence | Initial result |
| --- | --- | --- | --- | --- |
| H01 | API nonstream: dependent create → inspect → edit with real file tools | Later input depends on prior returned path/revision; source unchanged; canonical pairs and output bytes survive retrieval | Real HTTP/Hono + SQLite + mock model | Not run |
| H02 | API streaming: same dependent workflow | Same effects/history as H01; SSE completion only after checkpoint; no duplicated deliverable | Real HTTP/Hono + SQLite + mock model | Not run |
| H03 | API malformed arguments and unassigned/unknown tool | Protected tool never executes; structured failure is visible; next valid call can recover without invented success | Real server/tool boundary + mock model | Not run |
| H04 | Approval approve versus deny, API and SDK callback paths | No effect before approval; approval executes once; denial executes zero times; durable decision/receipt agrees | Real server/SQLite + protocol where feasible | Not run |
| H05 | Approval wrong user, wrong org, duplicate and stale decision | Foreign decisions rejected; repeated approval cannot repeat effect; no leaked cross-tenant result | Real auth/routes/SQLite | Not run |
| H06 | Disconnect SSE client after accepted turn, reconnect/read history | Declared disconnect semantics match actual effect count and durable transcript; no lost completed tool or duplicate file | Real HTTP stream + SQLite + mock model | Not run |
| H07 | Cancel while approval is pending; then send late approval | Pending work stops; zero protected mutation; late decision cannot claim resumed execution | Real routes/SQLite + mock model | Not run |
| H08 | Cancel/disconnect after a side effect starts but before tool acknowledgement | Started action drains or is explicitly unconfirmed; completed evidence is retained; replacement turn cannot steal result | Real harness/persistence + held callback | Not run |
| H09 | Restart after a completed file turn | New process/service reopens same SQLite state; original attachment and output bytes remain addressable; no replayed effect | Real file-backed SQLite restart | Not run |
| H10 | Restart with approval still pending | Stored approval alone cannot resume execution; no automatic mutation/replay; status is explicit | Real file-backed SQLite/service restart | Not run |
| H11 | Codex same-ID replay, conflicting replay, tool failure and disconnect | Actual JSON-RPC/runtime callback boundary performs no duplicate effect; conflict fails; completed pairs survive disconnect | Real Codex adapter protocol + real harness/tool | Not run |
| H12 | Claude equivalent replay/error/cancellation/continuation | Actual SDK MCP handlers preserve schema and action identity; completed effects/history are honest | Real installed SDK/MCP + real harness/tool | Not run |
| H13 | Live Claude inference | Requires authenticated Atlas-isolated Claude session; protocol tests are not a substitute | Live | Blocked: isolated runtime not authenticated |
| H14 | Web attachment continuity and server rejection boundary | Original bytes and scoped IDs survive turn and restart; over-limit/unsupported input cannot be silently accepted or dropped | Real server/SQLite, browser evidence where applicable | Not run |
| H15 | Telegram inbound small/medium file and guest without storage authority | Authorized source retains exact bytes; guest fallback clearly marks incomplete coverage; no accidental source deliverable | Production channel handler + mock Telegram transport | Not run |
| H16 | WhatsApp equivalent inbound and source continuity | Same storage/coverage contract as H15, with channel-specific limits explicitly applied | Production channel handler + mock WhatsApp transport | Not run |
| H17 | Discord equivalent inbound and source continuity | Same storage/coverage contract as H15, with channel-specific limits explicitly applied | Production channel handler + mock Discord transport | Not run |
| H18 | Telegram partial upload failure and download/output limits | Only acknowledged uploads may be claimed delivered; failed files retain usable path/link and retry semantics | Production delivery functions + actual artifacts + mock transport | Not run |
| H19 | WhatsApp partial upload failure and 25 MiB boundary | Boundary enforcement before sending; failure never becomes a success claim; exact sent bytes | Production delivery functions + actual artifacts + mock transport | Not run |
| H20 | Discord partial upload failure and 8 MiB boundary | Boundary enforcement before sending; failure never becomes a success claim; exact sent bytes | Production delivery functions + actual artifacts + mock transport | Not run |
| H21 | API ↔ Codex ↔ Claude error/approval/cancellation parity | Identify observable divergences rather than infer parity from shared types; distinguish intentional protocol constraints | Cross-case comparison of H01–H12 | Not run |
| H22 | Live Telegram/WhatsApp/Discord delivery | No live sends performed under this audit's authorization | Live | Not run: live sends excluded |
| H23 | Failed tool creates a partial file and returns or streams an artifact | Diagnostic file may remain on disk; embedded references and fallback scans must not promote it to a deliverable | Real protected execution + channel extraction | Added before failure reproduction |
| H24 | Relative artifact share link is refreshed after the worker registry reloads | A previously issued token survives refresh; loss of an uncached plaintext token is not misreported as a new usable link | Real local HTTP/share SQLite + worker registry + mock upload | Added after H18–H20 exposed share lifecycle assumptions |

The matrix is an audit plan, not a claim that every combination of provider,
channel and fault has already run. Cases may share a fixture, but every case must
name its actual executed boundary and evidence. Newly discovered cases are added
after this table and do not replace inconvenient predeclared cases.

## Attempt ledger

| Attempt | Cases | Executed boundary and substitutions | Outcome and evidence |
| --- | --- | --- | --- |
| 0 | All | Read production routes/runtime/channel source; wrote this matrix before experiments | Predeclared; no test outcome assigned |
| 1 | H23 | Real protected callback writes a partial CSV; four explicit failure payloads; canonical channel extraction | **5 failures before correction**, preserved in `/private/tmp/atlas-harness-channel-failed-artifacts-before.log` |
| 2 | H23 | Suppress declared/scanned artifacts for failed payloads; reject failed canonical references and artifact progress events | Core/extraction suite 52 passed and harness suite 10 passed at this intermediate point; later added undeclared-file regression |
| 3 | H01–H14 | First standalone HTTP fixture launch | **Setup failed**: ExcelJS import targeted root `node_modules`; `attempt1.log` retained |
| 4 | H01–H14 | Real production server + fresh SQLite + controlled OpenAI-compatible peer; actual protected file tools | `attempt2-report.json`: H01/H02 rejected omitted spreadsheet defaults; H03/H06 exposed text trimming; H14 fixture depended on the failed H01 output. H04 approve/deny and H07 pending cancellation passed. Mock continuation then threw because it assumed a successful prior result; this is preserved as a fixture failure after the real validation failure |
| 5 | H01/H02 | Input-schema fix through protected spreadsheet create/read; byte-preserving `write_file` tests | Initial combined run **75 passed / 1 failed**: a macOS symlinked temporary workspace exposed a separate path-return bug. Schema fixture normalized its root to isolate this assertion; the file agent independently fixed and tested alias-root publication. `schema-fix.log`, `schema-fixed2.log`: then 76 passed / 340 assertions |
| 6 | H01–H14 | Restarted isolated server with fixes; same HTTP cases | `report.json` / `attempt3.log`: all eight case variants passed. Four dependent XLSX calls ran in each of nonstream and streaming modes; follow-up paths/revisions came from actual tool results |
| 7 | H18–H20 | Actual AtlasClient → server history/artifact/share endpoints + SQLite, actual XLSX bytes and file-backed worker stores; external uploads mocked | `channels-attempt1-report.json`: all three upload/failure/retry/limit cases passed. Telegram's first publication returned relative links; the later independent worker stores had no tokens for the already-published artifacts. No live sends |
| 8 | H18–H20/H24 | Repeated shared-artifact fixture with an added assertion requiring every new worker store to recover a share link | **3 failures**, `channels-attempt2.log` / `channel-report.json`. The script caught case failures and originally exited zero; the report, not that exit code, is authoritative. Adding Origin did not solve this: existing-share refresh returns no plaintext token. The fixture reused the same artifacts across independent empty caches |
| 9 | H24 | Audited cache implementation and added a regression for first relative link → refresh → publication failure | Found and fixed a separate product bug: only absolute URLs were cached, so even the same worker lost relative links on refresh. 13 focused helper tests passed. A genuinely absent plaintext token in a new store remains unrecoverable by design |
| 10 | H05/H09/H10 | First restart-fixture attempts | `restart-attempt1-report.json`, `restart-attempt2-report.json`: mock nonstream response omitted tool calls, so no approval arrived and **no crash occurred**. The first script erroneously labeled a plain reread H09 pass; that label is withdrawn. A required `restarted` assertion was added and correctly failed on the second attempt |
| 11 | H09/H10 | Retry of isolated crash fixture | Automatic approval review rejected a possibly stale PID. Read-only `ps`/`lsof` confirmed the same owned Atlas PID 77658, original start time and workspace; no restarted PID file existed. Review then allowed the test. This was a safety prerequisite failure, not a product failure |
| 12 | H05/H09/H10 | Corrected mock peer; actual server SIGKILL during pending approval, then new server on the same SQLite database | `restart-attempt3.log`: H09/H10 passed; H05 failed its overly specific expected 403 because the real session privacy boundary returned 404. No cross-user mutation occurred. Restarted audit server PID was 80426 |
| 13 | H05 | Separate auth-only rerun, with no process restart | `approval-auth-report.json`: wrong user 404, wrong org 404, original owner denial 200; foreign requests cannot execute the pending action |
| 14 | H15–H17 | Actual production attachment builders + workspace save and actual local HTTP/session persistence; channel download and model mocked, paired/unpaired branch selected explicitly | `inbound-report.json`: all three builders preserved a valid 6,470-byte XLSX and a valid 7,583,899-byte CSV with escaped quotes/multiline fields. Guest medium-file fallback wrote no workspace file and declared missing/truncated coverage. This does **not** execute pairing selection in the full worker chat handler |
| 15 | H14 | Real HTTP rejection before inference/persistence | `boundaries-report.json`: oversized document, six attachments, and malformed base64 all rejected with 400 and unchanged history. The oversized response currently calls the data invalid base64; the rejection is correct but its explanation is misleading |
| 16 | H24 | Fresh, previously unshared H02 artifacts; real share publication, registry reload, refresh, upload failure and `/attach` | `cache-refresh-report.json`: passed; relative tokens remained identical across refresh and the retried XLSX bytes matched. Boundary checks used explicit synthetic byte buffers only for size limits, not as document-fidelity evidence |
| 17 | H01/H02/H03/H23/H24 | Final focused shared-boundary regression | `focused-regression.log`: 64 passed, 0 failed, 230 assertions across 6 files. This is a selected suite, not the whole repository |
| 18 | H24 | Revised fixture retained all refresh upload attempts instead of resetting its captured-call array | Second run failed because fixture initialization overwrote its own loaded token cache; `cache-refresh-attempt2-report.json` retained. Third run explicitly revoked only the two local H02 fixture shares, issued fresh shares and retained all five uploads; `cache-refresh-report.json` passed |
| 19 | H08/H11/H12 | New real protected-file/SQLite fixtures beneath actual Codex JSON-RPC and installed Claude MCP | `protocol-persistence.log`: 9 tests / 134 assertions passed. Codex 5 cases, Claude 4; both exercise duplicate replay, conflict, invalid-path recovery, native resume and cancellation after a written effect before receipt acknowledgment. Codex also injects peer disconnect. Native authentication/inference remains controlled |
| 20 | H15–H17/H21 | Root's unfiltered scripts suite reached the full production channel chat-handler harness | `channel-full-handler-before.log`: 5 of 9 scenarios passed; 4 failed because the oracle expected the requested filename instead of the actual versioned output. Corrected oracle correlates each tool call with its returned path, requires exactly that captured filename, compares transmitted/server bytes and parses exact XLSX cells or Markdown. Then `channel-full-handler-regression.log`: 9 of 9 scenarios passed; none suppressed |
| 21 | H01–H04/H06/H07/H08/H11/H12/H14/H15–H17/H23/H24 | Portable repository runner in a second fresh temporary server/config directory | `portable-runner-report.json`: HTTP case runner exit 0 with all eight case variants passed; separate protocol/channel/shared-boundary suite 35 tests / 241 assertions passed, including the 9 full-handler scenarios inside one test. Runner stopped its own server. These are selected checks, not the whole repository |

Historical local script reports and source fixtures above live under
`/private/tmp/atlas-harness-channel-audit/` unless an absolute path says otherwise.
Reports retain failures and setup mistakes. Runners now complete their per-case
ledger before returning a failure exit code for unexpected failures; historical
zero exit codes from catch-and-continue fixtures are not passing evidence.

Sanitized durable reports, including failed attempts and withdrawn claims, are
saved in [validation/harness-channel-deep-audit.json](validation/harness-channel-deep-audit.json).
The portable runner is `bun run scripts/harness-channel-audit/run.ts`; see its
README for exact included boundaries and omissions. It repeats the principal
HTTP/SQLite, SDK protocol and full channel-handler cases, while the historical
OS-crash and local browser experiments remain separate evidence. The historical
audit server PID 80426 was explicitly stopped after identity/port verification;
temporary evidence remains available.

## Results by predeclared case

| Cases | Current result | Actual boundary and limitation |
| --- | --- | --- |
| H01/H02 | Pass after fix | Actual HTTP streaming/nonstream → production AgentService → protected spreadsheet → SQLite; model I/O controlled. Source amount 7 remained unchanged while the versioned result became 18; IDs `00123` and `9007199254740993` survived |
| H03 | Pass after fix | Unknown tool and invalid spreadsheet data returned errors; a subsequent real CSV write recovered with exact trailing newline |
| H04 | API variants pass; SDK HTTP integration not run | Actual approval route and SQLite: file exists before approval; approved delete executes once; denial leaves it intact. SDK approval transport has separate protocol tests, not this real HTTP fixture |
| H05 | Pass | Real second authenticated org admin cannot approve another user's private chat (404); wrong org also 404; duplicate/late owner decisions 409 |
| H06 | Pass | Aborting the originating SSE connection cancels the turn; already completed write and its single canonical pair remain, and session status becomes inactive. This is not detached background continuation |
| H07 | Pass | Abort while waiting for approval leaves the source file intact; later approve returns 409 |
| H08 | Both SDK protocol/persistence variants pass | Codex and Claude held callback/checkpoint tests cover cancellation after the real write but before acknowledgment; reopened SQLite contains exactly one canonical pair after draining. Equivalent HTTP mid-write fault injection has not run |
| H09 | Pass | After an actual new server process opens the same file-backed SQLite, canonical history is unchanged; original attachment SHA-256 and generated XLSX bytes remain addressable |
| H10 | Bounded behavior passes; automatic execution resume unsupported | After SIGKILL, file remains intact, active status is false, and late approval returns actionable 409. SQLite approval remains `pending`; this stale stored label is a known recovery/status gap |
| H11 | 5 protocol/persistence cases pass | Real JsonRpcStdioClient → CodexAppServer/runtime/provider → harness → protected write/read → SQLite reopen. Duplicate replay, conflict, peer disconnect after checkpoint, cancellation before receipt acknowledgment, invalid-path recovery and native resume; no live Codex inference in these fixtures |
| H12 | 4 protocol/persistence cases pass | Real installed SDK MCP → Claude runtime/provider/harness → protected write/read → SQLite reopen, with duplicate replay, conflict, cancellation, invalid-path recovery and native resume. Native query/authentication is controlled; not live Claude inference |
| H13 | Blocked | Atlas's isolated Claude runtime reports `authenticated:false`, `status:not_authenticated`, runtime `2.1.247 (Claude Code)`. No login or host-token copy initiated |
| H14 | Pass at server boundary; browser rerun not performed here | Exact uploaded XLSX/download bytes, scoped attachment ID and restart persistence; unsupported, oversized, too-many and invalid-base64 inputs rejected. Earlier browser QA remains historical, separately labeled evidence |
| H15/H16/H17 | Builder/storage cases and full-handler scenarios pass with controlled transports | Small XLSX goes through real HTTP persistence; medium multiline CSV is stored byte-for-byte; guest medium fallback makes no workspace write. Separate full chat-handler harness executes actual worker identity mapping/config, worker-scoped client/server and tools for small-file/allowlist scenarios. External incoming events, downloads, model and outgoing sends remain fixtures; medium-file guest pairing selection is not separately proven through the full handler |
| H18/H19/H20 | Scoped delivery integration passes | Production delivery functions and real AtlasClient/server/artifact history/store; one accepted upload, one rejected upload, then successful `/attach` after store reload. External send acknowledgments are mocked. Telegram/WhatsApp enforce 25 MiB; Discord 8 MiB; exact limit accepted and +1 rejected before send |
| H21 | Comparison documented; general parity not established | Shared tool execution does not imply identical transport, approval UI, resume or delivery behavior; see divergences below |
| H22 | Not run | Live Telegram/WhatsApp/Discord sends excluded from audit authorization |
| H23 | Pass after fix | Explicit failed result cannot publish declared or automatically scanned artifacts, emit artifact progress, or regain a deliverable via detached streamed refs; the diagnostic file stays on disk. Later successful independent files remain deliverable |
| H24 | Pass after cache fix; absent-token recovery unsupported | Same-worker relative token survives registry reload/refresh/publication failure. A new independent store cannot reconstruct a previously issued token from the server's hash |

## Findings and unresolved gaps

Four concrete shared-boundary bugs were corrected here:

1. `jsonSchemaFromZod` now describes **input**, so protected validation accepts
   omitted defaults before the handler applies them. Preprocessors retain
   explicit advertised types; all 25 core built-in schemas compile and no property
   silently became an empty schema. Unsupported schemas still fail closed.
2. `write_file` preserves exact text bytes, including leading/trailing whitespace
   and empty files. The prior trimming corrupted valid CSV/text formatting.
3. Explicit failed payloads no longer promote partial files into artifacts via
   declared references, fallback filesystem scanning, canonical history or
   streamed progress. Failed diagnostics are retained without claiming delivery.
4. Channel share caches retain relative links as well as absolute URLs, avoiding
   loss of an already-issued token on the same worker's next refresh.

The evidence still has deliberate limits. HTTP/SSE cancellation is tied to the
originating request; the server does not promise an indefinitely detached turn.
Process-crash exactly-once effects and native RPC reattachment are not existing
Atlas guarantees. Pending approval resumption after process restart is refused,
but its stored `pending` label has not yet been reconciled. Approval decisions
cannot be transferred between users simply because both are org admins.

Channel ingestion also differs by size: at most 5 MiB enters inline attachment
storage; 5–25 MiB uses a workspace source path for paired users. Guest fallback
only exposes bounded extracted text, and the guest-policy selection itself is
not proven by the builder fixture. Channel delivery acknowledges the external
send adapter separately from artifact creation. A saved-file path or share link
is not proof that a remote attachment was accepted. Discord may use a share
footer without a separate failure notice when its upload fails but a link exists.

The source inspection also explains why earlier green tests were insufficient:
`sessions.stream.test.ts` substitutes `AgentChatSession`; the original Codex
structured harness test checkpoints arrays in memory; the original Claude MCP
tests call synthetic execution callbacks; and the older channel roundtrip test
uses space-filled pseudo-Office buffers. These are useful boundary tests, but
they cannot individually substantiate real HTTP/SQLite/file or live provider and
channel claims. This audit adds those missing local boundaries without claiming
general platform parity.

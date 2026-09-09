# MCP one-shot test lifetime and request cancellation

This separate candidate makes a connection test belong to its caller and the manager's shutdown lifetime. Previously, shutdown could miss a pending test, a constructor failure could bypass cleanup, and a late catalog could succeed after observed closure. The test endpoint also failed to forward cancellation and retained mutable draft input across secret lookup.

**This is bounded product evidence, not Atlas–Hermes parity.** Last valid C9 remains Atlas **44/54** versus Hermes **46/54**; its acceptance gate failed. Root production source and fixed C10 were not changed or activated, and no new paid study or live provider/network/worker/renderer call was admitted.

## Changes and behavior

The manager registers each test before preparation and retains ownership until its underlying operation and cleanup settle. Optional caller cancellation returns the original reason promptly. Late prepared resources are closed before client startup; late rejections remain observed. SDK Client construction is inside the cleanup region, with an ownership check afterward to handle reentrant shutdown. Observed natural closure invalidates a pending test. Normal completion waits for cleanup; transport-close errors retain their existing suppression and cleanup failure retains its existing precedence over a normal operation error. A cancelled caller keeps its cancellation result while retained cleanup can fail later.

`disconnectAll` captures both persistent and one-shot lifetime sets before invoking any invalidation callback. It invalidates those captured operations before awaiting cleanup. A reentrant callback can create a later operation outside that snapshot, consistently for both kinds. This is not a permanent ban on new work. One-shot tests never enter the reusable connection catalog. Known resources can be closed promptly; an unresolved preparer or SDK promise remains owned by a retained continuation.

`testServer` captures a detached draft before its asynchronous stored-secret lookup. It observes and races each read/manager wait, preserves the original cancellation reason, and forwards the exact signal. Ordinary manager failure retains the existing failure response; a successful draft test does not certify a later stored revision or write stored settings. The test route checks and forwards its raw Request signal, including while reading the body. Existing entry authorization remains in place.

## Evidence

**196 unique tests pass, with 1,046 assertions: 46 new cases and 150 regressions across seven test files.** All six changed TypeScript files pass scoped typechecking and lint: two new test files and four modified files. The candidate has 2,200 regular files and 177 inventoried symlinks; its 2,198-file prior baseline is unchanged.

| Gate | Cases | Assertions | New |
| --- | ---: | ---: | ---: |
| Fake SDK/preparer one-shot lifetime | 23 | 85 | 23 |
| Existing connection ownership | 31 | 135 | 0 |
| Existing manager lifecycle | 24 | 159 | 0 |
| Installed SDK memory-peer contract | 28 | 100 | 5 |
| Real service/route with fake manager | 18 | 43 | 18 |
| Safe existing MCP service | 16 | 38 | 0 |
| Existing stale-write memory/SQLite cases | 56 | 486 | 0 |

[Test inventory](../../../../outputs/hermes-evidence/2026-09-08/mcp-one-shot-lifetime/test-inventory.json), [gate records](../../../../outputs/hermes-evidence/2026-09-08/mcp-one-shot-lifetime/final-gates.json), and [source delta](../../../../outputs/hermes-evidence/2026-09-08/mcp-one-shot-lifetime/source-changes.json) retain exact membership and hashes. Repeated runs are not additional cases. One actual MCP startup test was filtered and is not counted passing.

The actual installed SDK 1.29.0 Client/Protocol/validators run against a controlled in-memory JSON-RPC peer. Five new cases cover normal one-shot completion and caller cancellation/shutdown while initialize or tools/list is pending; 23 existing cases remain. SDK package bytes were checked before and after the final gate, not atomically during execution and not across every transitive dependency. New manager fault-injection tests use fake Client/transport/preparer. Service tests use real Hono routes, service and memory DB with a fake manager and synthetic admin/viewer middleware: they do not verify login, actual socket-disconnect propagation into Request.signal, or a production HTTP status mapping. HTTP 499 is only the fixture's error handler. The 250ms held-promise sentinel proves prompt departure from deliberately unreleased waits, not a latency benchmark.

These are separate scoped process gates. Agent service/route gates predate the final private manager shutdown snapshot correction; their own three source files and the manager public API were unchanged. Root manager, connection, lifecycle, SDK, type and lint gates reran after that correction. No single remote end-to-end test is claimed.

## Failures retained

Original manager reproduction: **8 passes, 11 failures, 39 assertions** across 19 cases. The first correction passed 19/73. A new constructor-reentrant shutdown case then failed 0/1/2 before an added ownership check; expanded cases passed 22/82. Same-team review identified the entry-snapshot discrepancy; its targeted reproduction failed 0/1/2 before capturing both lifetime sets upfront. Final manager cases pass 23/85. These later extensions are not represented as part of the original 19-case baseline run.

Original service/route v1 had 4 passes/14 failures/26 assertions. One failure was a fixture assumption that summaries omit inputSchema. Correcting that fixture before production edits yielded original v2 **5 passes/13 failures/27 assertions**. The implementation passes all 18/43. Two initial type errors came from Hono's Response-or-Promise return type in the fixture; wrapping with Promise.resolve corrected them. A root SDK command initially used a nonexistent guessed filename: no tests ran, the failed invocation was retained, and the verified existing file was then executed. All failed logs and before-source snapshots remain in the archive.

[Same-team review](../../../../outputs/hermes-evidence/2026-09-08/mcp-one-shot-lifetime/agent-root-one-shot-review-v1.json) and [root readback](../../../../outputs/hermes-evidence/2026-09-08/mcp-one-shot-lifetime/root-handoff-readback.json) bind the named source and evidence. The reviewer authored the service/route component; this is not blind independent study qualification. The two-test isolation fixture proves independent test completion and an empty reusable catalog, not survival of an already-active persistent connection.

## Remaining limits

Logical cancellation is not physical process-close, descendant quiescence, remote-effect cancellation or a guarantee that an uncooperative preparer/SDK promise eventually settles. Late ownership is retained without a new public one-shot observation API. Natural-close tests do not establish the frequency of fault-injected timing in remote SDK deployments. Full continuous admin authorization, complete runtime authority and atomic executed-dependency pinning remain outside this slice.

Persistent `createServer` configuration aliasing and ownership after a failed database commit remain separate source-audit findings, not fixed or reproduced here. The next bounded work is to reproduce those exact two cases in a fresh copy with fake manager and real DB. The failed output inspector, stopped renderer path, held reviewers and unadmitted study remain unchanged. No fresh-task or calibration content was opened.

[Checked delta patch](../../../../outputs/hermes-evidence/2026-09-08/mcp-one-shot-lifetime/changes.patch), [combined C10-copy patch](../../../../outputs/hermes-evidence/2026-09-08/mcp-one-shot-lifetime/combined-from-c10.patch), and [archive verification](../../../../outputs/hermes-evidence/2026-09-08/mcp-one-shot-lifetime/verification.json) are review artifacts, not an adopted deployment. The 2,129-file C10 copy roster does not replace its registered 2,126-file roster. [Last valid comparison](../hermes-native-files-v3-c9-confirmation/report.md) remains the controlling quality result.

# MCP creation: captured configuration and connection ownership

A create request previously kept caller-owned configuration and flags across asynchronous name lookup and connection startup. The caller could change the stored configuration after the manager had captured a different connection configuration. Separately, a successful initial connection remained live if the subsequent database insert failed. This candidate captures the entire request before waiting and releases only the connection generation created by the failed operation.

**This is a separate product correction, not Atlas–Hermes parity evidence.** Last valid C9 remains Atlas **44/54**, Hermes **46/54**, with its finite acceptance gate failed. No new paid comparison, provider/network/worker/renderer execution, product-source adoption, fixed-C10 modification or bootstrap activation occurred in this increment.

## Resulting behavior

`createServer` takes a detached copy of the draft, including connection/enabled flags, before name lookup. Validation, connection and persistence use that captured draft. Mutation during either lookup or connect therefore cannot change the configuration persisted by this call or turn a captured disabled/no-connect request into a connection attempt.

The manager's new `connectOwned` method returns the discovered tools and a disposer bound to the exact private connection entry. It verifies the entry after readiness before returning. Disposal never looks up the server ID again: disposing an old creation cannot disconnect a newer replacement, and repeated disposal shares the same cleanup result. Existing `connect` remains available with its existing return shape.

Only a rejected database upsert triggers creation compensation. Successful cleanup preserves the original database error. If cleanup also fails, an AggregateError retains both error objects and the database error as its cause. Notification and response work remain outside that compensation region, so an error after successful persistence preserves the stored connection and never replays creation. A create without a connection does not invent cleanup.

## Verification

**219 unique cases pass, with 1,268 assertions: 41 new cases and 178 regressions across eight test files.** Scoped TypeScript and lint pass for all six changed TypeScript files: two new tests and four modified files. The separate source contains 2,202 regular files and 177 inventoried symlinks, based on the unchanged 2,200-file prior increment.

| Gate | Passing cases | Assertions | New cases |
| --- | ---: | ---: | ---: |
| Create request capture, memory/SQLite | 12 | 78 | 12 |
| Connection ownership | 40 | 169 | 9 |
| Installed SDK memory-peer contract | 29 | 106 | 1 |
| Existing manager lifecycle | 24 | 159 | 0 |
| Existing one-shot test lifetime | 23 | 85 | 0 |
| Creation commit/compensation, memory/SQLite | 19 | 147 | 19 |
| Safe existing MCP service | 16 | 38 | 0 |
| Existing stale-write memory/SQLite cases | 56 | 486 | 0 |

[Case inventory](../../../../outputs/hermes-evidence/2026-09-08/mcp-create-ownership/test-inventory.json), [gate records](../../../../outputs/hermes-evidence/2026-09-08/mcp-create-ownership/final-gates.json), and [source hashes](../../../../outputs/hermes-evidence/2026-09-08/mcp-create-ownership/source-changes.json) retain exact membership. Repeated development runs are not additional cases. The known actual MCP startup test was filtered and is not counted passing.

Create/commit tests use real memory and SQLite adapters with fixture overrides and a fake manager. The SQLite conflict is a real UNIQUE(org_id,name) failure between two creates whose initial lookups found no row, within one process. It is not a separate-process concurrency test. Fake-manager generation disposal is checked separately against the real manager with fake SDK/preparer/transport. One added installed-SDK case verifies that replacement cancels the old pending request, disposing the old owner leaves the replacement usable, and the new owner closes its own connection. SDK 1.29.0 Client/Protocol/validators are real; the peer is in memory. The 677 SDK package files match before and after the final gate, without atomic execution or transitive-dependency certification.

These are scoped process gates, not a single remote end-to-end run. Production manager/service bytes were stable after implementation/formatting. Root capture and connection fixtures later gained explicit typed synthetic configuration and immediate rejection observation/entry races; affected behavior, type and lint checks reran. Agent fixture typing correction reran its affected 19 cases, typecheck and lint. Unchanged unrelated groups were not counted again.

## Failures retained

The corrected original request-capture gate failed all **12 cases/12 assertions** before production changes. Its first attempt had 12 failures/eight assertions, including four SQLite fixture timeouts: assigning an override directly to SQLite's get-only adapter proxy did not change the method returned by its getter. A fixture-only wrapper fixed the interception seam before the valid baseline rerun. Those timeouts are not counted as four product defects.

The corrected original compensation gate had **10 passes/nine failures/105 assertions**. Missing cleanup, old-generation compensation, combined error evidence and held cleanup failed in both adapters, plus orphan cleanup after the real SQLite name conflict. Post-commit controls already passed. Its first gate had seven passes/12 failures/71 assertions, including two timeouts caused by the same SQLite fixture interception mistake. Both versions and source bindings remain retained.

Root typecheck initially rejected unknown stored configuration in new connection tests; explicit typed synthetic configuration and narrowing corrected the fixture. Agent typecheck initially rejected an Entry-or-undefined expected array; reversing symmetric equality preserved its assertion. The final capture fixture immediately observes pending failure and races stage entry against terminal completion, so a future early failure cannot silently wait forever for an unreachable stage. This adds 12 entry assertions to the earlier 66-assertion passing gate. All intermediate logs, original source snapshots and before-fix fixtures are archived.

[Same-team review](../../../../outputs/hermes-evidence/2026-09-08/mcp-create-ownership/agent-root-create-review-v1.json) and [root readback](../../../../outputs/hermes-evidence/2026-09-08/mcp-create-ownership/root-handoff-readback.json) bind the final named source and evidence. This reviewer authored the compensation tests; this is not blind independent study qualification.

## Limits

Compensation covers a rejected upsert before commit in the current adapters. A database operation that commits and then throws has ambiguous commit semantics and is outside this promise. A synchronous SDK-entry check and a disposer are not an atomic authorization lease over remote effects. Cleanup failure remains observable without proof of physical process-close or descendant quiescence. Memory's broader duplicate-name policy and database/schema behavior are unchanged.

This slice does not add continuous administrator authorization, caller cancellation to createServer, a universal shutdown guarantee, full runtime authority or executed-dependency pinning. The passing tests do not prove provider compatibility or model quality. They also do not qualify the blocked document-output inspector, release held reviewers, expose fresh tasks/calibration, or admit the registered comparison. Remaining required comparison steps must be assessed against their own admission evidence rather than replaced by additional optional product tests.

[Checked delta patch](../../../../outputs/hermes-evidence/2026-09-08/mcp-create-ownership/changes.patch), [combined C10-copy patch](../../../../outputs/hermes-evidence/2026-09-08/mcp-create-ownership/combined-from-c10.patch), and [archive verification](../../../../outputs/hermes-evidence/2026-09-08/mcp-create-ownership/verification.json) are review artifacts, not an adopted deployment. The 2,129-file copy roster does not replace registered C10's 2,126-file roster. [Last valid comparison](../hermes-native-files-v3-c9-confirmation/report.md) remains the controlling quality result.

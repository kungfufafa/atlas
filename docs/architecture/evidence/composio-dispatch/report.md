# Composio dispatch: current access and exact session binding

Status: bounded implementation and component verification in a separate source copy. **This is not Atlas–Hermes parity evidence.** Last valid C9 remains Atlas **44/54**, Hermes **46/54**, with its acceptance gate failed. No new paid study, provider call, renderer, actual MCP worker or network call was admitted by this increment. Root production source and fixed C10 were not changed or activated.

A Composio action can wait for session creation, a connection, a guard or database reads. Previously, access or endpoint state could change during those waits while dispatch continued from stale observations. The candidate now binds dispatch to the current human actor, assignment, account, action schema and exact service-owned endpoint. Replaced sessions cannot be reached through an old connection token, even when their URL and headers are identical.

## Implemented behavior

- `AgentService` supplies a final database callback with the captured human user. Both adapters validate current tenant/profile, membership/role/admin/Super policy, enabled assigned toolkit, allowed action and selected schema, and exact connected personal account. Platform administrators still need Composio membership. Memory also rejects ambiguous duplicate account associations. SQLite calls the trusted dispatch callback under an immediate transaction, releasing the lock before awaiting its result; a second real connection verifies that boundary.
- `ComposioService` returns frozen detached endpoint objects. Its synchronous checker authenticates the exact object, scope, current client/configuration generation, user generation and cache entry. Explicit reload, an observed API-key change, user invalidation and newer accepted reads prevent obsolete pending work from installing or rolling back a session. Equivalent current requests coalesce.
- The manager owns endpoint generations per instance. Acquisitions capture URL/headers and an optional opaque endpoint identity. The same identity/configuration can share startup; a fresh identity replaces it. One-use tool connections retain their acquired entry and cancellation signal. An old token cannot dispatch through a replacement lookup.
- The bridge observes pending failures before abortable waits, repeats the guard and roster checks after acquisition, then invokes the synchronous endpoint check and current manager dispatch inside the final database callback without an intervening await. Cancelling one waiter leaves shared startup available to another caller.

## Verification

The final inventory contains **418 unique passing tests, 1,351 assertions, 121 new cases and 297 regressions across 17 test files**. Repeated development runs are not additional tests. Scoped TypeScript and lint checks pass for all **17 changed TypeScript files**: five new and twelve modified. The source copy contains 2,198 regular files and 177 inventoried symlinks; its 2,193-file prior baseline remains unchanged. [Source delta and hashes](../../../../outputs/hermes-evidence/2026-09-08/composio-dispatch/source-changes.json).

| Process group | Passing cases | Assertions | New cases |
| --- | ---: | ---: | ---: |
| Composio bridge races | 18 | 25 | 18 |
| Manager tool connections | 31 | 135 | 8 |
| Installed SDK regression | 23 | 75 | 0 |
| Manager lifecycle regression | 24 | 159 | 0 |
| MCP database/bridge access regression | 87 | 206 | 0 |
| Composio authorization regression | 13 | 44 | 0 |
| Other service/route/integration regressions | 106 | 392 | 5 |
| Composio session generations | 19 | 58 | 19 |
| Composio database access | 71 | 162 | 71 |
| Existing Composio service | 26 | 95 | 0 |

[Test inventory](../../../../outputs/hermes-evidence/2026-09-08/composio-dispatch/test-inventory.json) and [gate records](../../../../outputs/hermes-evidence/2026-09-08/composio-dispatch/final-gates.json) retain the individual process results. One actual MCP startup test was filtered and is not counted passing. Ordinary Bash regressions retained Atlas's sandbox.

These are scoped gates, not a single monolithic final snapshot run. Service 19 and existing-service 26 predate the isolated final memory uniqueness guard and two additional DB cases; service and the other six owned source files were unchanged. Final DB 71, types/lint and affected root integration were run afterward. The final nullable-endpoint type guard correction reran bridge 18, authorization 13, other integration 106, types and lint; unrelated manager/SDK/lifecycle/access source remained unchanged.

New bridge/service/endpoint tests use controlled API or SDK boundaries. Five actual `AgentService`/common tool-loop cases combine real memory DB with fake endpoint/manager behavior. The SDK regression uses the installed SDK 1.29.0 Client/Protocol/validators and a controlled in-memory JSON-RPC peer. Its 677 package files matched before and after the final regression; this is not atomic execution pinning or a certificate for transitive dependencies. No new single test combines real ComposioService, final DB callback and installed SDK against a remote endpoint.

## Retained failures and corrections

Original bridge reproduction: 1 pass/12 failures/13 assertions; original service generation: 0/6/9. Later obsolete roster reader cases failed 0/3/3, and old configuration/disconnected-account reader cases failed 0/2/2 before their corrections. The equal-URL fresh-identity case failed 0/1/3; it demonstrated that the earlier runtime ignored the newly proposed opaque identity argument. The memory account-ambiguity reproduction had one pass/one failure/seven assertions: the real SQLite uniqueness control passed while memory admitted ambiguity. Logs and before-source snapshots are retained in the archive.

A diagnostic restored **only AgentService** to the prior increment in an otherwise captured, in-progress integration: unchanged control passed and four revoked-state cases failed (seven assertions). This is not an all-baseline or final-integrated-snapshot experiment. The first copy command used a not-yet-created working directory and failed before process creation; retry from an existing directory succeeded. No automatic approval rejection occurred.

Fixture mistakes are recorded separately from product defects: the first AgentService fixture used a three-argument form of a two-argument account lookup (five failures); the prospective new DB API tests initially referenced nonexistent `updateUser` (63 passes/six failures). Correct fixtures then passed. Three legacy Composio fixtures were adapted before execution to mock the new endpoint seam and preserve their existing assertions without starting HTTP traffic.

The first formatter invocation could not find Biome; the installed Bun script environment resolved it without installation. The final root typecheck caught a nullable original endpoint; the explicit guard was corrected and affected gates rerun. The first review prewrite check rejected stale source bindings during that correction, and no stale review was written. Final review v2 retains an append-only clarification of the equivalent formatted boolean expression. The first inventory script overcounted new cases by applying an endpoint-name rule across unrelated groups; the corrected group-specific classification yields 121 new cases. The failed audit script and explanation are retained.

[Same-team review](../../../../outputs/hermes-evidence/2026-09-08/composio-dispatch/agent-root-integration-review-v2.json), [expression clarification](../../../../outputs/hermes-evidence/2026-09-08/composio-dispatch/agent-root-review-expression-clarification.json), and [root readback](../../../../outputs/hermes-evidence/2026-09-08/composio-dispatch/root-handoff-readback.json) bind 78 references/43 unique paths plus eight copied component files. This is a component author's review, not a blind independent comparison. The component-only patch starts `types.ts` after the root's new contract declaration; the archive's full delta patch instead compares against the unchanged prior baseline.

## Limits and continuation

Current synchronous DB authorization and SDK entry do not provide atomic authorization over remote effects or physical descendant cleanup. Pending remote session creation is logically invalidated and its late outcome observed, not physically cancelled. The checker cannot detect unobserved filesystem configuration changes. OAuth, search/catalog visibility, other service writes, broader reachability and cancellation of already-started loaders remain outside this slice. Generic bridge callers omitting the final database callback are weaker; manager callers omitting opaque identity retain scalar-signature semantics. Memory uniqueness uses a store scan with no unbounded-scale guarantee.

No product bootstrap activation, fixed-candidate modification, fresh-task/calibration exposure, reviewer release, study admission, provider compatibility or model-quality claim follows from these tests. The failed inspector and stopped renderer path remain excluded. The next bounded assessment is the remaining `createServer`/`testServer` one-shot connection lifecycle using controlled fixtures; an audit is not a runtime result.

[Checked delta patch](../../../../outputs/hermes-evidence/2026-09-08/composio-dispatch/changes.patch), [combined patch from fixed C10 copy](../../../../outputs/hermes-evidence/2026-09-08/composio-dispatch/combined-from-c10.patch), and [archive verification](../../../../outputs/hermes-evidence/2026-09-08/composio-dispatch/verification.json) are review artifacts, not an adopted deployment. The 2,129-file C10 copy roster does not replace its registered 2,126-file roster. [Last valid comparison](../hermes-native-files-v3-c9-confirmation/report.md) remains the controlling quality result.

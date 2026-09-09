# Tenant, channel and tool authorization audit

Later actual provider, Claude-auth and Docker/Linux attempts are recorded in
[the live execution follow-up](live-proof-2026-09-06.md). Counts and unproven
gates below describe this audit's earlier snapshot.

The [native channel follow-up](native-channel-hardening-2026-09-06.md) adds the
N01–N11 controls, layered-policy, media and voice matrix alongside this audit.

Declared 2026-09-06 before new root probes and fixes. This extends the earlier
file-fidelity work; its passing counts did not prove this authorization matrix.
All negative and positive branches below must be accounted for. A partial cell
must identify the substituted layer and its untested combinations. No live
messenger traffic is authorized for this audit.

## Predeclared matrix

| ID | Boundary and dimensions | Failure oracle |
| --- | --- | --- |
| A01 | HTTP auth: absent, browser/bearer, local token, each scoped channel worker; matching/foreign/missing org; active/archived/deleted org | No access or mutation through another org, worker channel or privileged route; explicit denied result |
| A02 | Current admin/member/viewer/guest/removed/deleted user; same/foreign profile and session; owner/nonowner | No caller impersonation, foreign bytes or privilege gained from a stale principal; allowed controls still work |
| A03 | Channel policy: pairing/open/allowlist/denylist × paired/allowed/blocked/both/unlisted/unlinked; WhatsApp PN/LID aliases and paired owner | Apply current policy before commands, downloads, file persistence, inference and delivery; denylist precedence cannot be bypassed by pairing/aliases |
| A04 | WhatsApp DM/group, each group/sender composite key, fixed/selected org, cached/cold session, re-pairing | No cross-sender/org session, OAuth, history or artifact reuse |
| A05 | Telegram DM/group/topic, addressed/unaddressed message, fixed/selected org, cached/cold session | Same authorization and scope before command, attachment and delivery paths |
| A06 | Discord DM/guild/thread, addressed/unaddressed message, owned/unowned/foreign thread, fixed/selected org | No unowned legacy session adoption, thread hijack or unintended response |
| A07 | Commands: start/pair, allow, org/profile, status, new/clear/compact, stop/close, attach, ordinary text/media | Each command enforces its own role, policy, principal and scope before effects |
| A08 | File/source/artifact: paired/guest/viewer/revoked principal, cold/hot session, saved/cache/share URL, retry, tenant/profile/session ownership | No unauthorized disk writes, upload/download bytes, share publication or cached link replay; read-only access distinguished from tool/file mutation |
| A09 | Tool exposure: assigned/unassigned/disabled/deferred/activated × builtins/Python/Bash/documents/custom/MCP/Composio, own/foreign tenant | Search/activation/session cache cannot restore revoked or foreign tools; per-user integration identity preserved |
| A10 | In-flight revocation: member remove/downgrade, platform flag change, org archive, profile/tool/MCP removal or reassignment; ordinary/native dispatcher/retry | Revalidate before every new effect and retry; completed effects stay recorded rather than falsely undone |
| A11 | Approval: owner/foreign user/org, approve/deny/duplicate/stale/cancel/restart, role/tool/config changed while waiting | No grant or effect from a stale or foreign decision; callback uses current principal/configuration |
| A12 | Execution surface: web/CLI/channel/automation/subagent/playground × tools/skills/memory/outbound integrations | All surfaces retain their intended role and scope; explicit exceptions cannot inherit another surface's privileges |
| A13 | WhatsApp outbound: worker token + org token, access modes/recipients, queued/chunked sends, token/policy rotation, cancellation | No post-revocation queued send, duplicate completed chunk or destination-policy bypass |
| A14 | Full regression and evidence audit | Unfiltered repository and script targets; preserve initial failures, direct denial assertions and coverage holes. Mock transport and actual remote delivery remain distinct |

Each channel owner declared its concrete branch products before its probes.
Root tests use production Hono authorization routes and database/identity policy;
channel tests enter production handlers with controlled external transports.
An HTTP/handler mock proves only the named boundary, not upstream messaging
service enforcement. Provider/tool matrix combinations without actual execution
remain unverified, regardless of a shared adapter or schema.

## Initial findings (before correction)

- WhatsApp hot-session keys normalize composite group/sender keys to `group`,
  allowing one sender's hot session to replace another's.
- Discord `/allow` trusts pairing instead of current org administration and
  bypasses policy; unowned legacy `/attach` can adopt and emit another session.
- Paired attachment paths can persist bytes before the server revalidates role
  or membership. Cached share links need authorization before re-delivery.
- Deferred tool activation rehydrates from all org tools and can resurrect an
  unassigned tool. In-flight tool closures do not consistently recheck current
  membership or profile tool configuration.
- WhatsApp outbound owner handling precedes denylist checks, inconsistent with
  inbound policy; PN/LID aliases need the same blocked-owner protection.

These findings are reproducers to fix, not a final verdict. Results and retained
attempts will be appended after execution; the original matrix is not reduced.

## Implemented boundaries

Authorization now separates the worker credential from the sender's authority.
The credential fixes the workspace and channel. The current channel policy,
canonical identity mapping, current account and membership, profile, and session
ownership are then checked for the requested operation. A read requires an owned
session; a viewer cannot invoke or write; an admitted channel guest cannot write
workspace files. Platform administrator behavior follows the current account
flag, matching the existing administrator override. An explicit `default`
profile resolves only inside the current workspace.

The direct worker session-creation HTTP route also runs this check. A mapped
but blocked sender cannot bypass the channel handler by calling that route,
and an explicit foreign profile is rejected instead of falling back to the
current workspace's default. Direct HTTP probes reproduced both bypasses for
all three channels before the additional server guard.

WhatsApp's composite group/sender cache keys remain distinct. PN/LID evidence is
normalized against the current workspace's map, with conflicting phone or
canonical-user mappings rejected. A normalized phone snapshot is passed onward
so that a changed map cannot apply one person's allowlist to another person's
identity. Cold admission rechecks the resolved user's role even when pairing
completes between the initial lookup and guest resolution.

Channel handlers check authority before attachment downloads and again before
persisting downloaded documents, before cached artifact/share-link delivery,
and before cancellation or thread mutation. Discord `/allow` now uses a server
operation that checks current administrator authority and writes only that
workspace's configuration. Legacy unowned Discord attachment sessions are not
adopted. A valid pairing code cannot override a denylist; the server checks this
before consuming a pairing assertion as well as the channel's local check.

The modes retain distinct meanings. `open` permits a valid sender even if a
blocked list remains configured; `denylist` applies that list including paired
owners. Pairing mode on Telegram/Discord also admits allowed IDs. WhatsApp
pairing mode admits the paired owner. Tests cover these differences instead of
making all four modes synonyms.

Tool discovery and activation use current profile assignments. Protected
execution checks the current principal before each attempt and retry, including
ordinary and native provider dispatch. Deferred activation cannot resurrect a
removed assignment. Cached MCP/Composio invocations check current assignments,
configuration, enabled state, action restrictions, and the exact tenant/user
OAuth connection. Service mutations invalidate the owning workspace's cached
tool catalog. These checks prevent the next effect; they do not undo completed
external effects.

Successful membership removal or a changed role also cancels that user's
active streams and pending approvals in the affected workspace, including
registered turns whose chat cache has not yet been populated. Other users and
the same user's other workspaces remain active. Cosmetic changes, unchanged
roles and rejected mutations do not cancel turns.

## Evidence interpretation

- The shared HTTP matrix executes production Hono authentication and tenant
  middleware, IdentityService and SQLite. Its main product contains
  **3 channels × 4 modes × 6 sender states × 6 roles × 3 intents = 1,296
  authorization requests**. A separate **144-case** Discord administration
  product checks unchanged configuration bytes on denial and unchanged foreign
  tenant bytes on every request. Additional probes cover credentials, token
  rotation, archive/deletion, re-pairing, profile/session scope, platform flags,
  explicit default profiles, and PN/LID conflicts.
- WhatsApp and Telegram/Discord integration suites enter production handlers,
  use the real AtlasClient and Hono application, and persist actual SQLite
  principals/sessions. Outbound messenger transports remain controlled. The
  smaller handler branch matrices substitute the authorization API response;
  they establish the ordering of downloads, disk writes, and delivery calls.
- Shared tool tests use actual chat/dispatch/protection logic with synthetic
  provider responses. Bash/Python/Word/PDF/workbook/read-file permission probes
  use actual schemas with instrumented handlers: a denied handler is never
  entered. Engine fidelity and OS sandbox behavior are separate evidence in
  [the file remediation ledger](gap-remediation.md).
- MCP and Composio tests mutate actual database/service configuration while
  replacing external transports. They establish tenant/user/action routing and
  revocation behavior, not a completed remote OAuth or SaaS operation.
- Worker credentials are restricted to a channel and tenant. They have no
  timestamp expiry; the tested revocation mechanism rotates their signing
  secret. Browser and local-token callers cannot use the worker-only identity
  operations. Legacy/global local-token messenger sessions remain deliberately
  rejected; zero-effect rejection is covered rather than counted as support.

## Retained failures and limits

Initial reproducers included the WhatsApp group cache collision, paired-owner
denylist bypasses, blocked valid pairing codes, Discord administration bypass
and unowned session adoption, and revoked tool exposure/execution. The race
findings were discovered during independent review and tested after correction;
no pre-fix execution is claimed for them.

The root HTTP matrix's first attempt produced 593 passes and 6 failures. Those
six were fixture assumptions: SQLite preserves a previous session owner when an
upsert supplies null, and preserves an archived organization on subsequent
upsert. The corrected probes create fresh ownerless sessions and test archive
without assuming an unsupported unarchive operation. The original failures are
retained in the evidence, not removed from the matrix. Intermediate lint runs
also include unfinished files from concurrent implementation; final checks are
listed separately.

This is a bounded branch audit, not the full Cartesian product of every tool,
command, provider, role, alias, attachment, retry and timing interleaving. Each
handler role/mode integration product primarily exercises session admission,
with separate explicit command, cached-file and revocation probes. Raw SDK
event parsing, topic/thread routing, attachment formats and other commands also
have existing worker regressions; these are not all repeated with every role.
Effects already sent to an external service cannot be recalled, and not every
live stream/status-bubble revocation interleaving is exercised. A scoped worker
still attests to the messaging service's sender identity; these tests do not
simulate a compromised messaging SDK or forged upstream account.

Live provider parity, native Claude authentication, actual messenger delivery,
remote OAuth operations, Docker build execution and Linux isolation remain
distinct gates. Previous blocked/unrun live checks remain recorded in
[file remediation](gap-remediation.md); shared code and passing mock transport
tests are not substitutes for those gates.

## Final verification

The unfiltered repository target passed **6,340 tests, 0 failures, 21,530
assertions across 650 files**. The separate scripts target passed **46 tests,
0 failures, 130 assertions across 11 files**. Counts overlap and must not be
added. Root, web and file-runtime TypeScript checks, the server production build,
global lint (2,061 files) and `git diff --check` passed.

| Matrix entries | Executed evidence in the full run | Explicit remaining boundary |
| --- | --- | --- |
| A01–A02 | 614 shared HTTP tests; 27 direct session-admission tests; account/role/tenant/session/profile, credentials and real deletion probes | A worker attests to the upstream sender; no forged messaging-SDK attack simulation |
| A03, A07 | Mode/identity products, 23 pairing guard tests, valid blocked-code regressions, `/allow` admin/config-byte checks and command branches | All commands are not multiplied by every role, alias and timing interleaving |
| A04–A06 | 205 actual channel-handler → client → HTTP → SQLite tests; 277 additional handler-branch cases; existing worker routing/cache tests | Additional handler branch tests substitute the authority API response; no upstream SDK/live delivery claim |
| A08 | Before-download and after-download revocation, actual owned/foreign artifact HTTP bytes, cached-share re-delivery and zero-effect denial | Every attachment format is not repeated for every role and provider |
| A09–A10 | 29 tool-tenancy cases, 13 Composio authorization cases, MCP/execution regressions and 6 actual membership HTTP cancellation cases | Transport effects already started cannot be recalled; protected document probes instrument handler entry |
| A11 | 17 chat-approval regressions plus actual membership cancellation of pending approvals | No exhaustive distributed race/interleaving proof |
| A12 | Current principal guards for ordinary/native dispatch, automation, subagent and Playground; existing skill/memory/conversation/HTTP role regressions | CLI/mobile browser UI and each provider integration are not repeated across the entire matrix |
| A13 | Actual loopback outbound HTTP authorization/queue/chunk tests with controlled Baileys sends | No live WhatsApp receipt or every streaming/status-bubble revocation interleaving |
| A14 | Complete repository/scripts targets, build/typechecks/lint; initial failures retained alongside final results | Claude/live provider, real messenger, remote OAuth and Docker/Linux gates remain unproven as listed above |

The [machine-readable summary](validation/tenant-channel-authorization/summary.json)
contains per-file counts, source hashes, log hashes and classifications of the
initial failures. Nineteen logs are retained as compressed archives in the same
directory. The shared-tool initial failure output was available only in the tool
transcript; its reference is recorded without inventing a log file. The final
unfiltered run includes those shared tests.

The three updated channel guides were verified in a local browser, including
eight before/after section/table screenshots, sidebar navigation and search
dialog/index/results. No page errors occurred. The distinct destination
transition after selecting a search result was not separately proved. The
[browser QA report](validation/tenant-channel-authorization/docs-browser/qa-report.md)
retains that limit; preview servers were stopped and generated files restored.

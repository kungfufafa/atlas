# WhatsApp incident findings: remediation and verification

Scope: the supplied report covering 10 September 12:00 through 11 September 07:15 WIB. Changes are in the repository; the incident's Linux PM2 deployment has not been accessed. Production connection health, existing encrypted-session damage, and historical log exposure are therefore not certified by the local checks.

## Requirement evidence

| Finding | Implemented behavior | Verification |
| --- | --- | --- |
| Approval stops after first number | Each approval ID owns submission state; all cards in a turn render; decisions await HTTP responses and can retry failures. Identical authorized decisions do not grant or execute again. A single send supports up to 50 deduplicated recipients with one approval and separate sent/unconfirmed/not-sent receipts. | `verify-action-approval.ts` exercises six sequential cards, failed decision retry, cancel, ID changes, complete batch details, and actual ChatMessageList/client HTTP flow on localhost:3000. Core send, risk, approval-service, and channel/session HTTP tests cover partial execution, authorization revocation and replay. |
| Spreadsheet versions v2–v49 and long occupied chat | `batch_edit` applies up to 100 range operations and 500000 total cells atomically into one saved version. Sheet and literal-string defaults propagate correctly. Width, height, font size and vertical alignment are supported. Eight formatting revisions per workbook per turn stop further dispatch, including one response containing many calls. One batch costs one revision. | A 48-operation workbook test verifies one output, original preservation, values and layout. Later invalid operations publish nothing. Ordinary 30-call and native 49-attempt tests verify eight effects; the ordinary batch retains explicit skipped receipts. Different workbooks and new user turns have separate budgets. |
| Recalculation falsely rejects empty results | Restore only an explicit OOXML empty string formula cache lost by ExcelJS. Missing caches remain unknown, formulas are not guessed, and edits invalidate calculation provenance. | Real LibreOffice roundtrip verifies empty string, zero, false, and formula errors; deterministic transport test also rejects a genuinely missing cache. |
| Ignored group file cannot be recovered by mention/quote | Keep bounded media metadata for 15 minutes; match original or warning quote IDs to the same sender, group and org. Recheck current invoke/file authority before downloading the original. | Handler, deferred-media and authorization integration tests cover original/warning replies, expiry, limits, other senders/groups/orgs and revoked permissions. |
| Natural quiet request does not stop or pause | Explicit quiet phrases and `/pause` abort current work and persist a pause for that sender's conversation; `/resume` discards older queued requests. Control traffic bypasses full/occupied dispatch queues while preserving authorization. | Handler, commands, queue, session store, client stream and server cancellation tests cover active work, initialization races, restarts, full queue, sender isolation and stale backlog. |
| Reconnect storm | Robust disconnect-code extraction; terminal authentication/session failures halt; eight fast reconnect attempts followed by five-minute probes. Five stable minutes reset the budget. Old socket callbacks and timers cannot reconnect retired generations. | Reconnect-policy and socket-lifecycle tests simulate 401/500, 408, short opens, stable opens and stale timers. Superseded for 500 on 18 September 2026 — see the follow-up. |
| Decrypt loops, leaked Signal keys, malformed cache key | Retry caches survive socket replacement and retain exhausted-counter tombstones. Placeholder cache accepts malformed/null IDs safely. Patched libsignal omits private session objects and raw failure stacks. Auth JSON writes are private, serialized and atomic; corruption is preserved instead of replaced with fresh credentials. Worker logs are 0700/0600. | Actual installed libsignal privacy test, real Signal encrypt/decrypt across restart and rejected MAC, real Baileys peer-resend handling with a null stanza ID, socket/auth/cache tests and worker log permission/content-preservation tests. Both Docker install stages include the patch directory. |
| Worker starts competing API and migrations | Workers only wait for the existing API. Public health readiness no longer probes protected catalogs. Uppercase ATLAS_SERVER_URL takes precedence over stale discovery and the legacy variable. | Loopback tests cover protected-route rejection, explicit URL, delayed startup and incompatible endpoints. All four worker entrypoints explicitly disable API autostart. |
| Codex model discovery and Linux warnings | Concurrent model discovery shares only the in-flight operation; no persistent catalog cache or model substitution. Account/connection changes invalidate discovery, and closed initializing clients cannot revive. Native tools, hooks and shell snapshots are disabled at process startup while the sandbox remains read-only. Effective native MCP configuration is checked before thread start/resume; canonical workspace paths and untrusted project/ancestor overrides prevent later workspace config from enabling native MCP. | Protocol tests cover discovery, invalidation, initialization cancellation, and start/resume configuration. Real bundled Codex 0.150.1 probes reject populated home/project MCP configuration and suppress late project/ancestor configuration, path aliases and symlink retargeting. A positive control proves the fixture MCP executes without isolation. No login or model generation was used. |

## Browser evidence

- [Before: stuck Confirming](browser/before-stuck.png)
- [After: consecutive approvals](browser/after-consecutive.png)
- [After: retryable HTTP failure](browser/after-retry.png)
- [After: full batch review](browser/after-batch.png)
- [After: two cards in the real message list](browser/after-conversation.png)

All numbers and messages in these screenshots are test fixtures. No real WhatsApp send was performed.

## Host follow-through

The report's production log window is unavailable in this workspace. Local subscription logs ended before the incident. The user has been asked for the affected Linux host/SSH alias. After deploying the reviewed changes, verify API/worker ownership and port, worker log permissions and absence of new key dumps, a stable WhatsApp connection, and an authorized inbound/outbound roundtrip. Do not expose raw historic logs. If linked-device keys were exposed, revoke the device and relink; if encrypted messages were lost, ask the sender to resend. Neither missing plaintext nor private ratchet keys can be reconstructed from this code patch.

Linux Codex needs a working namespace sandbox. The inspected Linux arm64 package for Codex 0.150.1 includes `codex-resources/bwrap`; package presence alone does not establish permission to create user namespaces. Check the service's container and AppArmor policy, using distribution-supported prerequisites where required; do not automatically disable the sandbox or global host controls. These prerequisites are described in [OpenAI's sandbox documentation](https://learn.chatgpt.com/docs/sandboxing). Shell snapshot behavior is documented in the [OpenAI configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

The CESA hourly clean exits and the absence of inbound-queue saturation were not treated as defects. Provider network retries alone do not prove an Atlas queue defect.

## Follow-up — 18 September 2026

Production later showed WhatsApp silent while Integrations still said **Connected**: the socket was dead, the worker was alive, and the badge treated `paired && running` as Connected. Baileys also maps unknown stream errors to HTTP 500; Atlas treated 500 as terminal and stopped reconnecting, leaving `connected: false` and no replies.

Current contracts:

- `reconnect-policy.ts` does **not** treat 500 as terminal. Halt only 401 / 403 / 411 / 440.
- Integrations **Connected** is `paired && running && heartbeat.connected` (`whatsapp-settings-status.ts`). A dead socket is **Disconnected**.
- **Disconnected** is not a wiped session. Wait for auto-reconnect or restart the worker. **Reconnect with QR** deletes `auth/` and forces a new Linked Devices scan. Restarting Atlas / PM2 must not delete the WhatsApp session.

A second incident: the dashboard spinner appeared to hang because `index-*.js` is ~4 MiB and Apache proxied `Bun.file` uncompressed. `static-web.ts` now gzips JS/CSS/HTML, marks `/assets/*` immutable, and serves `index.html` `no-cache`. `pm2-deploy.sh` fails unless dashboard JS is `Content-Encoding: gzip`. After a web rebuild, restart Atlas and check the public URL, not only localhost.

Keep these files: `reconnect-policy.ts` (no 500), `whatsapp-settings-status.ts`, `static-web.ts` gzip.

## Validation status

Runtime: Bun 1.3.14; macOS arm64. System Bun 1.3.1 was not used for final checks. The complete unit runner passed 754 files (7803 tests, zero failures or skips). After the final Codex isolation changes, 45 protocol/tool tests and 108 affected runtime/harness/fidelity/failure tests passed, and root TypeScript was checked again. Root/web TypeScript checks, production web build, documentation build and its 29-page export verification, browser QA, changed-file lint, and `git diff --check` pass. The documentation build required a fresh Turbopack cache after an earlier sandbox port-permission failure.

The repository's `verify-codex-isolation.ts` probe and independent native canaries pass for Codex 0.150.1. Native resume checks prove populated configuration is rejected before resume dispatch; successful resume isolation uses protocol tests of the shared configuration path. No authenticated provider turn or synthetic conversation rollout was created to claim a native resume roundtrip. Existing runtime authentication and operator configuration are preserved.

### Isolated Linux validation

Linux checks use a new temporary Colima profile (`atlas-findings-20260911`), with 2 CPUs and 2 GiB RAM, no host mounts, and no Docker context activation. The existing stopped profile is left untouched. The guest is Ubuntu 24.04.4 aarch64; containers use `oven/bun:1.3-slim` with Bun 1.3.14, digest `sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04`. These checks do not validate linux/amd64 or the incident host.

The exact Codex 0.150.1 Linux arm64 package includes `vendor/aarch64-unknown-linux-musl/codex-resources/bwrap`. Under default Docker security, UID 1000, a fresh private Codex home, and `--network none`, both `codex sandbox linux -- /bin/true` and the bundled `bwrap --unshare-user --ro-bind / / /bin/true` exit 1 with “No permissions to create a new namespace.” `/proc/self/status` reports `Seccomp: 2` and one filter. This demonstrates a namespace-policy prerequisite, not a missing distribution package. No privileged container, unconfined security profile, or host security change was used. No account login or provider turn was started.

The full production Dockerfile completed its frozen-lockfile install (3281 packages), including the patch directory, but its web TypeScript check was killed with exit 137 in the 2 GiB VM. The complete Docker build therefore did **not** pass. A supplemental build of the exact production runtime stage uses the already-verified local web build as input to check runtime packaging within the same resource limit; its results are recorded below.

The supplemental runtime image built successfully with the five production workspace filters (1263 packages). Its manifest digest is `sha256:bbc80f5665f4ecfbb29414994c7a555123a5c3b4348704a6da0e49bb433a6e18`. The runtime Dockerfile content was unchanged; only the web-builder stage supplied existing `apps/web/dist` instead of compiling it again. The installed image's Codex guard, verifier, and libsignal patch hashes matched the final workspace files.

Checks inside that image used its default UID 1000 and `--network none`:

- The actual Baileys dependency passed all three libsignal privacy and Signal restart/rejected-MAC tests.
- `bun run apps/server/scripts/verify-codex-isolation.ts` verified Codex 0.150.1 clean startup, blocked populated native home/project MCP on guarded start/resume, and blocked project configuration created after preflight. Harmless local positive controls confirmed the MCP fixtures could execute only when deliberately bypassing the guard.
- A fresh container using the production entrypoint returned HTTP 200 from `/health`, with `apiVersion: 1`, `ok: true`, no configured provider or user; `/` returned dashboard HTML with HTTP 200. No host port, account credentials, or existing data volume was supplied.

Captured output: [full build limit](linux/full-build-result.log), [runtime build](linux/runtime-build-result.log), [namespace prerequisite](linux/codex-sandbox-probe.log), [libsignal regressions](linux/libsignal-tests.log), [Codex isolation](linux/codex-isolation.log), and [HTTP smoke](linux/health-smoke.log).

Cleanup completed: the temporary profile was stopped and deleted with its container data; its profile, VM, disk, and Docker context no longer exist. The global Docker context remains `default`, and the pre-existing `atlas-verification` profile remains stopped. Automatic approval review did not reject any validation or cleanup action.

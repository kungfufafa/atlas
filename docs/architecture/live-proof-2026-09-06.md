# Actual execution follow-up — 2026-09-06

Subsequent native messenger controls, layered tenant policies, browser checks and
a new Docker image are tracked in the
[native channel follow-up](native-channel-hardening-2026-09-06.md). The results
below remain the earlier snapshot.

This report extends the [tenant/channel authorization audit](tenant-channel-authorization-audit.md). It does not replace that audit's role, sender, policy, tenant, integration, cancellation and attachment matrices with a few successful remote calls. The previous 6,340-test run is an earlier snapshot, not the result of this follow-up.

## Declared live provider scope

Before inference, the runner read the active Atlas SQLite database in read-only mode and wrote a manifest covering **every configured provider instance's default and every profile-selected model**: six cases across five instances. Credentials stayed in memory. All inference inputs, principals, SQLite records and files were synthetic. No operational provider configuration, channel policy or user role was changed.

The manifest also lists configured catalog models outside this scope. Testing one exact model at one endpoint is not evidence for the other model IDs, unconfigured providers, or every provider × channel × role × tool combination.

| Exact selected model | Instance fingerprint | Actual result | Remaining boundary |
| --- | --- | --- | --- |
| Gemini `gemini-3-flash-preview` | `c9af74ccae17` | Native API image input passed. Live file-tool probe and subsequent AgentService write/read, disk bytes and current-role demotion gate passed. | Existing operational configuration has unknown tool capability. Only the disposable test configuration was enriched with the exact model's successful runtime-probe evidence. |
| OpenCode Go `opencode-go/deepseek-v4-flash` | `8027359e26ab` | Actual upstream **401 Invalid API key**, for both text-only diagnosis and tool inference. | New valid credentials required; no inference, tool or model-support success claim. |
| OpenCode Go `opencode-go/kimi-k2.7-code` | `02fb6f150818` | Actual upstream **401 Invalid API key**, for both text-only diagnosis and tool inference. | New valid credentials required; no inference, tool or model-support success claim. |
| Compatible gateway `fusion` | `609cd07af281` | Actual write/read calls and file bytes succeeded; one retry's final answer mistyped the nonce. Overall strict response gate failed. | Tool execution is evidenced; accurate final response and the complete AgentService gate are not certified by that failed run. |
| Compatible gateway `cx/gpt-5.4-mini` | `609cd07af281` | Live tool probe and subsequent AgentService write/read, disk bytes and current-role demotion gate passed. | Exact per-model runtime-probe evidence was added only to the disposable configuration; operational metadata remains unchanged. |
| ChatGPT `gpt-5.6-sol` | `a6cf66998615` | Authenticated Atlas-owned native Codex runtime `0.150.1`, advertised exact model, actual native tool dispatch through AgentService, file bytes and current-role demotion gate passed. | Native IPC/trace and file hashes are live evidence; no HTTP cassette claim for traffic owned by the native runtime. |

Each passing service gate requires an actual successful `write_file` result followed by `read_file` using a path returned in that result, identical canonical output paths, untruncated nonce contents, direct disk byte equality, matching final response, and rejection of a stale member actor after the actual synthetic SQLite membership becomes viewer. The broader before-tool authorization and channel-integration matrices remain independently necessary.

## Failed attempts are retained

- The initial API service runs stopped before inference because `chat.tool-use` was unknown. The runner did not bypass the operational policy. Later raw inference established exact model evidence before it was used in a disposable service fixture.
- The first ChatGPT run reached the real model but denied first writes under a missing workspace beneath macOS's `/var` → `/private/var` alias. This exposed a path canonicalization inconsistency. The regression first failed, then passed after allowed missing roots and target paths used the same existing-parent canonicalization. Foreign paths and escaping symlinks remain denied.
- Initial Gemini/fusion assertions accepted only the top-level absolute output path, although the actual tool also returned a valid artifact-relative path. Both refer to the same file. The corrected gate accepts either returned path and still requires canonical path, execution order and byte equality. The initial failures remain visible.
- A separate fusion response changed one character of the verified nonce. This is an actual response-quality failure, not a filesystem failure. It is retained without weakening the final-response assertion.
- The MSW recorder originally threw on upstream non-2xx responses before capturing them. MSW then produced its own 500, masking OpenCode's actual 401. The recorder now preserves the original status/body; a real localhost 401 and replay after that server stopped prove the correction. Both OpenCode connections were then re-run and their actual 401 responses recorded.

## Native Claude and messenger gates

The actual bundled Claude `2.1.247` authentication probe reports `not_authenticated`. An official login is waiting in the Atlas-owned `subscription-auth/claude` directory. User completion is required. No host `~/.claude` tokens or shell OAuth/API tokens are used. The live gate requires runtime-advertised model metadata; hardcoded fallback model names cannot satisfy it.

The live messenger prerequisite inventory found no tenant-scoped Telegram or Discord bot configuration, and one disconnected WhatsApp configuration. No user-approved test destination has been supplied. The explicit live messenger gates performed local prerequisite inspection only; no real-account message or upload was sent. Prepared live gates distinguish platform upload acceptance, downloaded byte equality, and an independently authored reply-file receipt. Mock transport byte checks remain mock evidence. Separately, the initial mock integration harness did recover workers from synthetic configuration, potentially attempting upstream connections; this unintended lifecycle is now suppressed and is not described as a live delivery test.

Actual external OAuth operations for tenant integrations, and a full live provider/channel/role cross-product, remain unproven. Supplying a bot token or a logged-in account alone does not authorize a destination or establish a paired principal.

## Docker and Linux

Verification uses a dedicated Colima VM, explicit Docker context, no host-data mounts, synthetic tmpfs data and disabled container networking. The architecture is **linux/arm64**; this does not prove the repository's default linux/amd64 build.

The first actual build failed from memory exhaustion. A dedicated VM swap file allowed the full Vite build to complete. The resulting first production image then exposed a real Linux launcher failure: Bun's C compiler could not link libc. `libc6-dev` was added to the production image. Actual default-entrypoint startup subsequently exposed missing workspace aliases: the image ran TypeScript source without shipping the root `tsconfig.json`. The runtime stage now copies that configuration, matching the source-based entrypoint. This repairs the package-resolution contract instead of adding one export for the first missing import.

Docker's temporary mounts initially defaulted to `noexec`, causing two tests' synthetic executable scripts to return 126. A direct executable outside Atlas failed identically, establishing the mount cause. The verification mounts now explicitly permit execution while retaining `nosuid`, disabled networking, read-only root and the actual Landlock boundary. All 51 filesystem/Python/Bash tests then passed; none were removed. The independent Office gate passed 26 tests, and the 23,278,008-byte Latin/Arabic/CJK font passed the actual Linux PDF/OCR/navigation/attachment oracle. The font was streamed into a disposable container, not committed or embedded in the image.

The next default-entrypoint run exposed a missing production `playwright` dependency. It is now declared by the server using the same existing workspace version range. The final production image, `sha256:63a8977614e07b14a1cb2af2828d35dee5e798b29032953a27c40d9a1f8e0a67`, passed **77 tests, 0 failures and 412 assertions across 11 files**. A separate run with the strict startup checker verified `/health` as HTTP 200 JSON with `ok: true` and API version 1, and the built dashboard as HTTP 200 HTML. The large-font/PDF/OCR oracle also passed again in this final image. These checks use the actual default entrypoint, UID 1000, no network and no host mounts.

The [Docker evidence summary](validation/docker-linux-proof-20260906/summary.json) retains exact source hashes and unsuccessful or superseded attempts. All 36 selected runtime/test source hashes matched inside the final image. Three channel entrypoints reached their expected unconfigured rejection with networking disabled; this proves module loading, not live messaging. Disposable containers were removed, the dedicated VM was stopped, and the default Docker context stayed unchanged. An arm64 result does not certify amd64 or a remote CI deployment.

Container checks require production UID 1000, actual Python/Bash permission-denial errno, sibling canary preservation, actual PDF/font/runtime engines, and full filesystem/Python/Bash regression files. A built image alone cannot satisfy these gates.

## Evidence

The [machine summary](validation/live-execution-2026-09-06/summary.json) records reviewed results and hashes referring to the original local logs. The [existing evidence archive](validation/live-execution-2026-09-06/archive-index.json) retains earlier sanitized manifests, per-case results, native tool traces, HTTP recordings and compressed logs. Independent review matched all 37 archived provider payloads to their original bytes. Successful recordings can be replayed offline; failed HTTP recordings are not labeled successful fixtures. Native authentication or model discovery alone is not inference evidence. Pending prerequisites are not counted as passing tests.

Automatic approval review rejected a later bulk copy of raw logs into the repository because scanning configured API keys alone could miss other sensitive data. That copy was not retried. The final records use reviewed facts and hash references to local originals; the earlier archive remains unchanged.

Four positive API recordings (Gemini and `cx/gpt-5.4-mini`, each raw probe and service flow) are preserved as original gzip bytes alongside formatted replay JSON. Replay verifies archive/content/formatted hashes and full JSON semantic equivalence before matching every request URL and complete request body, running two protected file tools and comparing the original live file hash. Modified archives, changed semantics, missing captures and unexpected HTTP requests fail closed.

The new unfiltered repository run passed **6,358 tests, 0 failures, 21,585 assertions across 653 files**. The separate initial scripts run had **87 passes and one failure**: the captionless WhatsApp text-file case did not reach the controlled model. Instrumented isolated and predecessor-order reproductions passed, so timeout changes were not justified. The initial failure is retained; a later pass alone does not establish its cause. Investigation also found that the mock channel harness was recovering real worker processes from fake configuration; the harness's worker lifecycle is now explicitly controlled, while handlers, HTTP, identity, SQLite and file operations remain real. The complete scripts target then passed 90 tests across 13 files. Including the proof-checker regressions, the final unfiltered scripts target passed **116 tests, 0 failures and 385 assertions across 15 files**. The root TypeScript check and global lint also passed. These overlapping test counts must not be added.

Independent review also reproduced a false-positive Docker startup check using an HTML response at `/health`, and found messenger cleanup paths that could leak a dedicated socket or replace a confirmed-send receipt with `uploadAccepted:false`. The proof checkers now require actual health JSON and bounded requests, guaranteed teardown, and preservation of an acknowledged send even when cleanup fails. These controlled negative tests validate the checker; they are not additional live-provider or messenger successes.

The corrected Claude provider guide was checked in a local browser: HTTP 200, readable before/after screenshots, sidebar navigation and search-dialog open/input/Escape/reopen passed without page errors. Search results and destination navigation were not verified in this follow-up preview. The temporary server was stopped. This documentation check is not evidence of a completed OAuth login.

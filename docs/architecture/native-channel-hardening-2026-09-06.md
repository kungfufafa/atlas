# Native messenger controls and tenant integration policies

This follow-up implements the native channel gaps identified after the earlier
[file/provider execution report](live-proof-2026-09-06.md). It extends, and does not
replace, the [A01–A14 authorization audit](tenant-channel-authorization-audit.md).
The implementation is not a claim of complete OpenClaw parity or live delivery.

## Behavior

A profile can be assigned the `channel_action` tool. Its arguments contain an
action, never an organization, recipient, room or user. The authenticated worker
binds the actual conversation before a turn. Atlas publishes a pending action
through the same streaming tool bridge used by API and subscription providers.
The worker must claim that exact pending request before an effect, then report
its receipt. The model waits for this result. `accepted` means a platform
acknowledgement; it does not mean the recipient received or read the message.
`failed` and `unknown` carry an error and are not successful tool results.
The provider-facing declaration has a portable object root. Strict action-specific
validation runs before dispatch, so this compatibility does not permit unrelated
fields, arbitrary destinations, or incomplete actions.

The claim binds organization, channel, session, profile, canonical principal,
room and topic/thread. Duplicate claims, unclaimed receipts and foreign bindings
are rejected. Current role, profile tool assignment and integration rules are
checked again before effects. Workers also recheck after media preparation;
Discord refreshes current native permissions. A receipt for an already completed
effect remains recordable after a later membership revocation. It does not
authorize another effect. Cancellation before a claim fails the action; a missing
receipt after a claim is uncertain. Identical uncertain actions are blocked for
ten minutes in the running server. Pending requests and this suppression cache
are process-local; they are not a durable exactly-once delivery guarantee.

Native control registries bind random tokens to the actual sender, organization,
session, room, topic/thread, platform message and expiry. They consume controls
once and check current authority. Questionnaire submissions additionally include
the full original questionnaire snapshot. Under the HTTP session turn lock, the
server compares the current database snapshot and consumes it once. A changed
questionnaire with the same ID, a replacement, or a replay receives HTTP 409.
Native approval decisions also require the server-bound conversation and the
existing persisted, owner-bound approval. A callback alone cannot grant approval.

| Channel | Added native behavior | Deliberate limits |
| --- | --- | --- |
| WhatsApp | Emoji single-choice questionnaire and approve/deny reactions on exact bot messages; reactions, polls, edit/delete; actual audio/PTT/video encoding; image extraction from stickers and representative video frame plus configured transcription | Multiple-choice questionnaires use an explicit typed-answer fallback. Uses Baileys protocol payloads. Sticker understanding uses the first frame. No WhatsApp forum/topic or pin operation is synthesized. Unsupported poll options fail explicitly. |
| Telegram | Inline single/multiple choice questionnaires and approve/deny buttons; reactions, polls, edits/deletes, pins, forum topic create/edit; voice/audio/video output; static stickers and bounded video sampling | At most four sampled frames of a video up to 60 seconds; video audio is not transcribed by this sampling path. Animated TGS/WebM stickers remain unsupported. |
| Discord | Single-choice buttons, multiple-choice selects and custom-answer modals; native approvals; reactions, polls, edit/delete, pin/unpin, thread/forum creation; native voice attachments; explicit voice join/leave with an owner-only speech pipeline | Voice is bounded transcription → agent → configured speech, not a native realtime-model connection. Discord receive behavior is not an upstream stability guarantee. Native role/room permissions still apply. |

Media delivery records accepted or uncertain native paths during the turn, so
ordinary artifact auto-delivery cannot resend the same voice/video/file. Artifact
registry and share evidence remain available. No retry silently converts an
uncertain native delivery into a second document upload.

## Tenant policy layers

Existing pairing/open/allowlist/denylist configuration retains its established
semantics. A separate per-organization integration policy intersects with that
configuration and RBAC. The new layers are integration enablement, native action
flags, DM/group rules, wildcard and exact room rules, topic/thread rules, and
wildcard and exact sender rules. Any applicable denial wins. WhatsApp phone and
PN/LID aliases participate in the same intersection. An explicit empty allowlist,
role list or tool list denies all entries; an omitted list inherits. Explicit
`false` and empty lists survive API/UI roundtrips. Platform administration does
not bypass a new integration denial.

Rules can restrict senders, roles, tool names and native actions, and require a
mention in groups. An explicit `requireMention: false` enables unaddressed group
admission only when another intersecting rule does not require a mention. An
incomplete room/group origin fails closed when scoped policy rules exist. Ordinary
guest tool admission keeps its previous restrictions; binding a native context
does not accidentally disable every guest tool. Native effects and voice remain
unavailable to guests and viewers.

Only workspace/platform administrators can read or save these integration
policies. Workers cannot access the policy administration routes. The dashboard
uses an organization-bound client for the dialog so a delayed save cannot follow
a switched global workspace. Existing room/sender rules and optional values are
preserved. An absent policy inherits existing defaults; malformed policy denies
execution. Stale authority and save failures return explicit errors.
The server bounds JSON input, policy size, pending actions and retained contexts.

Discord voice defaults off and requires exact allowed room IDs. It also requires explicit
workspace transcription and speech configurations. Speech names a provider
instance, model, voice and the OpenAI audio-speech transport. Only a configured
OpenAI/OpenAI-compatible API instance with its own credential qualifies; host
environment credentials and native ChatGPT/Claude subscriptions cannot fill in
missing support. Compatible transport support is not universal model support.
Provider requests reject redirects, bound response bytes/time, parse actual PCM
WAV, and check role/policy/configuration before inference and before returning
bytes. Input recording duration is checked from actual PCM bytes. Successful
requests retain workspace/user/profile/provider-instance usage attribution;
request counts are measured, while unavailable token/cost data is not evidence
of free usage.

Voice authorization compares the submitted origin with the conversation already
bound on the server. Supplying an allowed room ID for a different bound room is
rejected before provider HTTP. Transcription uses the explicit workspace
environment through capability selection and execution, including the Cloudflare
account ID; an empty environment cannot fall back to host configuration. Leaving
voice stops later stages and cancels bounded media processes. An already-running
transcription HTTP request can continue until its adapter timeout (up to 60
seconds); immediate upstream inference cancellation is not proven.

FFmpeg processes receive an explicit restricted environment and support forced
termination. Discord playback converts to verified PCM before in-process Opus
encoding, avoiding the voice library's implicit FFmpeg probe. WhatsApp supplies
an explicitly generated thumbnail to Baileys so its implicit shell thumbnail
path does not run. These paths have actual process and media-byte regressions,
including non-default input sample rates and abort/reap behavior.

Each tenant currently has the existing single configuration/worker for each
channel. Multiple independent WhatsApp accounts or Telegram/Discord bot accounts
within one tenant have not been implemented by this change.

## Executed boundary matrix

| ID | Dimensions exercised | Evidence boundary |
| --- | --- | --- |
| N01 | Six provider types: OpenAI, Anthropic, Gemini, compatible, ChatGPT, Claude; ordinary and native tool dispatch | Real Hono SSE bytes through AtlasClient, pending request, HTTP claim/receipt and history. Provider generation is controlled. |
| N02 | Three channels × duplicate claim, foreign tenant/channel/session/sender/room/topic, premature/replayed receipt, cancellation and uncertainty | Actual SQLite, identity service, middleware and HTTP routes; no upstream messenger send. |
| N03 | Three channels × six rule layers × three principal roles × seven denial kinds | 378 predefined intersection cases, plus WA alias, DM, absent origin, false/empty preservation and malformed policy cases. This is not the Cartesian product of every possible configuration. |
| N04 | Three channels × role, membership, tool assignment, tool rule, native action rule, sender rule and room rule revoked after request | Current-state claim denial; already acknowledged effects remain recorded after revocation. Guest ordinary-tool regression included. |
| N05 | Three channels × real pending approval with foreign room/topic/group origin; questionnaire changed/replayed/consumed | Real persisted approval and questionnaire guards. WA additionally exercises DM/group × four policy revocations while approval is pending. |
| N06 | WhatsApp DM/group and PN/LID; Telegram DM/group/forum; Discord DM/guild/thread and current native permissions | Production worker handlers, native callback registries and constructed SDK/protocol payloads. Platform transport/connection is controlled. |
| N07 | Audio/video/sticker conversion, media byte equality, malformed/oversized/cancelled input and native/artifact dedupe | Actual FFmpeg/FFprobe and Opus codec, bounded native conversions, local files; no handset rendering claim. |
| N08 | Voice room/role/integration disablement, configuration change, malformed WAV, actual multipart upload, duration and tenant usage | Actual localhost provider HTTP with synthetic credentials/audio; Discord connection and speech endpoint behavior controlled. |
| N09 | Three dashboard channel cards, optional values, nested rules, save/reload, tenant switch, failed save and delayed read | Real browser, Hono policy routes and temporary tenant data, screenshots retained. |
| N10 | Whole repository/scripts, production and targeted test TypeScript, lint, Docker/Linux runtime and strict startup | Final executed counts and hashes are in the machine-readable evidence summary. Overlapping targets must not be added. |
| N11 | Three channels: revocation during artifact reads/preparation, cached attach/share, session replacement, later uploads and metadata fallback; Discord second thread effect, session-owned mutations and request expiry | Actual HTTP/SQLite and file reads with controlled platform sends. Denied cases require zero additional file, filename/path and cached-link disclosure after authority denial; earlier completed effects remain recorded. Positive viewer reads retain their existing rights. Failing-before logs are retained. |

The follow-up also checks revocation during ordinary artifact reads and media
preparation, including cached attachment/share delivery and each later effect in
a multi-step action. Ordinary artifact reads preserve the viewer's existing read
rights; native mutations require stronger authority. The intermediate 6,649-test
repository pass preceded these final boundary corrections and is not labeled as
their final regression run.

The scoped worker is the trusted attester of native platform identity and room.
Tests do not prove that a compromised worker credential cannot lie about an
upstream sender. Worker tokens are fixed to an organization and channel; this
change does not turn them into independently verifiable platform signatures.

## Results and remaining proof

The final host repository run passed **6,734 tests, 0 failures and 23,941
assertions across 678 files**. The complete scripts target passed **116 tests,
0 failures and 385 assertions across 15 files**. Both used replay mode and
disposable configuration. The final channel suites passed WhatsApp **345**,
Telegram **468** and Discord **408** tests; these are overlapping targets,
not additional tests to add to the repository total. Production and web
TypeScript passed, alongside all Telegram/Discord source and tests, the four
new WhatsApp test files, and eight shared new/updated test files.

The actual final **Linux ARM64** image is
`sha256:8944c83b9e75d23c12006aebaf6458fa089eaf97acde9489a53214f4c6a96c8b`.
Its container gate passed **515 tests, 0 failures and 2,952 assertions across
38 files**. Strict default-entrypoint startup returned valid API v1 health JSON
and dashboard HTML, both HTTP 200. All **1,219 runtime source hashes** matched
inside the image; **2,045 host build inputs** remained unchanged. All **18 bundled
skill assets** parsed and installed byte-for-byte. The separate **23,278,008-byte
font** oracle verified Latin/Arabic/Japanese PDF generation and extraction,
four outlines, navigation targets `[1, 3]`, two byte-exact attachments and unchanged
input files. OCR recognized a separate English scan; Arabic/Japanese OCR was not
tested. Local native
DAVE key generation and AES-GCM availability also passed; this is not a live
Discord voice connection. Detailed image, manifest and cleanup evidence is in
[the Docker summary](validation/native-channels-20260906/docker/summary.json).
All disposable containers and volumes were removed and the dedicated VM was
stopped. The final image remains available in that verification environment.

Final checks and source/log SHA-256 references are recorded in
[the evidence summary](validation/native-channels-20260906/summary.json).
Synthetic UI screenshots are in
[the browser evidence directory](validation/native-channels-20260906/browser/).
Raw test/build logs remain in their named local temporary paths; secrets-bearing
operational logs are not bulk-copied into the repository.

The first whole-repository run failed: it exposed an over-budget questionnaire
schema and a non-object native tool declaration, plus four HTTP test timeouts and
four late unhandled errors. The two schema regressions were fixed without
relaxing their original budgets. The entire 614-test authorization file then
passed with its unchanged five-second deadlines; its previous timeout cases took
94–127 ms. This does not establish the cause of the earlier scheduling delay.
Both the initial failed run and final rerun are retained in the evidence summary.
Independent adversarial checks also reproduced the forged voice-room and host
Cloudflare-account fallbacks before their fixes and verified rejection with zero
provider requests afterwards. Discord multiple selection similarly records its
failing-before and passing-after tests. A later Telegram audit identified that
post-media-read authorization still used read permission; the follow-up tests
exercise role, tool assignment and action-policy revocation during that read,
alongside cancellation and request expiry. Discord review reproduced message
mutations outside the owning session and a second thread-message send after
revocation or cancellation. The corrected dispatcher enforces message ownership
and rechecks authority, signal and expiry before each effect. Ordinary artifact
tests reproduce late file/metadata/share leaks and verify fresh read checks
across all three channels, including cached and fallback paths.

Live messenger deliveries are **not run**: no approved test chat/recipient was
provided. Native controls, poll rendering, audio playback, Discord voice reception
and reconnect behavior still need designated real-account tests. Prior direct
Claude inference is not proven; its prior Atlas authentication probe reported
unauthenticated access. Earlier
live provider results and their failures remain in the separate execution report;
a controlled six-provider bridge test does not promote them to live passes.

The native Linux ARM64 Docker run verifies the built image, not another CPU
architecture or a remote CI deployment. Complete OpenClaw feature parity and
production readiness are not inferred from passing local gates.

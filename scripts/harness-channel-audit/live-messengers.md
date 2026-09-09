# Live messenger file proof

This harness supplements the production-handler authorization tests. It does
not count mocked transport tests, an accepted upload, or a download of the bot's
own message as an independently received file. No target is taken from channel
configuration, recent messages, pairing history, or the first organization.

## Evidence levels

| Result | What it proves |
| --- | --- |
| `DRY_RUN` | Explicit manifest and matching scoped configuration; zero network requests |
| `READ_ONLY_PROBE_PASS` | Current canonical member/profile/ACL accepted and exact bot/chat metadata accessible; no send |
| `WAITING_FOR_INDEPENDENT_RECEIPT` | Production artifact-send helper called the live API and the platform download has the synthetic file's SHA256 |
| `INDEPENDENT_FILE_ROUNDTRIP_PASS` | An independent, explicitly selected user replied to the exact sent message with the same named file and byte hash |

Every report keeps `handlerEndToEnd: NOT_RUN`: this narrow transport probe calls
the real artifact-send helper after server authorization. It does not invoke an
LLM, create an Atlas session, execute the inbound chat handler, or prove every
document format, DM/group/thread variant, or recipient device read receipt.
The uploaded fixture is one small multilingual UTF-8 text attachment. It tests
byte transport, not Word/Excel/PDF fidelity or multilingual font rendering.

## Preparation with no external messages

```sh
bun scripts/harness-channel-audit/live-messengers-inventory.ts
bun test scripts/harness-channel-audit/live-messengers.test.ts
bun scripts/harness-channel-audit/live-messengers.ts /absolute/private/manifest.json --dry-run
```

Inventory reads only local configuration and heartbeat files. It prints hashed
organization references, counts, and booleans; it does not print bot tokens,
phone numbers, users, raw configuration, or unrelated messages. Legacy/global
configuration is explicitly unsupported for scoped proof. The test suite uses
controlled HTTP/socket transports and temporary test configuration, so its
passing result is **not live messenger evidence**.

The manifest must identify the exact user-authorized test destination, receiver,
organization, and profile. Store it privately, never in committed evidence.
Example shape (placeholders intentionally cannot execute):

```json
{
  "schemaVersion": 1,
  "channel": "telegram",
  "orgId": "EXPLICIT_ORG_ID",
  "profileId": "EXPLICIT_PROFILE_ID",
  "destination": "EXPLICIT_CHAT_ID",
  "receiverUserId": "EXPLICIT_RECEIVER_USER_ID",
  "serverUrl": "http://127.0.0.1:4310",
  "authorizationReference": "Reference to the user's exact destination approval",
  "authorizationExpiresAt": "ISO timestamp within the next 24 hours",
  "dedicatedTelegramPolling": false
}
```

Telegram direct chat ID must equal the receiver user ID. Negative group IDs
are accepted only when explicitly supplied; an optional positive `topicId`
locks both upload and receipt to that topic. Discord requires an explicit
channel/thread snowflake and independently selected receiver user snowflake.
WhatsApp currently accepts only an explicit direct phone JID such as the
syntactic form `digits@s.whatsapp.net`; no phone/LID guessing or group fallback.

The exact tenant's channel configuration must exist and select the manifest's
profile. A scoped `ATLAS_WORKSPACE_AUTH_TOKEN` must already be injected by the
authorized runtime. The harness never mints a credential, falls back to host
authentication, pairs a user, edits ACLs, or copies another runtime's auth.
The server rechecks the actual receiver's current member role and file authority.
Viewer, guest, revoked membership, blocked identity, and foreign profile fail.

## Explicit live execution

Only after the user authorizes the exact destination, review the private
manifest and set `ATLAS_LIVE_AUTHORIZED_MANIFEST_SHA256` to the SHA256 of those
exact manifest bytes. This environment value binds the operation to the
reviewed file; it is not a substitute for user authorization.

```sh
bun scripts/harness-channel-audit/live-messengers.ts /absolute/private/manifest.json --probe
bun scripts/harness-channel-audit/live-messengers.ts /absolute/private/manifest.json --send
```

`--send` transmits one synthetic attachment. A private, exclusive lock in the
temporary directory prevents automatically repeating that manifest's send.
If a response is uncertain, inspect the destination before any separately
authorized retry; do not remove the lock and blindly repeat. The report records
`sendAttempted` separately from platform confirmation. URLs containing tokens,
message bodies, bot tokens, raw destinations and raw platform errors are never
printed. Private message/file IDs live only in the mode-0600 run-state file.

Have the explicitly selected receiver download the file and reply to the bot's
original message with that file as an attachment, retaining its filename.
Then run, within the manifest's authorization window:

```sh
bun scripts/harness-channel-audit/live-messengers.ts /absolute/private/manifest.json --receive /absolute/private/private-run-state.json
```

This is one bounded receipt check, not a background monitor. Discord requests
at most 100 messages in the exact approved channel after the sent message and
downloads only the matching receiver's reply attachment. Telegram receipt
checks require an explicitly dedicated bot, no live local worker heartbeat,
and no webhook; an active production poller must never be displaced. The
request supplies no positive update offset and does not acknowledge updates.
If a reply is outside this bounded window or unavailable, the result stays
blocked. Receipt hashes are derived from platform downloads, not operator
assertions or an uploaded local JSON receipt.

## WhatsApp prerequisite and optional dedicated runtime

The operational WhatsApp outbound HTTP endpoint sends text only. With no
explicit dedicated identity, the CLI reports
`DEDICATED_WHATSAPP_FILE_SOCKET_REQUIRED`. Existing operational authentication
is not permission to connect it. After the user supplies a separately owned,
already registered test identity and exact target, add these optional manifest
fields (syntactic placeholders shown):

```json
{
  "dedicatedWhatsAppAuthDir": "/absolute/private/dedicated-registered-auth",
  "dedicatedWhatsAppSenderJid": "EXPLICIT_TEST_SENDER_PHONE@s.whatsapp.net"
}
```

The sender phone must match the exact tenant's channel configuration and differ
from the receiver. The credential directory must already exist outside both the
selected Atlas config root and the default host `~/.atlas`. Only regular files
are accepted; symlinked keys and an identity already found in operational auth
are rejected. No credentials are copied. Dry run reads the registered identity,
profile/configuration and heartbeat only; `--probe` adds canonical Atlas API
authorization but leaves the external socket disconnected.

Once the exact manifest hash is authorized, `--send` and `--receive` may open one
explicit dedicated connection using those existing registered credentials. An
exclusive directory lock prevents a concurrent harness connection. The socket
has no QR display, pairing/login request, automatic reconnect, history sync or
operational worker. The wrapper closes only its own connection and releases its
lock when the run finishes. A missing, stale or invalid registered session fails
rather than initiating login. Current membership/ACL, configured sender phone,
and absence of an operational worker are checked again before file actions.

The adapter uses the production WhatsApp artifact-send and bounded
media-download helpers. `--send` uploads and checks platform download bytes;
`--receive` loads the private run state, opens the same dedicated identity and
waits at most 30 seconds for the exact direct sender's matching reply. It denies
media reupload requests so a failed download cannot send another message.
Phone/LID aliases, groups and wrapped/ephemeral media remain unsupported by this
bounded live proof. An unavailable matching reply remains blocked.

`live-messengers-whatsapp.ts` can also attach to a test runtime's already
connected dedicated socket. Its test-only injected authorization/download
functions must not be used as live evidence. The default uses canonical server
file authorization; the runtime wrapper supplies the approved manifest binding,
forwards real incoming messages, and calls the same shared receipt verification.

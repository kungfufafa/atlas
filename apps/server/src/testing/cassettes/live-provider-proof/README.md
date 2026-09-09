# Recorded provider file flows

Run offline from the repository root:

```sh
bun test apps/server/src/providers/provider-file-flow.llm.test.ts
```

The manifest contains four successful recordings from September 6, 2026:
Gemini `gemini-3-flash-preview` and the configured compatible endpoint's
`cx/gpt-5.4-mini`, each through a raw provider probe and through AgentService.
Each recording contains three actual HTTP exchanges and its original Atlas
history. Each `.json.gz` archive preserves the original captured bytes exactly;
its adjacent JSON is formatted for repository checks. The manifest retains the
original capture SHA-256, compressed archive SHA-256, formatted JSON SHA-256 and
the real file hash. Replay verifies all three capture hashes and requires the
formatted JSON to be semantically identical to the decompressed original before
constructing a provider.

Replay uses the actual provider adapters, exact captured request/response values,
and the current protected `write_file` and `read_file` implementations. It
relocates the captured synthetic workspace into a fresh temporary directory.
Every HTTP method, URL and complete JSON body must match the relocated capture;
unexpected requests are rejected and all recorded exchanges must be consumed.
The recorded nonce and system time are preserved. Recorded artifact IDs,
creation times and session IDs are reused in replay history only after actual
tool output paths, sizes, MIME types and contents have been checked. No host
config or provider credential is loaded; no request reaches a provider.

The service captures passed actual AgentService admission and a current DB role
demotion check when recorded. This offline suite repeats adapter and protected
file behavior, not that live service admission check. The manifest separately
lists unavailable or failed cases: both OpenCode credentials returned HTTP 401;
Fusion's final response changed the nonce despite correct file tools. Neither
is a passing fixture. Native ChatGPT uses separate runtime trace/hash evidence;
Claude authentication was pending. Earlier apparent OpenCode 500 responses were
caused by the recording wrapper replacing upstream errors; its regression now
preserves and replays the original 401 status and body.

To update a fixture, run the explicit live gate, retain failures in the audit
ledger, and archive only the successful case's original cassette and trace
unchanged. Format a JSON copy, then update the manifest with its formatted hash,
the original and archive hashes, and the live result's file hash. A missing,
modified or semantically different capture fails the test; this suite never
records automatically.

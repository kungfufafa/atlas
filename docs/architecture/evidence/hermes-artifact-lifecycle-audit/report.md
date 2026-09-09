# Confirmed cross-session artifact attribution

The unmodified candidate3 protected executor misattributes another session's file when two calls overlap in a shared profile workspace. This is deterministic local evidence, independent of model behavior.

| Scenario | Actual file writers | A's protected artifact result | B's protected artifact result |
| --- | --- | --- | --- |
| Serial control | A writes `a.txt`; B writes `b.txt` | `a.txt`, session A | `b.txt`, session B |
| Overlapping writes | A writes `a.txt`; B writes `b.txt` while A waits | **`a.txt` and `b.txt`, both session A** | `b.txt`, session B |
| Overlap, A does not write | Only B writes `b.txt` | **`b.txt`, session A** | `b.txt`, session B |

Six actual `executeProtectedTool` calls ran once each with two distinct trusted user/session contexts in the same organization/profile. The barrier opens only after A's pre-execution snapshot and completes B's entire call before releasing A. Tool return values identify their own producer and declare **no artifact references**; the incorrect references therefore originate from Atlas's directory-diff inference. Distinct source bytes, every call/effect, returned metadata, file hashes and resulting artifact references are retained in `run-CidGS4/evidence.json` and its adjacent workspaces. Elapsed fixture time: 35.22 ms; no provider/native-model calls or retries.

`extractSessionArtifacts` also accepts the misattributed file when given the tool-result object merge used by the production loop. That history was reconstructed explicitly; no database persistence, authenticated HTTP route, channel delivery, or real Python process was exercised. The result proves the executor/extractor defect and motivates the source-observed session-allowlist concern; it does not establish an end-to-end delivery exploit.

The relevant selected production source hashes were equal before and after. `source-bindings.json` records source/report/reproducer hashes. This audit writes only to its private directory and makes no production or control changes.

## Safe correction boundary

Treat whole-directory changes as **unattributed observations**, not proof of which session produced a file. Prefer an execution-bound publication receipt with actual canonical output path and content identity, and per-execution staging for shell/Python output discovery. Preserve automatic artifact delivery through a reviewed replacement rather than simply suppressing all discoveries. Explicit tool declarations alone are also insufficient if tools can report arbitrary paths without validation.

A process-local lock around the entire snapshot → tool → snapshot interval would remove this fixture's interleaving, but is only a mitigation. It does not cover other worker processes, detached/untracked writers, or same-file changes after publication; it adds long-tool serialization and can deadlock nested execution or approval waits. Do not describe that lock as a complete ownership/privacy fix. Multiprocess and nested-tool behavior should be validated before selecting an implementation.

The separate completion audit in `design-note.md` also identifies loss of typed limit/stall reason when a task is marked done, and distinguishes physical artifact delivery from semantic verification. No model critic or provider-specific prompt is proposed as the first correction.

Reproduce with `bun run /private/tmp/atlas-artifact-attribution-audit/reproduce.ts` from the Atlas repository; every invocation creates a new retained workspace. This command is a local diagnostic, not a passing product regression or comparative benchmark.

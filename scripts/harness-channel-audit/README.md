# Harness and channel audit reproduction

Run from the repository root after `bun install`:

```sh
bun run scripts/harness-channel-audit/run.ts
```

The runner creates a fresh temporary Atlas config/SQLite directory and two
localhost ports. It uses actual HTTP routes, file tools, persistence and channel
handlers, replacing model inference and external channel transports with
controlled peers. It also runs the installed Claude MCP and Codex JSON-RPC
persistence regressions. It sends no live channel messages and copies no host
provider tokens. All case reports and logs remain in the printed temporary
directory; failures yield a nonzero exit code after recording the results.

The runner stops only its own server process. It does not repeat the historical
SIGKILL/restart experiment or browser QA. Those separate experiments and their
failed setup attempts are recorded in
`docs/architecture/harness-channel-deep-audit.md`; the sanitized historical
evidence is under `docs/architecture/validation/`.

To sanitize a retained historical audit directory:

```sh
bun run scripts/harness-channel-audit/sanitize-evidence.ts <audit-directory> <output.json>
```

An old passing process exit code is not sufficient: initial fixtures caught
individual failures, and the historical ledger explicitly withdraws one restart
claim made before an actual process restart. Read the case results and evidence
classes before drawing a readiness conclusion.
# Live prerequisites

`bun scripts/harness-channel-audit/live-claude.ts` probes the installed Atlas
Claude authentication state and returns exit 2 with `BLOCKED` when unavailable.
After login, the gate selects a model advertised by that native runtime. Set
`ATLAS_LIVE_CLAUDE_MODEL` to select an exact advertised model explicitly. The gate
refuses missing runtime metadata and exercises native MCP through protected file
creation and a dependent read with byte verification. Its auth directory is
`<ATLAS_CONFIG_DIR>/subscription-auth/claude` (the default Atlas root is
`~/.atlas`); it pins this path even when the shell has `CLAUDE_CONFIG_DIR` set.
This sends no messenger messages and does not turn protocol tests into live
inference evidence.

`bash scripts/verify-docker-files.sh` builds and exercises a disposable production
image without mounting host data, opening network access, or stopping an existing
Atlas container. An unavailable Docker daemon returns exit 2 with `BLOCKED`.

# Atlas Agent Squad

Three Atlas profiles plus automations run the existing test harnesses.
They do not replace a human release owner. They do not merge to `main`.

## Roles

| Profile | Job | Tools | Must not |
|---|---|---|---|
| **Atlas QA** | Run production-scope gates and report PASS/FAIL | `bash` (test scripts only), `agent-browser` | Touch live customer orgs, deploy, merge |
| **Atlas Hunter** | Find regressions with file + repro | `search_files`, `ripgrep`, `read_file`, `coding-agent` | Push `main`, delete data, silent-fix |
| **Atlas Release** | GO / NO-GO vs current production scope | `read_file`, `save-artifact` | Invent new features as blockers |

Human owner (you): severity, merge, production deploy.

## Loop

1. Hunter reads the diff and known bug classes (session ACL, provider tools, persist-before-commit, channel-as-admin).
2. QA runs `bun run atlas:release-gate` and `bun test ./scripts/e2e-critical-paths.test.ts` from the approved repository checkout.
3. QA runs `bun run atlas:channel-loop`. This harness creates its own temporary database, tenant, Atlas server, and mock model/transport, and disables real channel workers. No Telegram, WhatsApp, or Discord worker or credential is required. A pass covers handler/server/file integration, not delivery through the live messaging services.
4. Auditor compares results to the production-scope list and writes GO / NO-GO.
5. Findings become GitHub issues (use the Agent finding template). Fixes go through PRs.
6. Skill write-approval stays ON so agents cannot quietly rewrite skills.

## Dashboard setup

1. **Settings → LLM providers** → configure a provider and assign an available model to the three profiles. The harnesses use their own mock model; the profiles need a provider only to plan and report their work.
2. Create a workspace org named `qa`. Never point these agents at the live customer org.
3. Create the three profiles. Paste the matching soul files from this folder.
4. Assign tools from the table. Install `agent-browser` + Chrome on the host before enabling the skill. Assigning `bash` grants a shell, not a command allowlist; the soul instructions below are operating guidance, not a security boundary.
5. Turn on org/profile write approval.
6. Add an Atlas automation that asks **Atlas QA** to run the nightly matrix.

## Repository and runtime setup

Atlas Bash starts in the profile workspace, not this source repository. The owner must provide a dedicated checkout of the revision being reviewed inside the QA profile workspace, such as `repos/atlas`, so its assigned file tools can read it. Record the explicit absolute checkout path. Run each command from that checkout (for example, `cd /absolute/path/to/profile/repos/atlas && bun run atlas:channel-loop`); do not assume the profile workspace already contains the code. Never point this checkout at customer configuration or data.

Install dependencies with the repository's supported Bun version and provision the browser and document runtimes required by the selected checks. Record the commit SHA and tool versions with the report. A missing prerequisite is a blocked check, not a passing check.

## Commands for the isolated checks

```bash
bun run test
bun run atlas:release-gate
bun test ./scripts/e2e-critical-paths.test.ts
bun run atlas:channel-loop
```

Run `bun run atlas:production-readiness` separately when the owner requests a soak assessment. It is not a mandatory nightly merge gate.

`scripts/e2e-full-qa.ts` is a separate browser script for an already provisioned test dashboard. It currently uses fixed test-account credentials; inspect and provision those fixtures before running it. Set `ATLAS_TEST_BASE_URL` to the approved local/QA instance and `ARTIFACT_DIR` to a writable QA output directory. Do not run it against production or count it as an isolated harness.

## Definition of done (beta)

- Release-gate golden journeys pass
- Tenant-isolation and approval-security suites pass
- Session and attachment access-control regression tests pass on the exact revision being released
- The isolated channel harness passes for all three channels; separately record live smoke results for channels enabled on the target server
- No S0 (security / data-loss) issue left untracked

This is a detection process, not a promise of zero bugs.

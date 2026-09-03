# Atlas Agent Squad (software-house lite)

Three Atlas profiles plus Grok Automations. They run the existing test harnesses.
They do not replace a human release owner. They do not merge to `main`.

## Roles

| Profile | Job | Tools | Must not |
|---|---|---|---|
| **Atlas QA** | Run production-scope gates and report PASS/FAIL | `bash` (test scripts only), `agent-browser` | Touch live customer orgs, deploy, merge |
| **Atlas Hunter** | Find regressions with file + repro | `search_files`, `ripgrep`, `read_file`, `coding-agent` | Push `main`, delete data, silent-fix |
| **Atlas Release** | GO / NO-GO vs current production scope | read reports, `save-artifact` | Invent new features as blockers |

Human owner (you): severity, merge, production deploy.

## Loop

1. Hunter reads the diff and known bug classes (session ACL, provider tools, persist-before-commit, channel-as-admin).
2. QA runs `bun run atlas:release-gate`, then `bun test scripts/e2e-critical-paths.test.ts`, then `scripts/e2e-full-qa.ts`.
3. If Telegram / WhatsApp / Discord workers are actually running, QA also runs `bun run atlas:channel-loop`.
4. Auditor compares results to the production-scope list and writes GO / NO-GO.
5. Findings become GitHub issues (use the Agent finding template). Fixes go through PRs.
6. Skill write-approval stays ON so agents cannot quietly rewrite skills.

## Dashboard setup

1. **Settings → LLM providers** → add **xAI Grok** (or Custom OpenAI-compatible `https://api.x.ai/v1`) and assign the model to the three profiles.
2. Create a workspace org named `qa`. Never point these agents at the live customer org.
3. Create the three profiles. Paste the matching soul files from this folder.
4. Assign tools from the table. Install `agent-browser` + Chrome on the host before enabling the skill.
5. Turn on org/profile write approval.
6. Add an Atlas automation that asks **Atlas QA** to run the nightly matrix.

## Commands QA is allowed to run

```bash
bun test
bun run atlas:release-gate
bun test scripts/e2e-critical-paths.test.ts
bun run scripts/e2e-full-qa.ts
bun run atlas:channel-loop          # only if channel workers are up
bun run atlas:production-readiness  # soak; do not treat as a merge blocker every night
```

## Definition of done (beta)

- Release-gate golden journeys pass
- Tenant-isolation and approval-security suites pass
- Open security finding [#47](https://github.com/kungfufafa/atlas/pull/47) is merged or explicitly accepted as risk
- Channel harness passes only when those workers are enabled
- No S0 (security / data-loss) issue left untracked

This is a detection process, not a promise of zero bugs.

# Production scope (current)

Separate repository regression checks from live-instance checks. Repository checks exercise supported behavior regardless of which channels are enabled on the target instance. Live checks cover only features enabled on the approved QA instance.

## In scope

- Web dashboard and Hono API on `:4310`
- Auth, orgs, roles (platform admin / org admin / member / viewer)
- Profiles, soul files, sessions, chat, attachments
- Tools, MCP, skills that an admin has assigned
- Atlas automations and tasks if they are used
- Docker / PM2 single-node health
- Isolated Telegram, WhatsApp, and Discord channel-loop harness, with its own server, tenant, model, and transport mocks; real workers are intentionally disabled
- Live Telegram, WhatsApp, and Discord smoke checks only when the corresponding QA worker is running and the owner has authorized the test destination
- Composio **only if connected**

## Partial / do not treat as GA

- Mobile (Expo). Typecheck is excluded from the repo root. Agent-browser is not a device farm.
- Level-3 remote cloud staging and load-balancer rollback (never run)
- Subagent delegation unless explicitly included and exercised in the current run
- Office preview if LibreOffice is missing on the host

## Security checks

- Verify session and attachment ACL regressions on the current revision, including peer-member and cross-organization access. A historical PR number does not establish whether the deployed revision is safe.
- Record current findings, owners, and explicit risk decisions with the release report rather than keeping an old PR status in this template.

## Out of scope for agents

- Deploy to production
- Merge to `main`
- Delete Docker volumes or `~/.atlas` data
- Use live customer credentials
- Invent product requirements that are not enabled today

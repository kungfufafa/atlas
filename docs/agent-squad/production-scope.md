# Production scope (current)

Only test features that are enabled on the running instance.
Do not fail the product for features that are not turned on.

## In scope

- Web dashboard and Hono API on `:4310`
- Auth, orgs, roles (platform admin / org admin / member / viewer)
- Profiles, soul files, sessions, chat, attachments
- Tools, MCP, skills that an admin has assigned
- Atlas automations and tasks if they are used
- Docker / PM2 single-node health
- Telegram, WhatsApp, Discord **only if the worker process is running**
- Composio **only if connected**

## Partial / do not treat as GA

- Mobile (Expo). Typecheck is excluded from the repo root. Agent-browser is not a device farm.
- Level-3 remote cloud staging and load-balancer rollback (never run)
- Subagent delegation (0 executions in the Aug 16 soak)
- Office preview if LibreOffice is missing on the host

## Known open risk

- Draft PR #47: session ACL on attachment downloads. Peer members can fetch private attachments if they know the ids. Track as S0 until merged or accepted.

## Out of scope for agents

- Deploy to production
- Merge to `main`
- Delete Docker volumes or `~/.atlas` data
- Use live customer credentials
- Invent product requirements that are not enabled today

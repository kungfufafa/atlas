# Workspace Channel Integrations Source of Truth

Status: Validated
Validated by: product owner, 2026-08-14

## Requirement

- CHAN-FR-001: Every workspace can configure its own Telegram, Discord, and
  WhatsApp integration.
- CHAN-FR-002: A channel credential, pairing state, selected profile, session
  map, and authentication state belong to exactly one workspace.
- CHAN-FR-003: A message received by a workspace channel can only invoke
  profiles and providers from that workspace.
- CHAN-FR-004: Automation delivery uses the channel integration owned by the
  automation's workspace.
- CHAN-FR-005: Workspace Admins and Superadmins may manage channel integration
  settings in the active workspace. Members and Viewers may not.
- CHAN-FR-006: Multiple workspaces may run the same channel type concurrently
  without sharing credentials, state, ports, sessions, or process identity.
- CHAN-FR-007: Legacy global channel configuration may migrate only to the
  earliest workspace; it must never be copied to every workspace.

## Operational boundary

- Channel instances use a fixed `orgId`; `/org` switching is not available
  inside a workspace-owned bot.
- The server may start/restart only the predefined channel worker for the active
  workspace after a valid settings mutation.
- Arbitrary worker installation and global process control remain Superadmin
  capabilities.

## Acceptance criteria

- CHAN-AC-001: Workspace A and B can save different bot credentials and read
  back only their own masked settings.
- CHAN-AC-002: Pairing in Workspace A cannot authorize a user in Workspace B.
- CHAN-AC-003: A channel worker launched for Workspace A sends `X-Org-Id` for A
  and cannot switch to B.
- CHAN-AC-004: WhatsApp auth/session/outbound state has a workspace-specific
  path and port.
- CHAN-AC-005: Member and Viewer channel-setting requests return 403 before any
  filesystem or worker mutation.

## Method credit

This artifact follows the Chain of Truth method from Vibe Coding Research,
credited to Farid Suryanto and Muhammad Ibnu Athoillah.

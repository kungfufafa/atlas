# Workspace Channel Integration Contracts

Status: Reviewed

## CHAN-API-001..003 — Channel settings

`GET/PUT /v1/settings/{telegram|discord|whatsapp}` requires an active workspace.
GET and PUT allow Workspace Admin or Superadmin. PUT validates that the selected
profile belongs to the active workspace and starts/restarts only that
workspace's predefined channel process.

## CHAN-API-004 — Pairing/reconnect

Handshake, pairing-code, and reconnect operations use the active workspace
path. They cannot read or delete another workspace's authentication state.

## Worker contract

The process receives `ATLAS_WORKSPACE_ID`, creates an Atlas client with that
fixed `orgId`, and loads channel state from the matching workspace directory.
The process name contains both channel and workspace ID.

## Error contract

- Missing workspace: 400.
- Insufficient role: 403.
- Cross-workspace profile: 404.
- Saved but worker unavailable: settings remain saved and the response reports
  the runtime error without exposing another workspace.

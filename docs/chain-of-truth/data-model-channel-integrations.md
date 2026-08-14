# Workspace Channel Integration Data Model

Status: Reviewed

## CHAN-ENT-001 WorkspaceChannelIntegration

The persisted boundary is the workspace directory:

```text
~/.atlas/orgs/{orgId}/channels/{telegram|discord|whatsapp}/
```

It contains the channel `config.ini`, pairing/authentication state, session
maps, and runtime sidecars. The compound identity is `(orgId, channel)`.

Constraints:

- `orgId` is required for all dashboard-managed channel operations.
- `profileId` must resolve inside the same workspace.
- Secrets are returned only in masked form to the dashboard.
- Runtime state for two workspaces cannot share a path.
- Legacy global directories are migrated once to the earliest workspace.

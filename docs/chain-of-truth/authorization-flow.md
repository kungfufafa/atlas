# Authorization Flow

Status: Reviewed

```mermaid
flowchart LR
  request[Authenticated request] --> active[Resolve active workspace]
  active --> membership[Verify workspace membership]
  membership --> role[Evaluate role capability]
  role --> resource[Resolve resource within active workspace]
  resource --> action[Perform read, mutation, or invocation]
  action --> audit[Return scoped result]
```

Resource lookup failures and cross-workspace mismatches return the same
not-found result. This prevents IDs from becoming a workspace-enumeration
channel.

## Negative paths

- No active workspace: reject before route logic.
- No membership: reject before route logic.
- Insufficient role: return a role-specific 403 response.
- Resource belongs to another workspace: return 404.
- Viewer attempts an invocation: return 403 before contacting a provider.

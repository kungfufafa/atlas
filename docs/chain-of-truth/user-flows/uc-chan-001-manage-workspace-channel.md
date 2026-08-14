# UC-CHAN-001 — Manage Workspace Channel

Status: Reviewed

## Flow

1. A Workspace Admin opens Integrations in the active workspace.
2. Atlas reads only that workspace's masked channel settings.
3. The admin selects a profile belonging to the same workspace and saves the
   channel credential or WhatsApp connection settings.
4. Atlas writes the integration under the workspace directory.
5. Atlas starts or restarts the predefined workspace worker instance.
6. Pairing state and future channel sessions remain inside the same workspace
   directory.

## Exceptions

- Member or Viewer: 403 before mutation.
- Profile from another workspace: reject without revealing that profile.
- Duplicate bot credential across workspaces: reject or fail worker startup;
  never merge state.
- Worker runtime unavailable: preserve saved configuration and report that the
  worker could not start.

## Postconditions

- The channel instance has one immutable workspace context.
- Incoming calls and outgoing automation delivery use that workspace context.

## Trace

CHAN-FR-001..007 → UC-CHAN-001 → CHAN-ENT-001 → CHAN-API-001..004 → CHAN-TC-001..005

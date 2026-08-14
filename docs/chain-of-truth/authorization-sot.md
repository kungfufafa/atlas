# Authorization Source of Truth

Status: Validated
Validated by: product owner, 2026-08-14

## Purpose

Atlas is a multi-workspace system. Authorization must protect both the action a
person may perform and the workspace data the action may touch.

## Roles

| ID | Role | Scope | Contract |
|---|---|---|---|
| AUTH-ROLE-001 | Superadmin | Entire system | Manages workspaces and system-wide infrastructure. |
| AUTH-ROLE-002 | Workspace Admin | One workspace | Manages members, providers, profiles, and workspace settings only inside that workspace. |
| AUTH-ROLE-003 | Member | One workspace | Uses assigned agents and workspace capabilities; cannot administer workspace configuration. |
| AUTH-ROLE-004 | Viewer | One workspace | Read-only; cannot invoke agents or mutate state. |

`isPlatformAdmin` remains the compatibility field in persisted/API data, but
its user-facing name is **Superadmin**. The organization role value `admin`
remains the compatibility value, but its user-facing name is **Workspace
Admin**.

## Invariants

- AUTH-INV-001: Every tenant resource read or mutation verifies the active
  workspace, even when the resource is addressed by an opaque ID.
- AUTH-INV-002: A Workspace Admin can never read or mutate another workspace's
  provider credentials, sessions, settings, profiles, or tools.
- AUTH-INV-003: Member mutations are limited to product usage flows explicitly
  intended for members.
- AUTH-INV-004: Viewer access is read-only and cannot trigger billable model or
  tool execution.
- AUTH-INV-005: Channel credentials, pairing state, and channel profile
  selection belong to exactly one workspace and require Workspace Admin or
  Superadmin access in that workspace.
- AUTH-INV-008: Installing or controlling the host worker runtime remains a
  Superadmin capability. A Workspace Admin may only start or restart the
  pre-approved worker instance for their own saved channel integration.
- AUTH-INV-006: Authorization failures explain the required role without
  exposing whether a cross-workspace resource exists.
- AUTH-INV-007: Public-route matching includes the HTTP method; a public GET
  never makes mutation methods public.

## Capability matrix

| Capability | Superadmin | Workspace Admin | Member | Viewer |
|---|---:|---:|---:|---:|
| Create/manage workspaces | Yes | No | No | No |
| Manage workspace members | Yes, with active membership | Yes | No | No |
| Manage workspace AI providers/models | Yes, with active membership | Yes | No | No |
| Use agents and AI media operations | Yes | Yes | Yes | No |
| Read workspace chat | Yes | Yes | Yes | Yes |
| Mutate workspace chat | Yes | Yes | Yes | No |
| Manage workspace channel credentials | Yes, with active membership | Yes | No | No |
| Install/control host worker runtime | Yes | No | No | No |
| Install system dependencies | Yes | No | No | No |

## Traceability

| Requirement | Implementation evidence | Verification |
|---|---|---|
| AUTH-INV-001, 002 | Session `org_id`, route/service workspace checks, scoped provider config | Cross-workspace negative tests |
| AUTH-INV-003, 004 | Central role guards and route matrix | Member/viewer mutation tests |
| AUTH-INV-005, 008 | Workspace-scoped channel paths and worker instances; host worker routes remain Superadmin-only | Channel isolation and worker RBAC tests |
| AUTH-INV-006 | Named guard errors | Guard unit tests |
| AUTH-INV-007 | Method-aware public routes | Public route unit/integration tests |

## Method credit

This artifact follows the Chain of Truth method from Vibe Coding Research,
credited to Farid Suryanto and Muhammad Ibnu Athoillah.

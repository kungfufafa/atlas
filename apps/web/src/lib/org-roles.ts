import type { OrgRole } from "@atlas/core/contract";

export const ORG_ROLE_LABELS: Record<OrgRole, string> = {
  admin: "Workspace Admin",
  member: "Member",
  viewer: "Viewer",
};

export function isViewerRole(orgRole: string | undefined): boolean {
  return orgRole === "viewer";
}

export function canMutateWorkspace(orgRole: string | undefined): boolean {
  return orgRole === "admin" || orgRole === "member";
}

export function canCompleteWorkspaceSetup(
  isPlatformAdmin: boolean,
  orgRole: string | undefined
): boolean {
  return isPlatformAdmin || orgRole === "admin";
}

import type { UserOrgSummary } from "@atlas/core/contract";

export function isWorkspaceAdmin(input: {
  activeOrg: UserOrgSummary | null;
  isPlatformAdmin?: boolean;
}): boolean {
  return input.isPlatformAdmin === true || input.activeOrg?.role === "admin";
}

export function canMutateWorkspace(input: {
  activeOrg: UserOrgSummary | null;
  isPlatformAdmin?: boolean;
}): boolean {
  const role = input.activeOrg?.role;
  return role === "admin" || role === "member";
}

export function canAccessFilesPage(input: {
  activeOrg: UserOrgSummary | null;
  isPlatformAdmin?: boolean;
}): boolean {
  return isWorkspaceAdmin(input);
}

export function canAccessProfilesPage(input: {
  activeOrg: UserOrgSummary | null;
  isPlatformAdmin?: boolean;
}): boolean {
  return isWorkspaceAdmin(input);
}

export function canAccessSystemPage(input: {
  activeOrg: UserOrgSummary | null;
  isPlatformAdmin?: boolean;
}): boolean {
  return isWorkspaceAdmin(input);
}

export function canAccessIntegrationsPage(input: {
  activeOrg: UserOrgSummary | null;
}): boolean {
  const role = input.activeOrg?.role;
  return role === "admin" || role === "member";
}

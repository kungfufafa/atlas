import { AtlasApiError } from "@atlas/core/api-error";
import type {
  AuthUserResponse,
  ListUserOrgsResponse,
  UserOrgSummary,
} from "@atlas/core/contract";

export class OrganizationArchiveOutcomeUnknownError extends Error {
  constructor() {
    super(
      "Atlas could not confirm whether the organization was archived. Refresh before trying again."
    );
    this.name = "OrganizationArchiveOutcomeUnknownError";
  }
}

export function canArchiveOrganization(isPlatformAdmin: boolean): boolean {
  return isPlatformAdmin;
}

export function nextOrgIdAfterArchive(
  orgs: Array<{ id: string }>,
  archivedOrgId: string
): string | null {
  return orgs.find((org) => org.id !== archivedOrgId)?.id ?? null;
}

export async function finalizeOrganizationArchive(options: {
  archivedOrgId: string;
  currentOrgs: UserOrgSummary[];
  currentUser: AuthUserResponse | null;
  listUserOrgs: () => Promise<ListUserOrgsResponse>;
  setActiveOrg: (orgId: string) => Promise<AuthUserResponse>;
  setClientOrgId: (orgId: string | null) => void;
  updateOrgs: (orgs: UserOrgSummary[]) => void;
  updateUser: (user: AuthUserResponse | null) => void;
}): Promise<void> {
  const applyLocalState = (orgs: UserOrgSummary[]): string | null => {
    const activeOrgs = orgs.filter(
      (organization) => organization.id !== options.archivedOrgId
    );
    const nextOrgId = nextOrgIdAfterArchive(activeOrgs, options.archivedOrgId);
    options.updateOrgs(activeOrgs);
    options.setClientOrgId(nextOrgId);
    options.updateUser(
      options.currentUser
        ? {
            ...options.currentUser,
            activeOrgId: nextOrgId,
            orgId: nextOrgId,
          }
        : null
    );
    return nextOrgId;
  };

  // The archive request has committed before this function runs. Apply a usable
  // local fallback before any refresh that can fail or stall.
  applyLocalState(options.currentOrgs);

  let refreshedOrgs: UserOrgSummary[];
  try {
    refreshedOrgs = (await options.listUserOrgs()).orgs;
  } catch {
    return;
  }

  const nextOrgId = applyLocalState(refreshedOrgs);
  if (!nextOrgId) {
    return;
  }

  try {
    options.updateUser(await options.setActiveOrg(nextOrgId));
  } catch {
    // Keep the local fallback. A later session refresh can repair the cookie.
  }
}

export async function archiveOrganizationWithRecovery(
  options: Parameters<typeof finalizeOrganizationArchive>[0] & {
    archiveOrganization: () => Promise<unknown>;
  }
): Promise<void> {
  let confirmedOrgs: UserOrgSummary[] | null = null;

  try {
    await options.archiveOrganization();
  } catch (error) {
    if (error instanceof AtlasApiError) {
      if (error.status !== 404) {
        throw error;
      }
      // A retry after a lost success response is idempotent from the UI's view.
    } else {
      try {
        confirmedOrgs = (await options.listUserOrgs()).orgs;
      } catch {
        throw new OrganizationArchiveOutcomeUnknownError();
      }

      if (confirmedOrgs.some((org) => org.id === options.archivedOrgId)) {
        throw error;
      }
    }
  }

  if (confirmedOrgs) {
    await finalizeOrganizationArchive({
      ...options,
      listUserOrgs: () => Promise.resolve({ orgs: confirmedOrgs }),
    });
    return;
  }

  await finalizeOrganizationArchive(options);
}

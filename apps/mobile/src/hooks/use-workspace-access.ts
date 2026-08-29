import { useAuth } from "@/features/auth/auth-context";
import {
  canAccessFilesPage,
  canAccessIntegrationsPage,
  canAccessProfilesPage,
  canAccessSystemPage,
  canMutateWorkspace,
  isWorkspaceAdmin,
} from "@/lib/roles";

export function useWorkspaceAccess() {
  const { activeOrg, user } = useAuth();
  const isPlatformAdmin = user?.isPlatformAdmin === true;
  const access = { activeOrg, isPlatformAdmin };

  return {
    activeOrg,
    canAccessFiles: canAccessFilesPage(access),
    canAccessIntegrations: canAccessIntegrationsPage({ activeOrg }),
    canAccessProfiles: canAccessProfilesPage(access),
    canAccessSystem: canAccessSystemPage(access),
    canMutate: canMutateWorkspace(access),
    isAdmin: isWorkspaceAdmin(access),
    isPlatformAdmin,
    orgRole: activeOrg?.role,
  };
}

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import { useServer } from "@/features/server/server-context";
import { useOrgKey, useServerQueryKey } from "@/hooks/use-atlas-query";
import {
  resolveSelectedProfileId,
  type SelectableProfile,
} from "@/lib/profile-selection";
import {
  type ActiveProfileStorageScope,
  loadActiveProfileId,
  saveActiveProfileId,
} from "@/lib/profile-selection-storage";

interface ActiveProfileSelection {
  isLoading: boolean;
  selectedProfileId: string | null;
  selectProfile: (profileId: string) => void;
}

export function useActiveProfileSelection(
  profiles: readonly SelectableProfile[] | undefined
): ActiveProfileSelection {
  const { activeServer } = useServer();
  const orgId = useOrgKey();
  const queryClient = useQueryClient();
  const scope = useMemo<ActiveProfileStorageScope | null>(() => {
    if (!(activeServer && orgId !== "none")) {
      return null;
    }
    return { orgId, serverId: activeServer.id };
  }, [activeServer, orgId]);
  const selectionKey = useMemo(
    () => ["active-profile", "org", orgId] as const,
    [orgId]
  );
  const queryKey = useServerQueryKey(selectionKey);
  const storedSelection = useQuery({
    enabled: scope !== null,
    queryFn: () => (scope ? loadActiveProfileId(scope) : Promise.resolve(null)),
    queryKey,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const selectedProfileId = profiles
    ? resolveSelectedProfileId(profiles, storedSelection.data)
    : null;

  useEffect(() => {
    if (!(profiles && scope) || storedSelection.isPending) {
      return;
    }
    if (storedSelection.data === selectedProfileId) {
      return;
    }

    queryClient.setQueryData(queryKey, selectedProfileId);
    void saveActiveProfileId(scope, selectedProfileId).catch(() => {
      // Profile selection remains usable in memory when persistence is unavailable.
    });
  }, [
    profiles,
    queryClient,
    queryKey,
    scope,
    selectedProfileId,
    storedSelection.data,
    storedSelection.isPending,
  ]);

  const selectProfile = useCallback(
    (profileId: string) => {
      if (!(profiles && scope)) {
        return;
      }
      const nextProfileId = resolveSelectedProfileId(profiles, profileId);
      queryClient.setQueryData(queryKey, nextProfileId);
      void saveActiveProfileId(scope, nextProfileId).catch(() => {
        // Profile selection remains usable in memory when persistence is unavailable.
      });
    },
    [profiles, queryClient, queryKey, scope]
  );

  return {
    isLoading:
      profiles === undefined || (scope !== null && storedSelection.isPending),
    selectedProfileId,
    selectProfile,
  };
}

import type { AtlasClient } from "@atlas/client";
import {
  type QueryKey,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { useAuth } from "@/features/auth/auth-context";
import { useNetwork } from "@/features/network/network-context";
import { useServer } from "@/features/server/server-context";
import {
  createServerQueryClient,
  type ServerQueryClient,
  withServerScope,
} from "@/lib/query-scope";

export function useOrgKey(): string {
  const { user } = useAuth();
  return user?.activeOrgId ?? user?.orgId ?? "none";
}

/**
 * The auth provider updates its client in an effect after a server change.
 * Do not issue a query with the previous server's client during that render.
 */
export function useActiveAtlasClient(): AtlasClient | null {
  const { client } = useAuth();
  const { activeServer } = useServer();

  return client?.baseUrl === activeServer?.url ? client : null;
}

export function useReadyAtlasClient(): AtlasClient | null {
  const { client, isAuthenticated, isLoading } = useAuth();
  const { activeServer } = useServer();

  if (isLoading || !isAuthenticated) {
    return null;
  }

  return client?.baseUrl === activeServer?.url ? client : null;
}

export function useServerQueryKey(queryKey: QueryKey): QueryKey {
  const { activeServer } = useServer();

  return useMemo(
    () => withServerScope(queryKey, activeServer?.url),
    [activeServer?.url, queryKey]
  );
}

export function useServerQueryClient(): ServerQueryClient {
  const queryClient = useQueryClient();
  const { activeServer } = useServer();
  const serverUrl = activeServer?.url;

  return useMemo(
    () => createServerQueryClient(queryClient, serverUrl),
    [queryClient, serverUrl]
  );
}

export function useAtlasQuery<T>(
  queryKey: QueryKey,
  queryFn: (client: AtlasClient) => Promise<T>,
  options?: {
    enabled?: boolean;
    gcTime?: number;
    refetchInterval?: number;
    staleTime?: number;
  }
) {
  const client = useReadyAtlasClient();
  const orgKey = useOrgKey();
  const serverQueryKey = useServerQueryKey(queryKey);

  return useQuery({
    enabled: Boolean(client) && (options?.enabled ?? true),
    ...(options?.gcTime === undefined ? {} : { gcTime: options.gcTime }),
    queryFn: () => {
      if (!client) {
        throw new Error("Not connected.");
      }
      return queryFn(client);
    },
    queryKey: [...serverQueryKey, "org", orgKey],
    refetchInterval: options?.refetchInterval,
    staleTime: options?.staleTime,
  });
}

export function useAtlasMutation<TVariables, TData>(
  mutationFn: (client: AtlasClient, variables: TVariables) => Promise<TData>
) {
  const client = useReadyAtlasClient();
  const { isOffline } = useNetwork();
  const queryClient = useServerQueryClient();

  const mutation = useMutation({
    mutationFn: (variables: TVariables) => {
      if (isOffline) {
        throw new Error("You're offline. Reconnect before making changes.");
      }
      if (!client) {
        throw new Error("Not connected.");
      }
      return mutationFn(client, variables);
    },
  });

  return { ...mutation, client, isOffline, queryClient };
}

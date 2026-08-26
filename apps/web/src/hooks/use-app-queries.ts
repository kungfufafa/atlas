import {
  type QueryClient,
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect } from "react";
import { useAuth } from "@/context/use-auth";
import { telegramSettingsQueryOptions } from "@/hooks/use-telegram-settings";
import { thinkingSettingsQueryOptions } from "@/hooks/use-thinking-settings";
import { prefetchTimezoneData } from "@/hooks/use-timezones";
import { whatsappSettingsQueryOptions } from "@/hooks/use-whatsapp-settings";
import { client } from "@/lib/client";
import { canAccessSystemPage } from "@/lib/navigation";
import { queryKeys } from "@/lib/query-keys";

const defaultStaleTime = 1000 * 30;

export const healthQueryOptions = queryOptions({
  queryFn: () => client.health(),
  queryKey: queryKeys.health,
  staleTime: defaultStaleTime,
});

export function modelsQueryOptions(orgId: string | null) {
  return queryOptions({
    queryFn: () => client.getModels(),
    queryKey: [...queryKeys.models, orgId ?? "none"] as const,
    staleTime: defaultStaleTime,
  });
}

export function profilesQueryOptions(orgId: string | null) {
  return queryOptions({
    queryFn: async () => (await client.listProfiles()).profiles,
    queryKey: [...queryKeys.profiles.all, orgId ?? "none"] as const,
    staleTime: defaultStaleTime,
  });
}

export function toolsQueryOptions(orgId: string | null) {
  return queryOptions({
    queryFn: async () => (await client.listTools()).tools,
    queryKey: [...queryKeys.tools.all, orgId ?? "none"] as const,
    staleTime: defaultStaleTime,
  });
}

export function mcpServersQueryOptions(orgId: string | null) {
  return queryOptions({
    queryFn: async () => (await client.listMcpServers()).servers,
    queryKey: [...queryKeys.mcp.all, orgId ?? "none"] as const,
    staleTime: defaultStaleTime,
  });
}

export function skillsQueryOptions(orgId: string | null) {
  return queryOptions({
    queryFn: async () => (await client.listSkills()).skills,
    queryKey: [...queryKeys.skills.all, orgId ?? "none"] as const,
    staleTime: defaultStaleTime,
  });
}

export function automationsQueryOptions(orgId: string | null) {
  return queryOptions({
    queryFn: () => client.listAutomations(),
    queryKey: [...queryKeys.automations.all, orgId ?? "none"] as const,
    refetchInterval: 30_000,
    staleTime: defaultStaleTime,
  });
}

export function profileQueryOptions(profileId: string) {
  return queryOptions({
    enabled: Boolean(profileId),
    queryFn: async () => (await client.getProfile(profileId)).profile,
    queryKey: queryKeys.profiles.detail(profileId),
    staleTime: defaultStaleTime,
  });
}

export function prefetchAppData(
  queryClient: QueryClient,
  options?: { canAccessSystem?: boolean; orgId?: string | null }
): void {
  prefetchTimezoneData(queryClient);
  void queryClient.prefetchQuery(thinkingSettingsQueryOptions);
  void queryClient.prefetchQuery(telegramSettingsQueryOptions);
  void queryClient.prefetchQuery(whatsappSettingsQueryOptions);
  void queryClient.prefetchQuery(healthQueryOptions);
  void queryClient.prefetchQuery(modelsQueryOptions(options?.orgId ?? null));
  void queryClient.prefetchQuery(profilesQueryOptions(options?.orgId ?? null));
  void queryClient.prefetchQuery(
    automationsQueryOptions(options?.orgId ?? null)
  );
  if (options?.canAccessSystem) {
    void queryClient.prefetchQuery(toolsQueryOptions(options.orgId ?? null));
    void queryClient.prefetchQuery(skillsQueryOptions(options.orgId ?? null));
    void queryClient.prefetchQuery(
      mcpServersQueryOptions(options.orgId ?? null)
    );
  }
}

export function AppQueryPrefetch() {
  const queryClient = useQueryClient();
  const { isAuthenticated, isLoading, user, activeOrg } = useAuth();
  const canAccessSystem = canAccessSystemPage(
    user?.isPlatformAdmin === true,
    activeOrg?.role
  );

  useEffect(() => {
    if (isLoading || !isAuthenticated) {
      return;
    }

    prefetchAppData(queryClient, {
      canAccessSystem,
      orgId: activeOrg?.id ?? null,
    });
  }, [queryClient, isAuthenticated, isLoading, canAccessSystem, activeOrg?.id]);

  return null;
}

export function useHealthQuery() {
  return useQuery(healthQueryOptions);
}

export function useModelsQuery(options?: { enabled?: boolean }) {
  const { activeOrg } = useAuth();
  return useQuery({
    ...modelsQueryOptions(activeOrg?.id ?? null),
    enabled: options?.enabled ?? true,
  });
}

export function useProfilesQuery() {
  const { activeOrg } = useAuth();
  return useQuery(profilesQueryOptions(activeOrg?.id ?? null));
}

export function useProfileQuery(profileId: string | null) {
  return useQuery({
    ...profileQueryOptions(profileId ?? ""),
    enabled: Boolean(profileId),
  });
}

export function useToolsQuery() {
  const { activeOrg } = useAuth();
  return useQuery(toolsQueryOptions(activeOrg?.id ?? null));
}

export function useMcpServersQuery() {
  const { activeOrg } = useAuth();
  return useQuery(mcpServersQueryOptions(activeOrg?.id ?? null));
}

export function useSkillsQuery() {
  const { activeOrg } = useAuth();
  return useQuery(skillsQueryOptions(activeOrg?.id ?? null));
}

export function skillQueryOptions(skillId: string) {
  return queryOptions({
    enabled: Boolean(skillId),
    queryFn: async () => (await client.getSkill(skillId)).skill,
    queryKey: queryKeys.skills.detail(skillId),
    staleTime: defaultStaleTime,
  });
}

export function useSkillQuery(skillId: string | null) {
  return useQuery({
    ...skillQueryOptions(skillId ?? ""),
    enabled: Boolean(skillId),
  });
}

export function mcpServerDetailQueryOptions(serverId: string) {
  return queryOptions({
    enabled: Boolean(serverId),
    queryFn: async () => (await client.getMcpServer(serverId)).server,
    queryKey: queryKeys.mcp.detail(serverId),
    staleTime: defaultStaleTime,
  });
}

export function useMcpServerDetailQuery(serverId: string | null) {
  return useQuery({
    ...mcpServerDetailQueryOptions(serverId ?? ""),
    enabled: Boolean(serverId),
  });
}

export function toolQueryOptions(toolId: string) {
  return queryOptions({
    enabled: Boolean(toolId),
    queryFn: async () => (await client.getTool(toolId)).tool,
    queryKey: queryKeys.tools.detail(toolId),
    staleTime: defaultStaleTime,
  });
}

export function useToolQuery(toolId: string | null) {
  return useQuery({
    ...toolQueryOptions(toolId ?? ""),
    enabled: Boolean(toolId),
  });
}

export const providersQueryOptions = queryOptions({
  queryFn: () => client.listProviders(),
  queryKey: queryKeys.providers,
  staleTime: defaultStaleTime,
});

export function useProvidersQuery(options?: { enabled?: boolean }) {
  return useQuery({
    ...providersQueryOptions,
    enabled: options?.enabled ?? true,
  });
}

export async function invalidateProviderQueries(queryClient: QueryClient) {
  await queryClient.cancelQueries({ queryKey: ["remoteModelDiscovery"] });
  queryClient.removeQueries({ queryKey: ["remoteModelDiscovery"] });
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.health }),
    queryClient.invalidateQueries({ queryKey: queryKeys.models }),
    queryClient.invalidateQueries({ queryKey: queryKeys.providers }),
  ]);
}

export function useCreateProviderMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: Parameters<typeof client.createProvider>[0]) =>
      client.createProvider(request),
    onSuccess: async () => {
      await invalidateProviderQueries(queryClient);
    },
  });
}

export function useUpdateProviderMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      providerId,
      request,
    }: {
      providerId: string;
      request: Parameters<typeof client.updateProvider>[1];
    }) => client.updateProvider(providerId, request),
    onSuccess: async () => {
      await invalidateProviderQueries(queryClient);
    },
  });
}

export function useDeleteProviderMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (providerId: string) => client.deleteProvider(providerId),
    onSuccess: async () => {
      await invalidateProviderQueries(queryClient);
    },
  });
}

export function useConfigureProviderMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: Parameters<typeof client.configureProvider>[0]) =>
      client.configureProvider(request),
    onSuccess: async () => {
      await invalidateProviderQueries(queryClient);
    },
  });
}

export function usePrefetchAppData() {
  const queryClient = useQueryClient();
  const { user, activeOrg } = useAuth();
  const canAccessSystem = canAccessSystemPage(
    user?.isPlatformAdmin === true,
    activeOrg?.role
  );

  return useCallback(() => {
    prefetchAppData(queryClient, {
      canAccessSystem,
      orgId: activeOrg?.id ?? null,
    });
  }, [queryClient, canAccessSystem, activeOrg?.id]);
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/context/use-auth";
import { client } from "@/lib/client";
import { queryKeys } from "@/lib/query-keys";

const STALE_TIME_MS = 30_000;

const capabilityRoutingKeys = {
  catalog: (orgId: string | null) =>
    ["capabilityRouting", orgId ?? "none", "catalog"] as const,
  mappings: (orgId: string | null) =>
    ["capabilityRouting", orgId ?? "none", "mappings"] as const,
  options: (orgId: string | null) =>
    ["capabilityRouting", orgId ?? "none", "options"] as const,
};

export function useCapabilityCatalog() {
  const { activeOrg } = useAuth();
  return useQuery({
    queryFn: () => client.getCapabilityCatalog(),
    queryKey: capabilityRoutingKeys.catalog(activeOrg?.id ?? null),
    staleTime: STALE_TIME_MS,
  });
}

export function useCapabilityMappings() {
  const { activeOrg } = useAuth();
  return useQuery({
    queryFn: () => client.getCapabilityMappings(),
    queryKey: capabilityRoutingKeys.mappings(activeOrg?.id ?? null),
    staleTime: STALE_TIME_MS,
  });
}

export function useCapabilityOptions() {
  const { activeOrg } = useAuth();
  return useQuery({
    queryFn: () => client.getCapabilityOptions(),
    queryKey: capabilityRoutingKeys.options(activeOrg?.id ?? null),
    staleTime: STALE_TIME_MS,
  });
}

export function useSaveCapabilityMapping() {
  const { activeOrg } = useAuth();
  const queryClient = useQueryClient();
  const orgId = activeOrg?.id ?? null;

  return useMutation({
    mutationFn: ({
      binding,
      capabilityId,
    }: {
      binding: Parameters<typeof client.setCapabilityMapping>[1]["binding"];
      capabilityId: string;
    }) => client.setCapabilityMapping(capabilityId, { binding }),
    onSuccess: async (response) => {
      queryClient.setQueryData(capabilityRoutingKeys.mappings(orgId), {
        config: response.config,
      });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: capabilityRoutingKeys.options(orgId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.imageGenerationSettings,
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.transcriptionSettings,
        }),
        queryClient.invalidateQueries({ queryKey: queryKeys.visionSettings }),
      ]);
    },
  });
}

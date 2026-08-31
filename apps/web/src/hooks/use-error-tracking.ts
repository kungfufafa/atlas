import type { UpdateErrorTrackingSettingsRequest } from "@atlas/core/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";
import { queryKeys } from "@/lib/query-keys";

export function useErrorTrackingSettings() {
  return useQuery({
    queryFn: () => client.getErrorTrackingSettings(),
    queryKey: queryKeys.errorTracking.settings,
  });
}

export function useSaveErrorTrackingSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: UpdateErrorTrackingSettingsRequest) =>
      client.setErrorTrackingSettings(request),
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.errorTracking.settings, saved);
    },
  });
}

export function useSendErrorTrackingTest() {
  return useMutation({ mutationFn: () => client.sendErrorTrackingTest() });
}

import type { UpdateWhatsAppSettingsRequest } from "@atlas/core/contract";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { client } from "@/lib/client";
import { queryKeys } from "@/lib/query-keys";

export const whatsappSettingsQueryOptions = queryOptions({
  queryFn: () => client.getWhatsAppSettings(),
  queryKey: queryKeys.whatsapp.settings,
});

export function useWhatsAppSettings() {
  return useQuery(whatsappSettingsQueryOptions);
}

export function useSaveWhatsAppSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: UpdateWhatsAppSettingsRequest) =>
      client.setWhatsAppSettings(request),
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.whatsapp.settings, saved);
      void queryClient.invalidateQueries({ queryKey: queryKeys.systemStatus });
    },
  });
}

export function useRegenerateWhatsAppPairingCode() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => client.regenerateWhatsAppPairingCode(),
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.whatsapp.settings, saved);
      void queryClient.invalidateQueries({ queryKey: queryKeys.systemStatus });
    },
  });
}

export function useReconnectWhatsApp() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => client.reconnectWhatsApp(),
    onSuccess: (saved) => {
      queryClient.setQueryData(queryKeys.whatsapp.settings, saved);
      void queryClient.invalidateQueries({ queryKey: queryKeys.systemStatus });
    },
  });
}

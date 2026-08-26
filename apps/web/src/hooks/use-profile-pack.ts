import { useMutation, useQueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";

export function useExportProfilePack() {
  return useMutation({
    mutationFn: (profileId: string) => client.exportProfilePack(profileId),
  });
}

export function usePreviewProfilePack() {
  return useMutation({
    mutationFn: (file: File) => client.previewProfilePackImport(file),
  });
}

export function useImportProfilePack() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ file, name }: { file: File; name: string }) =>
      client.importProfilePack(file, { confirm: true, name }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
    },
  });
}

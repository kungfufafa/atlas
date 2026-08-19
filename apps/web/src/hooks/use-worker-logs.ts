import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/context/use-auth";
import { client } from "@/lib/client";
import { queryKeys } from "@/lib/query-keys";

export function useWorkerLogs(workerName: string, lines = 500) {
  const { activeOrg } = useAuth();
  const orgId = activeOrg?.id ?? "none";

  return useQuery({
    enabled: false,
    queryFn: () => client.getWorkerLogs(workerName, lines),
    queryKey: [...queryKeys.workerLogs, orgId, workerName, lines],
  });
}

export function useClearWorkerLogs(workerName: string) {
  const queryClient = useQueryClient();
  const { activeOrg } = useAuth();
  const orgId = activeOrg?.id ?? "none";

  return useMutation({
    mutationFn: () => client.clearWorkerLogs(workerName),
    onSuccess: () => {
      queryClient.setQueriesData(
        { queryKey: [...queryKeys.workerLogs, orgId, workerName] },
        {
          stderr: "",
          stdout: "",
        }
      );
      void queryClient.invalidateQueries({
        queryKey: [...queryKeys.workerLogs, orgId, workerName],
      });
    },
  });
}

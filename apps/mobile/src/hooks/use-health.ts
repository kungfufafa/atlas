import { useQuery } from "@tanstack/react-query";
import {
  useActiveAtlasClient,
  useServerQueryKey,
} from "@/hooks/use-atlas-query";
import { queryKeys } from "@/lib/query-keys";
import { isCompatibleAtlasHealthResponse } from "@/lib/server-health";

export function useHealthQuery() {
  const client = useActiveAtlasClient();
  const queryKey = useServerQueryKey(queryKeys.health);

  return useQuery({
    enabled: Boolean(client),
    queryFn: async () => {
      if (!client) {
        throw new Error("Not connected.");
      }
      const health = await client.health();
      if (!isCompatibleAtlasHealthResponse(health)) {
        throw new Error(
          "This Atlas server is not compatible with this app version."
        );
      }
      return health;
    },
    queryKey,
  });
}

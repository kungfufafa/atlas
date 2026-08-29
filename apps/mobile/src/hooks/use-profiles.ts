import { useAtlasQuery } from "@/hooks/use-atlas-query";
import { queryKeys } from "@/lib/query-keys";

export function useProfilesQuery() {
  return useAtlasQuery(
    queryKeys.profiles,
    async (client) => (await client.listProfiles()).profiles
  );
}

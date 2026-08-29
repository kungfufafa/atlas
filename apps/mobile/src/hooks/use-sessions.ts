import { useAtlasQuery } from "@/hooks/use-atlas-query";
import { queryKeys } from "@/lib/query-keys";

export function useSessionsQuery(profileId: string | undefined) {
  return useAtlasQuery(
    queryKeys.sessions(profileId ?? "none"),
    async (client) =>
      (await client.listSessions(profileId ?? "", "web")).sessions,
    { enabled: Boolean(profileId) }
  );
}

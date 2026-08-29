import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef } from "react";
import { useServer } from "@/features/server/server-context";
import { hasServerScope } from "@/lib/query-scope";

/**
 * Query keys are server-scoped. Removing only the previous server's entries
 * avoids stale data while allowing the newly selected server to start loading
 * immediately.
 */
export function ServerQueryCacheBoundary({
  children,
}: {
  children: ReactNode;
}) {
  const queryClient = useQueryClient();
  const { activeServer, isReady } = useServer();
  const previousServerUrl = useRef<string | null | undefined>(undefined);
  const serverUrl = activeServer?.url ?? null;

  useEffect(() => {
    if (!isReady) {
      return;
    }

    if (
      previousServerUrl.current !== undefined &&
      previousServerUrl.current !== serverUrl
    ) {
      const previousUrl = previousServerUrl.current;
      const filters = {
        predicate: (query: { queryKey: readonly unknown[] }) =>
          hasServerScope(query.queryKey, previousUrl),
      };
      void queryClient
        .cancelQueries(filters)
        .then(() => queryClient.removeQueries(filters));
    }

    previousServerUrl.current = serverUrl;
  }, [isReady, queryClient, serverUrl]);

  return children;
}

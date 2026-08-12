import { AtlasApiError } from "@atlas/core/api-error";
import { type QueryCacheNotifyEvent, QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

export function onGlobalQueryError(event: QueryCacheNotifyEvent) {
  const error = event.query?.state?.error;
  if (error instanceof AtlasApiError && error.status === 401) {
    window.location.href = "/login";
  }
}

import type {
  InvalidateOptions,
  InvalidateQueryFilters,
  QueryClient,
  QueryKey,
} from "@tanstack/react-query";

export const SERVER_QUERY_SCOPE = "__atlas_server_scope__";

const UNCONNECTED_SERVER_SCOPE = "none";

type InvalidateQueries = QueryClient["invalidateQueries"];
type RemoveQueries = QueryClient["removeQueries"];

export interface ServerQueryClient {
  getQueryData: <T>(queryKey: QueryKey) => T | undefined;
  invalidateQueries: (
    ...args: Parameters<InvalidateQueries>
  ) => ReturnType<InvalidateQueries>;
  removeQueries: (
    ...args: Parameters<RemoveQueries>
  ) => ReturnType<RemoveQueries>;
  setQueryData: <T>(queryKey: QueryKey, data: T) => void;
}

export function getServerScopeKey(
  serverKey: string | null | undefined
): string {
  return serverKey ?? UNCONNECTED_SERVER_SCOPE;
}

/**
 * Adds the active Atlas server to the end of a resource key. Keeping the
 * resource prefix first means a scoped invalidation can still target every
 * variant of that resource (for example, every org's `profiles` query).
 */
export function withServerScope(
  queryKey: QueryKey,
  serverKey: string | null | undefined
): QueryKey {
  return [...queryKey, SERVER_QUERY_SCOPE, getServerScopeKey(serverKey)];
}

export function hasServerScope(
  queryKey: QueryKey,
  serverKey: string | null | undefined
): boolean {
  const scopeIndex = queryKey.lastIndexOf(SERVER_QUERY_SCOPE);
  return (
    scopeIndex >= 0 && queryKey[scopeIndex + 1] === getServerScopeKey(serverKey)
  );
}

function scopeInvalidateFilters(
  filters: InvalidateQueryFilters | undefined,
  serverKey: string | null | undefined
): InvalidateQueryFilters {
  if (filters?.queryKey) {
    return {
      ...filters,
      queryKey: withServerScope(filters.queryKey, serverKey),
    };
  }

  const matchesFilter = filters?.predicate;
  return {
    ...filters,
    predicate: (query) =>
      hasServerScope(query.queryKey, serverKey) &&
      (matchesFilter?.(query) ?? true),
  };
}

export function createServerQueryClient(
  queryClient: QueryClient,
  serverKey: string | null | undefined
): ServerQueryClient {
  return {
    getQueryData: <T>(queryKey: QueryKey) =>
      queryClient.getQueryData<T>(withServerScope(queryKey, serverKey)),
    invalidateQueries: (
      filters?: InvalidateQueryFilters,
      options?: InvalidateOptions
    ) =>
      queryClient.invalidateQueries(
        scopeInvalidateFilters(filters, serverKey),
        options
      ),
    removeQueries: (filters) =>
      queryClient.removeQueries(scopeInvalidateFilters(filters, serverKey)),
    setQueryData: <T>(queryKey: QueryKey, data: T) => {
      queryClient.setQueryData(withServerScope(queryKey, serverKey), data);
    },
  };
}

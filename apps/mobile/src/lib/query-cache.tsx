import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  type DehydratedState,
  dehydrate,
  hydrate,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { SERVER_QUERY_SCOPE } from "./query-scope";

const OFFLINE_QUERY_CACHE_KEY = "atlas.offline-query-cache.v1";
const OFFLINE_QUERY_CACHE_VERSION = 1;
const OFFLINE_QUERY_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const OFFLINE_QUERY_PREFIXES = new Set([
  "artifacts",
  "artifacts-all",
  "automation",
  "automation-runs",
  "automations",
  "knowledge",
  "knowledge-all",
  "profile",
  "profiles",
  "session-messages",
  "sessions",
  "sessions-all",
  "task",
  "task-runs",
  "tasks",
]);

interface PersistedQueryCache {
  savedAt: number;
  state: DehydratedState;
  version: number;
}

function isPersistedQueryCache(value: unknown): value is PersistedQueryCache {
  if (!(value && typeof value === "object")) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    record.version === OFFLINE_QUERY_CACHE_VERSION &&
    typeof record.savedAt === "number" &&
    record.state !== null &&
    typeof record.state === "object"
  );
}

export function shouldPersistOfflineQuery(queryKey: QueryKey): boolean {
  const prefix = queryKey[0];
  return (
    typeof prefix === "string" &&
    OFFLINE_QUERY_PREFIXES.has(prefix) &&
    queryKey.includes(SERVER_QUERY_SCOPE)
  );
}

export function parsePersistedQueryCache(
  raw: string | null,
  now = Date.now()
): PersistedQueryCache | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      !isPersistedQueryCache(parsed) ||
      parsed.savedAt > now ||
      now - parsed.savedAt > OFFLINE_QUERY_CACHE_MAX_AGE_MS
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function restoreOfflineQueryCache(
  client: QueryClient
): Promise<void> {
  const raw = await AsyncStorage.getItem(OFFLINE_QUERY_CACHE_KEY);
  const cached = parsePersistedQueryCache(raw);

  if (cached) {
    hydrate(client, cached.state);
    return;
  }

  if (raw) {
    await AsyncStorage.removeItem(OFFLINE_QUERY_CACHE_KEY);
  }
}

export async function persistOfflineQueryCache(
  client: QueryClient
): Promise<void> {
  const state = dehydrate(client, {
    shouldDehydrateQuery: (query) =>
      query.state.status === "success" &&
      shouldPersistOfflineQuery(query.queryKey),
  });

  if (state.queries.length === 0) {
    await AsyncStorage.removeItem(OFFLINE_QUERY_CACHE_KEY);
    return;
  }

  const next: PersistedQueryCache = {
    savedAt: Date.now(),
    state,
    version: OFFLINE_QUERY_CACHE_VERSION,
  };
  await AsyncStorage.setItem(OFFLINE_QUERY_CACHE_KEY, JSON.stringify(next));
}

export async function clearOfflineQueryCache(): Promise<void> {
  await AsyncStorage.removeItem(OFFLINE_QUERY_CACHE_KEY);
}

export function startOfflineQueryCachePersistence(
  client: QueryClient
): () => void {
  let pendingWrite: ReturnType<typeof setTimeout> | null = null;

  const persist = () => {
    pendingWrite = null;
    void persistOfflineQueryCache(client).catch(() => {
      // Retain the current cache in memory when local storage is unavailable.
    });
  };

  const schedulePersist = () => {
    if (pendingWrite !== null) {
      return;
    }
    pendingWrite = setTimeout(persist, 500);
  };

  const unsubscribe = client.getQueryCache().subscribe(schedulePersist);
  return () => {
    unsubscribe();
    if (pendingWrite !== null) {
      clearTimeout(pendingWrite);
    }
  };
}

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { clearCachedAuthSession } from "@/lib/auth-cache";
import { persistOfflineQueryCache } from "@/lib/query-cache";
import { queryClient } from "@/lib/query-client";
import { hasServerScope } from "@/lib/query-scope";
import {
  clearSessionToken,
  clearSessionTokens,
  migrateSessionTokens,
} from "@/lib/secure-store";
import {
  migrateSavedServers,
  removeServerFromState,
  sanitizeSavedServerState,
} from "@/lib/server-records";
import {
  assertPersistableServerUrl,
  displayNameFromUrl,
  serverIdFromUrl,
} from "@/lib/server-url";
import {
  createSerializedServerStateStore,
  loadServerState,
  type SavedServer,
  type SavedServerState,
  type ServerStateMutation,
  saveServerState,
} from "@/lib/storage";

export interface AddServerOptions {
  allowInsecure?: boolean;
  name?: string;
}

export interface ServerContextValue {
  activeServer: SavedServer | null;
  addServer: (url: string, options?: AddServerOptions) => Promise<SavedServer>;
  /**
   * Returns whether an async operation still belongs to the committed active
   * server. It updates before the React rerender that follows a successful
   * server-state write.
   */
  isCurrentServer: (id: string | null) => boolean;
  isReady: boolean;
  removeServer: (id: string) => Promise<void>;
  servers: SavedServer[];
  setActiveServer: (id: string) => Promise<void>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

const EMPTY_SERVER_STATE: SavedServerState = {
  activeServerId: null,
  pendingSessionTokenCleanupIds: [],
  servers: [],
};

const ServerContext = createContext<ServerContextValue | null>(null);

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function getPendingTokenCleanupIds({
  currentIds,
  migrationCleanupIds,
  migrationSourceIds,
}: {
  currentIds: string[];
  migrationCleanupIds: string[];
  migrationSourceIds: string[];
}): string[] {
  const currentServerIds = new Set(currentIds);
  return [...new Set([...migrationCleanupIds, ...migrationSourceIds])].filter(
    (id) => !currentServerIds.has(id)
  );
}

export function ServerProvider({ children }: { children: ReactNode }) {
  const [serverState, setServerState] =
    useState<SavedServerState>(EMPTY_SERVER_STATE);
  const [isReady, setIsReady] = useState(false);
  const activeServerIdRef = useRef<string | null>(null);
  const isMountedRef = useRef(true);
  const hydrationAttemptRef = useRef(0);
  const hydrationGateRef = useRef<Deferred<void> | null>(null);
  const serverStateStoreRef = useRef<ReturnType<
    typeof createSerializedServerStateStore
  > | null>(null);

  if (!hydrationGateRef.current) {
    hydrationGateRef.current = createDeferred<void>();
  }
  if (!serverStateStoreRef.current) {
    serverStateStoreRef.current = createSerializedServerStateStore({
      initialState: EMPTY_SERVER_STATE,
      onCommit: (nextState) => {
        activeServerIdRef.current = nextState.activeServerId;
        if (isMountedRef.current) {
          setServerState(nextState);
        }
      },
      persist: saveServerState,
    });
  }

  const serverStateStore = serverStateStoreRef.current;
  const hydrationGate = hydrationGateRef.current;

  useEffect(() => {
    let cancelled = false;
    isMountedRef.current = true;
    const attempt = ++hydrationAttemptRef.current;

    async function hydrate(): Promise<void> {
      try {
        const loaded = await loadServerState();
        const migration = migrateSavedServers(
          loaded.state.servers,
          loaded.state.activeServerId
        );
        const migratedState: SavedServerState = {
          activeServerId: migration.activeServerId,
          pendingSessionTokenCleanupIds: getPendingTokenCleanupIds({
            currentIds: migration.servers.map((server) => server.id),
            migrationCleanupIds: [
              ...loaded.state.pendingSessionTokenCleanupIds,
              ...migration.clearSessionTokenIds,
            ],
            migrationSourceIds: migration.sessionTokenMigrations.map(
              ({ fromServerId }) => fromServerId
            ),
          }),
          servers: migration.servers,
        };
        const needsStateWrite =
          loaded.needsMigration ||
          migration.hasChanges ||
          !areSameCleanupIds(
            loaded.state.pendingSessionTokenCleanupIds,
            migratedState.pendingSessionTokenCleanupIds
          );

        // Copy first and leave legacy entries in place until the new server
        // metadata is durable. A keychain failure therefore cannot strand a
        // user's only session token under a legacy ID.
        await migrateSessionTokens(migration.sessionTokenMigrations, {
          clearSource: false,
        });
        if (needsStateWrite) {
          await saveServerState(migratedState);
        }
        if (cancelled) {
          return;
        }
        serverStateStore.replace(migratedState);

        if (migratedState.pendingSessionTokenCleanupIds.length === 0) {
          return;
        }

        try {
          await clearSessionTokens(migratedState.pendingSessionTokenCleanupIds);
          const cleanedState: SavedServerState = {
            ...migratedState,
            pendingSessionTokenCleanupIds: [],
          };
          await saveServerState(cleanedState);
          if (!cancelled) {
            serverStateStore.replace(cleanedState);
          }
        } catch {
          // The canonical metadata and destination tokens are already durable.
          // Keep cleanup IDs so the next launch can safely retry this work.
        }
      } catch {
        if (!cancelled) {
          // Migration only reaches this path before legacy source tokens are
          // removed, so preserving the prior snapshot keeps the session
          // retryable on the next launch.
          const loaded = await loadServerState().catch(() => null);
          serverStateStore.replace(
            loaded ? sanitizeSavedServerState(loaded.state) : EMPTY_SERVER_STATE
          );
        }
      } finally {
        if (attempt === hydrationAttemptRef.current) {
          hydrationGate.resolve();
          if (!cancelled) {
            setIsReady(true);
          }
        }
      }
    }

    void hydrate();
    return () => {
      cancelled = true;
      isMountedRef.current = false;
    };
  }, [hydrationGate, serverStateStore]);

  const enqueueServerMutation = useCallback(
    async <TResult,>(
      mutation: (
        current: SavedServerState
      ) => ServerStateMutation<TResult> | Promise<ServerStateMutation<TResult>>
    ): Promise<TResult> => {
      await hydrationGate.promise;
      return serverStateStore.mutate(mutation);
    },
    [hydrationGate, serverStateStore]
  );

  const addServer = useCallback(
    async (url: string, options?: AddServerOptions): Promise<SavedServer> => {
      const normalized = assertPersistableServerUrl(url, {
        allowInsecure: options?.allowInsecure,
      });
      const id = serverIdFromUrl(normalized);
      return enqueueServerMutation((current) => {
        const existing = current.servers.find(
          (server) => server.id === id || server.url === normalized
        );
        if (existing) {
          return {
            result: existing,
            state:
              current.activeServerId === existing.id
                ? current
                : { ...current, activeServerId: existing.id },
          };
        }

        const server: SavedServer = {
          id,
          name: options?.name?.trim() || displayNameFromUrl(normalized),
          url: normalized,
        };
        return {
          result: server,
          state: {
            ...current,
            activeServerId: server.id,
            servers: [...current.servers, server],
          },
        };
      });
    },
    [enqueueServerMutation]
  );

  const removeServer = useCallback(
    async (id: string): Promise<void> => {
      const removedServerUrl = await enqueueServerMutation(async (current) => {
        const server = current.servers.find((item) => item.id === id);
        if (!server) {
          return { result: null, state: current };
        }

        // Do not commit a removal until the associated credential is gone.
        // If either operation fails, the original state remains visible and a
        // later remove attempt can safely retry it.
        await clearSessionToken(id);
        return {
          result: server.url,
          state: removeServerFromState(current, id),
        };
      });
      if (!removedServerUrl) {
        return;
      }

      const filters = {
        predicate: (query: { queryKey: readonly unknown[] }) =>
          hasServerScope(query.queryKey, removedServerUrl),
      };
      await queryClient.cancelQueries(filters);
      queryClient.removeQueries(filters);
      void persistOfflineQueryCache(queryClient).catch(() => {
        // The removed server's in-memory data is already unavailable.
      });
      void clearCachedAuthSession(id);
    },
    [enqueueServerMutation]
  );

  const setActiveServer = useCallback(
    async (id: string): Promise<void> => {
      await enqueueServerMutation((current) => {
        if (
          current.activeServerId === id ||
          !current.servers.some((server) => server.id === id)
        ) {
          return { result: undefined, state: current };
        }
        return {
          result: undefined,
          state: { ...current, activeServerId: id },
        };
      });
    },
    [enqueueServerMutation]
  );

  const isCurrentServer = useCallback(
    (id: string | null): boolean => activeServerIdRef.current === id,
    []
  );

  const activeServer = useMemo(
    () =>
      serverState.servers.find(
        (server) => server.id === serverState.activeServerId
      ) ?? null,
    [serverState]
  );

  const value = useMemo(
    () => ({
      activeServer,
      addServer,
      isCurrentServer,
      isReady,
      removeServer,
      servers: serverState.servers,
      setActiveServer,
    }),
    [
      activeServer,
      addServer,
      isCurrentServer,
      isReady,
      removeServer,
      serverState.servers,
      setActiveServer,
    ]
  );

  return (
    <ServerContext.Provider value={value}>{children}</ServerContext.Provider>
  );
}

export function useServer(): ServerContextValue {
  const value = useContext(ServerContext);
  if (!value) {
    throw new Error("useServer must be used within ServerProvider");
  }
  return value;
}

function areSameCleanupIds(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((cleanupId, index) => cleanupId === right[index])
  );
}

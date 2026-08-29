import AsyncStorage from "@react-native-async-storage/async-storage";
import type { SavedServer } from "./server-records";

export type { SavedServer } from "./server-records";

const SERVER_STATE_KEY = "atlas.server-state.v1";
const SERVERS_KEY = "atlas.servers";
const ACTIVE_SERVER_KEY = "atlas.active-server";
const THEME_KEY = "atlas.theme";

export type ThemePreference = "light" | "dark" | "system";

/**
 * Server metadata is stored as one document so an active-server selection
 * cannot be persisted independently of the list it belongs to.
 */
export interface SavedServerState {
  activeServerId: string | null;
  /**
   * Secure-store keys which are no longer reachable from the server list.
   * Keeping these IDs durable lets us retry cleanup after a keychain outage.
   */
  pendingSessionTokenCleanupIds: string[];
  servers: SavedServer[];
}

export interface LoadedServerState {
  needsMigration: boolean;
  state: SavedServerState;
}

export interface ServerStateMutation<TResult> {
  result: TResult;
  state: SavedServerState;
}

export interface SerializedServerStateStore {
  getState: () => SavedServerState;
  mutate: <TResult>(
    mutation: (
      current: SavedServerState
    ) => ServerStateMutation<TResult> | Promise<ServerStateMutation<TResult>>
  ) => Promise<TResult>;
  replace: (nextState: SavedServerState) => void;
}

interface CreateSerializedServerStateStoreOptions {
  initialState: SavedServerState;
  onCommit?: (state: SavedServerState) => void;
  persist: (state: SavedServerState) => Promise<void>;
}

/**
 * Serializes state changes and only exposes a new snapshot after its durable
 * write succeeds. The queue recovers after a failed write so callers can retry.
 */
export function createSerializedServerStateStore({
  initialState,
  onCommit,
  persist,
}: CreateSerializedServerStateStoreOptions): SerializedServerStateStore {
  let state = initialState;
  let tail: Promise<void> = Promise.resolve();

  const commit = (nextState: SavedServerState): void => {
    state = nextState;
    onCommit?.(nextState);
  };

  return {
    getState: () => state,
    mutate: <TResult>(
      mutation: (
        current: SavedServerState
      ) => ServerStateMutation<TResult> | Promise<ServerStateMutation<TResult>>
    ): Promise<TResult> => {
      const operation = tail.then(async () => {
        const update = await mutation(state);
        if (update.state !== state) {
          await persist(update.state);
          commit(update.state);
        }
        return update.result;
      });

      // A failed operation must not prevent the next user action from running.
      tail = operation.then(
        () => undefined,
        () => undefined
      );
      return operation;
    },
    replace: (nextState: SavedServerState): void => {
      commit(nextState);
    },
  };
}

export async function loadServerState(): Promise<LoadedServerState> {
  const raw = await AsyncStorage.getItem(SERVER_STATE_KEY);
  const state = parseSavedServerState(raw);
  if (state) {
    return { needsMigration: false, state };
  }

  const [servers, activeServerId] = await Promise.all([
    loadServers(),
    loadActiveServerId(),
  ]);
  return {
    needsMigration: true,
    state: {
      activeServerId,
      pendingSessionTokenCleanupIds: [],
      servers,
    },
  };
}

export async function saveServerState(state: SavedServerState): Promise<void> {
  await AsyncStorage.setItem(
    SERVER_STATE_KEY,
    JSON.stringify({
      activeServerId: state.activeServerId,
      pendingSessionTokenCleanupIds: state.pendingSessionTokenCleanupIds,
      servers: state.servers,
    })
  );
}

export async function loadServers(): Promise<SavedServer[]> {
  const raw = await AsyncStorage.getItem(SERVERS_KEY);
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isSavedServer);
  } catch {
    return [];
  }
}

export async function saveServers(servers: SavedServer[]): Promise<void> {
  await AsyncStorage.setItem(SERVERS_KEY, JSON.stringify(servers));
}

export async function loadActiveServerId(): Promise<string | null> {
  return AsyncStorage.getItem(ACTIVE_SERVER_KEY);
}

export async function saveActiveServerId(id: string | null): Promise<void> {
  if (!id) {
    await AsyncStorage.removeItem(ACTIVE_SERVER_KEY);
    return;
  }
  await AsyncStorage.setItem(ACTIVE_SERVER_KEY, id);
}

export async function loadThemePreference(): Promise<ThemePreference> {
  const value = await AsyncStorage.getItem(THEME_KEY);
  if (value === "light" || value === "dark" || value === "system") {
    return value;
  }
  return "system";
}

export async function saveThemePreference(
  theme: ThemePreference
): Promise<void> {
  await AsyncStorage.setItem(THEME_KEY, theme);
}

function parseSavedServerState(raw: string | null): SavedServerState | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }

    const record = parsed as Record<string, unknown>;
    if (
      !(
        Array.isArray(record.servers) &&
        (typeof record.activeServerId === "string" ||
          record.activeServerId === null)
      )
    ) {
      return null;
    }

    return {
      activeServerId: record.activeServerId,
      pendingSessionTokenCleanupIds: parseCleanupIds(
        record.pendingSessionTokenCleanupIds
      ),
      servers: record.servers.filter(isSavedServer),
    };
  } catch {
    return null;
  }
}

function parseCleanupIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(value.filter((id): id is string => typeof id === "string")),
  ];
}

function isSavedServer(value: unknown): value is SavedServer {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    typeof record.url === "string"
  );
}

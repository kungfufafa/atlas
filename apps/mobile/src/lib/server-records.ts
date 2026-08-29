import {
  displayNameFromUrl,
  isValidServerUrl,
  normalizeServerUrl,
  serverIdFromUrl,
} from "./server-url";
import type { SavedServerState } from "./storage";

export interface SavedServer {
  id: string;
  name: string;
  url: string;
}

export interface SessionTokenMigration {
  fromServerId: string;
  toServerId: string;
}

export interface SavedServersMigration {
  activeServerId: string | null;
  clearSessionTokenIds: string[];
  hasChanges: boolean;
  servers: SavedServer[];
  sessionTokenMigrations: SessionTokenMigration[];
}

/**
 * Produces a safe in-memory server snapshot when persistence or keychain
 * migration fails. It intentionally leaves legacy token cleanup for a later
 * successful migration: clearing a source token here could strand a session
 * whose destination copy was not made durable.
 */
export function sanitizeSavedServerState(
  state: SavedServerState
): SavedServerState {
  const migration = migrateSavedServers(state.servers, state.activeServerId);
  const currentServerIds = new Set(
    migration.servers.map((server) => server.id)
  );

  return {
    activeServerId: migration.activeServerId,
    pendingSessionTokenCleanupIds: state.pendingSessionTokenCleanupIds.filter(
      (id) => !currentServerIds.has(id)
    ),
    servers: migration.servers,
  };
}

export function removeServerFromState(
  state: SavedServerState,
  id: string
): SavedServerState {
  if (!state.servers.some((server) => server.id === id)) {
    return state;
  }

  const servers = state.servers.filter((server) => server.id !== id);
  return {
    ...state,
    activeServerId:
      state.activeServerId === id
        ? (servers[0]?.id ?? null)
        : state.activeServerId,
    pendingSessionTokenCleanupIds: state.pendingSessionTokenCleanupIds.filter(
      (cleanupId) => cleanupId !== id
    ),
    servers,
  };
}

/**
 * Brings older saved-server records onto the current, URL-derived ID scheme.
 *
 * A legacy ID may have represented more than one URL. In that case we never
 * copy its token to a new server, because doing so could disclose a credential
 * to the wrong backend. The user can sign in again on each affected server.
 */
export function migrateSavedServers(
  savedServers: SavedServer[],
  savedActiveServerId: string | null
): SavedServersMigration {
  const nextServers: SavedServer[] = [];
  const seenServerIds = new Set<string>();
  const canonicalSourceIds = new Set<string>();
  const invalidSourceIds = new Set<string>();
  const destinationsBySourceId = new Map<string, Set<string>>();
  const sourceIdsByDestination = new Map<string, Set<string>>();
  let hasServerChanges = false;

  for (const savedServer of savedServers) {
    const normalizedUrl = normalizeServerUrl(savedServer.url);
    if (!(normalizedUrl && isValidServerUrl(normalizedUrl))) {
      invalidSourceIds.add(savedServer.id);
      hasServerChanges = true;
      continue;
    }

    const id = serverIdFromUrl(normalizedUrl);
    const name = savedServer.name.trim() || displayNameFromUrl(normalizedUrl);
    const destinations =
      destinationsBySourceId.get(savedServer.id) ?? new Set();
    destinations.add(id);
    destinationsBySourceId.set(savedServer.id, destinations);

    const sourceIds = sourceIdsByDestination.get(id) ?? new Set();
    sourceIds.add(savedServer.id);
    sourceIdsByDestination.set(id, sourceIds);

    if (savedServer.id === id) {
      canonicalSourceIds.add(savedServer.id);
    }

    if (seenServerIds.has(id)) {
      hasServerChanges = true;
      continue;
    }

    seenServerIds.add(id);
    nextServers.push({ id, name, url: normalizedUrl });
    if (
      savedServer.id !== id ||
      savedServer.name !== name ||
      savedServer.url !== normalizedUrl
    ) {
      hasServerChanges = true;
    }
  }

  const clearSessionTokenIds = new Set<string>();
  const sessionTokenMigrations: SessionTokenMigration[] = [];

  for (const [sourceId, destinations] of destinationsBySourceId) {
    const destination = destinations.values().next().value ?? null;
    const hasUnambiguousDestination =
      !invalidSourceIds.has(sourceId) && destinations.size === 1;

    if (!(hasUnambiguousDestination && destination)) {
      if (!canonicalSourceIds.has(sourceId)) {
        clearSessionTokenIds.add(sourceId);
      }
      continue;
    }

    if (sourceId === destination) {
      continue;
    }

    const sourceIds = sourceIdsByDestination.get(destination);
    const legacySourceIds = [...(sourceIds ?? [])].filter(
      (candidateId) => candidateId !== destination
    );
    const canUseCanonicalDestination =
      canonicalSourceIds.has(destination) && legacySourceIds.length === 1;
    if (sourceIds && sourceIds.size > 1 && !canUseCanonicalDestination) {
      clearSessionTokenIds.add(sourceId);
      continue;
    }

    sessionTokenMigrations.push({
      fromServerId: sourceId,
      toServerId: destination,
    });
  }

  for (const sourceId of invalidSourceIds) {
    if (!canonicalSourceIds.has(sourceId)) {
      clearSessionTokenIds.add(sourceId);
    }
  }

  const activeServerId = resolveActiveServerId({
    destinationsBySourceId,
    nextServers,
    savedActiveServerId,
  });

  return {
    activeServerId,
    clearSessionTokenIds: [...clearSessionTokenIds],
    hasChanges: hasServerChanges || activeServerId !== savedActiveServerId,
    servers: nextServers,
    sessionTokenMigrations,
  };
}

function resolveActiveServerId({
  destinationsBySourceId,
  nextServers,
  savedActiveServerId,
}: {
  destinationsBySourceId: Map<string, Set<string>>;
  nextServers: SavedServer[];
  savedActiveServerId: string | null;
}): string | null {
  if (!savedActiveServerId) {
    return nextServers[0]?.id ?? null;
  }

  if (nextServers.some((server) => server.id === savedActiveServerId)) {
    return savedActiveServerId;
  }

  const destinations = destinationsBySourceId.get(savedActiveServerId);
  if (!destinations || destinations.size === 0) {
    // The previously selected record was dropped (invalid URL). Keep a
    // remaining saved server rather than leaving the app with no selection.
    return nextServers[0]?.id ?? null;
  }
  if (destinations.size !== 1) {
    return null;
  }

  const destination = destinations.values().next().value ?? null;
  if (!destination) {
    return nextServers[0]?.id ?? null;
  }
  return nextServers.some((server) => server.id === destination)
    ? destination
    : (nextServers[0]?.id ?? null);
}

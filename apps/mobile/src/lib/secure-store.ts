import * as SecureStore from "expo-secure-store";
import type { SessionTokenMigration } from "./server-records";

const SESSION_TOKEN_OPTIONS = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
} as const;

export interface MigrateSessionTokensOptions {
  /**
   * Leave legacy entries in place when a caller needs to commit related
   * metadata first. This prevents a failed metadata write from stranding a
   * session under an unreachable server ID.
   */
  clearSource?: boolean;
}

function sessionKey(serverId: string): string {
  return `atlas.session.${serverId}`;
}

async function isSecureStoreAvailable(): Promise<boolean> {
  return SecureStore.isAvailableAsync();
}

export async function loadSessionToken(
  serverId: string
): Promise<string | null> {
  if (!(await isSecureStoreAvailable())) {
    return null;
  }
  return SecureStore.getItemAsync(sessionKey(serverId));
}

export async function saveSessionToken(
  serverId: string,
  token: string
): Promise<void> {
  if (!(await isSecureStoreAvailable())) {
    throw new Error("Session storage is not available on this device.");
  }
  await SecureStore.setItemAsync(
    sessionKey(serverId),
    token,
    SESSION_TOKEN_OPTIONS
  );
}

export async function clearSessionToken(serverId: string): Promise<void> {
  if (!(await isSecureStoreAvailable())) {
    return;
  }
  await SecureStore.deleteItemAsync(sessionKey(serverId));
}

export async function clearSessionTokens(serverIds: string[]): Promise<void> {
  await Promise.all(
    [...new Set(serverIds)].map((serverId) => clearSessionToken(serverId))
  );
}

export async function migrateSessionTokens(
  migrations: SessionTokenMigration[],
  { clearSource = true }: MigrateSessionTokensOptions = {}
): Promise<void> {
  const uniqueMigrations = uniqueTokenMigrations(migrations);
  const snapshots = await Promise.all(
    uniqueMigrations.map(async ({ fromServerId, toServerId }) => {
      const [destinationToken, sourceToken] = await Promise.all([
        loadSessionToken(toServerId),
        loadSessionToken(fromServerId),
      ]);
      return { destinationToken, fromServerId, sourceToken, toServerId };
    })
  );

  const migrationsByDestination = new Map<
    string,
    Array<(typeof snapshots)[number]>
  >();
  for (const snapshot of snapshots) {
    const destinationMigrations =
      migrationsByDestination.get(snapshot.toServerId) ?? [];
    destinationMigrations.push(snapshot);
    migrationsByDestination.set(snapshot.toServerId, destinationMigrations);
  }

  for (const [toServerId, destinationMigrations] of migrationsByDestination) {
    const destinationToken = destinationMigrations[0]?.destinationToken;
    if (destinationToken !== null) {
      // A token already saved under the current V2 ID is authoritative.
      continue;
    }

    const sourceTokens = destinationMigrations.filter(
      ({ sourceToken }) => sourceToken !== null
    );
    if (sourceTokens.length > 1) {
      throw new Error(
        `Cannot safely choose between multiple legacy sessions for ${toServerId}.`
      );
    }

    const sourceToken = sourceTokens[0]?.sourceToken;
    if (typeof sourceToken === "string") {
      await saveSessionToken(toServerId, sourceToken);
    }
  }

  if (clearSource) {
    await clearSessionTokens(
      snapshots
        .filter(({ sourceToken }) => sourceToken !== null)
        .map(({ fromServerId }) => fromServerId)
    );
  }
}

function uniqueTokenMigrations(
  migrations: SessionTokenMigration[]
): SessionTokenMigration[] {
  const destinationsBySource = new Map<string, string>();
  const uniqueMigrations: SessionTokenMigration[] = [];

  for (const migration of migrations) {
    if (migration.fromServerId === migration.toServerId) {
      continue;
    }

    const existingDestination = destinationsBySource.get(
      migration.fromServerId
    );
    if (
      existingDestination !== undefined &&
      existingDestination !== migration.toServerId
    ) {
      throw new Error(
        `Legacy session ${migration.fromServerId} maps to multiple servers.`
      );
    }
    if (existingDestination !== undefined) {
      continue;
    }

    destinationsBySource.set(migration.fromServerId, migration.toServerId);
    uniqueMigrations.push(migration);
  }

  return uniqueMigrations;
}

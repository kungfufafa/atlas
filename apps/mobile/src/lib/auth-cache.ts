import type { AuthUserResponse, UserOrgSummary } from "@atlas/core/contract";
import AsyncStorage from "@react-native-async-storage/async-storage";

const AUTH_CACHE_KEY_PREFIX = "atlas.auth-cache.v1.";

export interface CachedAuthSession {
  orgs: UserOrgSummary[];
  user: AuthUserResponse;
}

function getAuthCacheKey(serverId: string): string {
  return `${AUTH_CACHE_KEY_PREFIX}${serverId}`;
}

function isCachedAuthSession(value: unknown): value is CachedAuthSession {
  if (!(value && typeof value === "object")) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.orgs) &&
    record.user !== null &&
    typeof record.user === "object" &&
    typeof (record.user as Record<string, unknown>).email === "string"
  );
}

export async function loadCachedAuthSession(
  serverId: string
): Promise<CachedAuthSession | null> {
  const raw = await AsyncStorage.getItem(getAuthCacheKey(serverId));
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return isCachedAuthSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function saveCachedAuthSession(
  serverId: string,
  session: CachedAuthSession
): Promise<void> {
  const { sessionToken: _, ...user } = session.user;
  await AsyncStorage.setItem(
    getAuthCacheKey(serverId),
    JSON.stringify({ ...session, user })
  );
}

export async function clearCachedAuthSession(serverId: string): Promise<void> {
  await AsyncStorage.removeItem(getAuthCacheKey(serverId));
}

import AsyncStorage from "@react-native-async-storage/async-storage";

const ACTIVE_PROFILE_STORAGE_PREFIX = "atlas.active-profile.v1";

export interface ActiveProfileStorageScope {
  orgId: string;
  serverId: string;
}

function activeProfileStorageKey(scope: ActiveProfileStorageScope): string {
  return `${ACTIVE_PROFILE_STORAGE_PREFIX}.${encodeURIComponent(scope.serverId)}.${encodeURIComponent(scope.orgId)}`;
}

export async function loadActiveProfileId(
  scope: ActiveProfileStorageScope
): Promise<string | null> {
  const value = await AsyncStorage.getItem(activeProfileStorageKey(scope));
  return value?.trim() || null;
}

export async function saveActiveProfileId(
  scope: ActiveProfileStorageScope,
  profileId: string | null
): Promise<void> {
  const key = activeProfileStorageKey(scope);
  if (!profileId) {
    await AsyncStorage.removeItem(key);
    return;
  }
  await AsyncStorage.setItem(key, profileId);
}

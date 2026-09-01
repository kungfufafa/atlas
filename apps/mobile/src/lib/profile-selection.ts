export interface SelectableProfile {
  id: string;
  isDefault?: boolean;
}

export interface ProfileScopedItem {
  profileId: string;
}

export function resolveSelectedProfileId(
  profiles: readonly SelectableProfile[],
  preferredProfileId?: string | null
): string | null {
  const preferredProfile = profiles.find(
    (profile) => profile.id === preferredProfileId
  );
  if (preferredProfile) {
    return preferredProfile.id;
  }

  return (
    profiles.find((profile) => profile.isDefault)?.id ??
    profiles.find((profile) => profile.id === "default")?.id ??
    profiles[0]?.id ??
    null
  );
}

export function filterProfileScopedItems<T extends ProfileScopedItem>(
  items: readonly T[],
  profileId: string | null
): T[] {
  if (!profileId) {
    return [];
  }
  return items.filter((item) => item.profileId === profileId);
}

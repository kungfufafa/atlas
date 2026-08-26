import { resolve } from "node:path";
import { getProfileSoulDir } from "./resolve";

interface ProfileSoulMutationScope {
  orgId: string;
  profileId: string;
}

const profileSoulMutationTails = new Map<string, Promise<void>>();

function profileSoulMutationKey(scope: ProfileSoulMutationScope): string {
  return resolve(getProfileSoulDir(scope.orgId, scope.profileId));
}

/**
 * Serialize cooperative writers for one profile soul directory across service
 * instances and tool paths. A rejected mutation never poisons the next waiter.
 */
export function withProfileSoulMutationLock<T>(
  orgId: string,
  profileId: string,
  mutate: () => Promise<T>
): Promise<T> {
  const key = profileSoulMutationKey({ orgId, profileId });
  const previous = profileSoulMutationTails.get(key) ?? Promise.resolve();
  const next = previous.then(mutate, mutate);
  const tail = next.then(
    () => undefined,
    () => undefined
  );
  profileSoulMutationTails.set(key, tail);
  void tail.then(() => {
    if (profileSoulMutationTails.get(key) === tail) {
      profileSoulMutationTails.delete(key);
    }
  });
  return next;
}

/**
 * Acquire multiple profile locks in stable path order so operations such as a
 * clone can hold the source snapshot and target publication without deadlock.
 */
export function withProfileSoulMutationLocks<T>(
  scopes: ProfileSoulMutationScope[],
  mutate: () => Promise<T>
): Promise<T> {
  const uniqueScopes = new Map<string, ProfileSoulMutationScope>();
  for (const scope of scopes) {
    uniqueScopes.set(profileSoulMutationKey(scope), scope);
  }
  const orderedScopes = [...uniqueScopes.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, scope]) => scope);

  const acquire = (index: number): Promise<T> => {
    const scope = orderedScopes[index];
    if (!scope) {
      return mutate();
    }
    return withProfileSoulMutationLock(scope.orgId, scope.profileId, () =>
      acquire(index + 1)
    );
  };

  return acquire(0);
}

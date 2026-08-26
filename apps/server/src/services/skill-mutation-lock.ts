const profileSkillMutationTails = new Map<string, Promise<void>>();

export function withProfileSkillMutationLock<T>(
  orgId: string,
  profileId: string,
  mutate: () => Promise<T>
): Promise<T> {
  const key = `${orgId}:${profileId}`;
  const previous = profileSkillMutationTails.get(key) ?? Promise.resolve();
  const next = previous.then(mutate, mutate);
  const tail = next.then(
    () => undefined,
    () => undefined
  );
  profileSkillMutationTails.set(key, tail);
  void tail.then(() => {
    if (profileSkillMutationTails.get(key) === tail) {
      profileSkillMutationTails.delete(key);
    }
  });
  return next;
}

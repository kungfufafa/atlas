import type { DatabaseAdapter } from "@atlas/db";

const bootstrapMutationLocks = new WeakMap<DatabaseAdapter, Promise<unknown>>();

/** Serializes the two operations that may establish the first authenticated state. */
export function runSerializedBootstrapMutation<T>(
  databaseAdapter: DatabaseAdapter,
  mutation: () => Promise<T>
): Promise<T> {
  const previous =
    bootstrapMutationLocks.get(databaseAdapter) ?? Promise.resolve();
  const next = previous.then(mutation, mutation);
  const tail = next.then(
    () => undefined,
    () => undefined
  );
  bootstrapMutationLocks.set(databaseAdapter, tail);
  void tail.then(() => {
    if (bootstrapMutationLocks.get(databaseAdapter) === tail) {
      bootstrapMutationLocks.delete(databaseAdapter);
    }
  });
  return next;
}

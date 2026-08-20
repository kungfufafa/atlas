/** Browser stub — request-scoped org isolation is a Node/Bun worker concern. */
export class AsyncLocalStorage<T> {
  getStore(): T | undefined {}

  run<R>(_store: T, callback: () => R): R {
    return callback();
  }
}

/** Browser stub — request-scoped org isolation is a Node/Bun worker concern. */
export class AsyncLocalStorage<T> {
  private store?: T;

  getStore(): T | undefined {
    return this.store;
  }

  run<R>(store: T, callback: () => R): R {
    const previous = this.store;
    this.store = store;
    try {
      return callback();
    } finally {
      this.store = previous;
    }
  }
}

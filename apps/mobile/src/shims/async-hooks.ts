export class AsyncLocalStorage<T> {
  #store?: T;

  getStore(): T | undefined {
    return this.#store;
  }

  run<R>(_store: T, callback: () => R): R {
    return callback();
  }
}

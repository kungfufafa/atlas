import { beforeEach, expect, mock, test } from "bun:test";
import type { SavedServerState } from "./storage";

const values = new Map<string, string>();
const getItem = mock(async (key: string) => values.get(key) ?? null);
const removeItem = mock(async (key: string) => {
  values.delete(key);
});
const setItem = mock(async (key: string, value: string) => {
  values.set(key, value);
});

mock.module("@react-native-async-storage/async-storage", () => ({
  default: { getItem, removeItem, setItem },
}));

const { createSerializedServerStateStore, loadServerState, saveServerState } =
  await import("./storage");

const FIRST_SERVER = {
  id: "server-one",
  name: "One",
  url: "https://one.example.com",
};
const SECOND_SERVER = {
  id: "server-two",
  name: "Two",
  url: "https://two.example.com",
};

function createState(activeServerId = FIRST_SERVER.id): SavedServerState {
  return {
    activeServerId,
    pendingSessionTokenCleanupIds: [],
    servers: [FIRST_SERVER, SECOND_SERVER],
  };
}

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

beforeEach(() => {
  values.clear();
  getItem.mockClear();
  removeItem.mockClear();
  setItem.mockClear();
});

test("stores server list and active selection in one durable record", async () => {
  const state = createState(SECOND_SERVER.id);

  await saveServerState(state);

  expect(setItem).toHaveBeenCalledWith(
    "atlas.server-state.v1",
    JSON.stringify(state)
  );
  await expect(loadServerState()).resolves.toEqual({
    needsMigration: false,
    state,
  });
});

test("loads the split legacy keys until a durable state record is written", async () => {
  values.set("atlas.servers", JSON.stringify([FIRST_SERVER]));
  values.set("atlas.active-server", FIRST_SERVER.id);

  await expect(loadServerState()).resolves.toEqual({
    needsMigration: true,
    state: {
      activeServerId: FIRST_SERVER.id,
      pendingSessionTokenCleanupIds: [],
      servers: [FIRST_SERVER],
    },
  });
});

test("serializes rapid selections and commits the latest durable selection", async () => {
  const firstMutationStarted = createDeferred();
  const allowFirstMutation = createDeferred();
  const persistedStates: SavedServerState[] = [];
  const store = createSerializedServerStateStore({
    initialState: createState(),
    persist: async (state) => {
      persistedStates.push(state);
    },
  });

  const firstSelection = store.mutate(async (current) => {
    firstMutationStarted.resolve();
    await allowFirstMutation.promise;
    return {
      result: undefined,
      state: { ...current, activeServerId: SECOND_SERVER.id },
    };
  });
  await firstMutationStarted.promise;
  const secondSelection = store.mutate((current) => ({
    result: undefined,
    state: { ...current, activeServerId: FIRST_SERVER.id },
  }));

  allowFirstMutation.resolve();
  await Promise.all([firstSelection, secondSelection]);

  expect(persistedStates.map((state) => state.activeServerId)).toEqual([
    SECOND_SERVER.id,
    FIRST_SERVER.id,
  ]);
  expect(store.getState().activeServerId).toBe(FIRST_SERVER.id);
});

test("does not expose a state change when persistence fails and permits retry", async () => {
  let shouldFail = true;
  const committedStates: SavedServerState[] = [];
  const store = createSerializedServerStateStore({
    initialState: createState(),
    onCommit: (state) => committedStates.push(state),
    persist: async () => {
      if (shouldFail) {
        throw new Error("Storage unavailable");
      }
    },
  });

  const chooseSecond = (current: SavedServerState) => ({
    result: undefined,
    state: { ...current, activeServerId: SECOND_SERVER.id },
  });
  await expect(store.mutate(chooseSecond)).rejects.toThrow(
    "Storage unavailable"
  );

  expect(store.getState().activeServerId).toBe(FIRST_SERVER.id);
  expect(committedStates).toEqual([]);

  shouldFail = false;
  await store.mutate(chooseSecond);

  expect(store.getState().activeServerId).toBe(SECOND_SERVER.id);
  expect(committedStates).toEqual([
    expect.objectContaining({ activeServerId: SECOND_SERVER.id }),
  ]);
});

test("keeps a server retryable when its credential cleanup fails", async () => {
  let shouldFail = true;
  const store = createSerializedServerStateStore({
    initialState: createState(),
    persist: async () => undefined,
  });

  const removeFirst = async (current: SavedServerState) => {
    if (shouldFail) {
      throw new Error("Keychain unavailable");
    }
    const servers = current.servers.filter(
      (server) => server.id !== FIRST_SERVER.id
    );
    return {
      result: undefined,
      state: {
        ...current,
        activeServerId: servers[0]?.id ?? null,
        servers,
      },
    };
  };

  await expect(store.mutate(removeFirst)).rejects.toThrow(
    "Keychain unavailable"
  );
  expect(store.getState().servers).toEqual([FIRST_SERVER, SECOND_SERVER]);

  shouldFail = false;
  await store.mutate(removeFirst);

  expect(store.getState().servers).toEqual([SECOND_SERVER]);
  expect(store.getState().activeServerId).toBe(SECOND_SERVER.id);
});

import { beforeEach, expect, mock, test } from "bun:test";

const values = new Map<string, string>();
let storageUnavailable = false;
const getItem = mock(async (key: string) => {
  if (storageUnavailable) {
    throw new Error("Storage unavailable");
  }
  return values.get(key) ?? null;
});
const removeItem = mock(async (key: string) => {
  if (storageUnavailable) {
    throw new Error("Storage unavailable");
  }
  values.delete(key);
});
const setItem = mock(async (key: string, value: string) => {
  if (storageUnavailable) {
    throw new Error("Storage unavailable");
  }
  values.set(key, value);
});

mock.module("@react-native-async-storage/async-storage", () => ({
  default: { getItem, removeItem, setItem },
}));

const {
  clearFailedChatTurn,
  failedChatTurnStorageKey,
  readFailedChatTurn,
  storeFailedChatTurn,
} = await import("./failed-turn");

const SCOPE = {
  orgId: "org/one",
  serverId: "server-one",
  sessionId: "session-one",
};

beforeEach(() => {
  values.clear();
  storageUnavailable = false;
  getItem.mockClear();
  removeItem.mockClear();
  setItem.mockClear();
});

test("scopes failed turns to the server, organization, and session", () => {
  expect(failedChatTurnStorageKey(SCOPE)).toBe(
    "atlas.mobile.failed-chat-turn.v1.server-one.org%2Fone.session-one"
  );
});

test("round-trips and clears a failed text turn", async () => {
  await storeFailedChatTurn(SCOPE, {
    error: "Rate limited",
    text: "Retry me",
  });

  await expect(readFailedChatTurn(SCOPE)).resolves.toEqual({
    error: "Rate limited",
    text: "Retry me",
  });

  await clearFailedChatTurn(SCOPE);
  await expect(readFailedChatTurn(SCOPE)).resolves.toBeNull();
});

test("ignores malformed and incomplete stored turns", async () => {
  values.set(failedChatTurnStorageKey(SCOPE), "not-json");
  await expect(readFailedChatTurn(SCOPE)).resolves.toBeNull();

  values.set(
    failedChatTurnStorageKey(SCOPE),
    JSON.stringify({ error: "Rate limited" })
  );
  await expect(readFailedChatTurn(SCOPE)).resolves.toBeNull();
});

test("keeps storage failures out of the chat flow", async () => {
  storageUnavailable = true;

  await expect(
    storeFailedChatTurn(SCOPE, { error: "429", text: "Retry me" })
  ).resolves.toBeUndefined();
  await expect(readFailedChatTurn(SCOPE)).resolves.toBeNull();
  await expect(clearFailedChatTurn(SCOPE)).resolves.toBeUndefined();
});

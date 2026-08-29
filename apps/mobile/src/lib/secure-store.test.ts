import { beforeEach, expect, mock, test } from "bun:test";

const values = new Map<string, string>();
let failNextWrite = false;
let storeAvailable = true;
const getItemAsync = mock(async (key: string) => values.get(key) ?? null);
const setItemAsync = mock(async (key: string, value: string) => {
  if (failNextWrite) {
    failNextWrite = false;
    throw new Error("Keychain is temporarily unavailable.");
  }
  values.set(key, value);
});
const deleteItemAsync = mock(async (key: string) => {
  values.delete(key);
});
const isAvailableAsync = mock(async () => storeAvailable);

mock.module("expo-secure-store", () => ({
  deleteItemAsync,
  getItemAsync,
  isAvailableAsync,
  setItemAsync,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "when-unlocked-this-device-only",
}));

const { clearSessionToken, migrateSessionTokens, saveSessionToken } =
  await import("./secure-store");

beforeEach(() => {
  failNextWrite = false;
  storeAvailable = true;
  values.clear();
  deleteItemAsync.mockClear();
  getItemAsync.mockClear();
  isAvailableAsync.mockClear();
  setItemAsync.mockClear();
});

test("stores session tokens with device-only keychain accessibility", async () => {
  await saveSessionToken("atlas-server-v2-00610074006c00610073", "token");

  expect(setItemAsync).toHaveBeenCalledWith(
    "atlas.session.atlas-server-v2-00610074006c00610073",
    "token",
    { keychainAccessible: "when-unlocked-this-device-only" }
  );
});

test("moves a migrated token and removes the previous secure-store entry", async () => {
  values.set("atlas.session.legacy-id", "token");

  await migrateSessionTokens([
    { fromServerId: "legacy-id", toServerId: "atlas-server-v2-new-id" },
  ]);

  expect(values.get("atlas.session.atlas-server-v2-new-id")).toBe("token");
  expect(values.has("atlas.session.legacy-id")).toBe(false);
});

test("does not overwrite a session already stored under the V2 server ID", async () => {
  values.set("atlas.session.legacy-id", "legacy-token");
  values.set("atlas.session.atlas-server-v2-new-id", "v2-token");

  await migrateSessionTokens([
    { fromServerId: "legacy-id", toServerId: "atlas-server-v2-new-id" },
  ]);

  expect(values.get("atlas.session.atlas-server-v2-new-id")).toBe("v2-token");
  expect(values.has("atlas.session.legacy-id")).toBe(false);
});

test("keeps a legacy token when copying it to the V2 key fails", async () => {
  values.set("atlas.session.legacy-id", "legacy-token");
  failNextWrite = true;

  await expect(
    migrateSessionTokens([
      { fromServerId: "legacy-id", toServerId: "atlas-server-v2-new-id" },
    ])
  ).rejects.toThrow("Keychain is temporarily unavailable");

  expect(values.get("atlas.session.legacy-id")).toBe("legacy-token");
  expect(values.has("atlas.session.atlas-server-v2-new-id")).toBe(false);
});

test("can copy a legacy token without clearing it before metadata commits", async () => {
  values.set("atlas.session.legacy-id", "legacy-token");

  await migrateSessionTokens(
    [{ fromServerId: "legacy-id", toServerId: "atlas-server-v2-new-id" }],
    { clearSource: false }
  );

  expect(values.get("atlas.session.legacy-id")).toBe("legacy-token");
  expect(values.get("atlas.session.atlas-server-v2-new-id")).toBe(
    "legacy-token"
  );
});

test("clears the server-specific session token", async () => {
  await clearSessionToken("atlas-server-v2-server");

  expect(deleteItemAsync).toHaveBeenCalledWith(
    "atlas.session.atlas-server-v2-server"
  );
});

test("refuses to migrate one legacy session onto two destinations", async () => {
  values.set("atlas.session.legacy-id", "token");

  await expect(
    migrateSessionTokens([
      { fromServerId: "legacy-id", toServerId: "atlas-server-v2-one" },
      { fromServerId: "legacy-id", toServerId: "atlas-server-v2-two" },
    ])
  ).rejects.toThrow();

  expect(values.get("atlas.session.legacy-id")).toBe("token");
  expect(values.has("atlas.session.atlas-server-v2-one")).toBe(false);
  expect(values.has("atlas.session.atlas-server-v2-two")).toBe(false);
});

test("can remove a server when the device has no credential store", async () => {
  storeAvailable = false;

  await clearSessionToken("atlas-server-v2-server");

  expect(deleteItemAsync).not.toHaveBeenCalled();
});

test("refuses to choose between two legacy sessions for one destination", async () => {
  values.set("atlas.session.legacy-a", "token-a");
  values.set("atlas.session.legacy-b", "token-b");

  await expect(
    migrateSessionTokens([
      { fromServerId: "legacy-a", toServerId: "atlas-server-v2-new-id" },
      { fromServerId: "legacy-b", toServerId: "atlas-server-v2-new-id" },
    ])
  ).rejects.toThrow();

  expect(values.get("atlas.session.legacy-a")).toBe("token-a");
  expect(values.get("atlas.session.legacy-b")).toBe("token-b");
  expect(values.has("atlas.session.atlas-server-v2-new-id")).toBe(false);
});

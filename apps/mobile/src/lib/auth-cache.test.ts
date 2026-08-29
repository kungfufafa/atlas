import { beforeEach, expect, mock, test } from "bun:test";

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

const { clearCachedAuthSession, loadCachedAuthSession, saveCachedAuthSession } =
  await import("./auth-cache");

const SERVER_ID = "server-one";
const SESSION = {
  orgs: [
    {
      createdAt: "2026-01-01T00:00:00.000Z",
      id: "org-1",
      name: "Atlas",
      role: "admin" as const,
      slug: "atlas",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ],
  user: {
    activeOrgId: "org-1",
    email: "admin@example.com",
    sessionToken: "must-not-be-cached",
  },
};

beforeEach(() => {
  values.clear();
  getItem.mockClear();
  removeItem.mockClear();
  setItem.mockClear();
});

test("keeps the offline auth snapshot without the session token", async () => {
  await saveCachedAuthSession(SERVER_ID, SESSION);

  const stored = values.get("atlas.auth-cache.v1.server-one");
  expect(stored).not.toContain("must-not-be-cached");
  await expect(loadCachedAuthSession(SERVER_ID)).resolves.toEqual({
    ...SESSION,
    user: { activeOrgId: "org-1", email: "admin@example.com" },
  });
});

test("clears the snapshot when the server session is removed", async () => {
  await saveCachedAuthSession(SERVER_ID, SESSION);
  await clearCachedAuthSession(SERVER_ID);

  await expect(loadCachedAuthSession(SERVER_ID)).resolves.toBeNull();
});

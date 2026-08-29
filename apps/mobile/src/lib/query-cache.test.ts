import { expect, test } from "bun:test";
import {
  parsePersistedQueryCache,
  shouldPersistOfflineQuery,
} from "./query-cache";
import { SERVER_QUERY_SCOPE } from "./query-scope";

const NOW = 1_800_000_000_000;

test("persists only server-scoped content that is useful offline", () => {
  expect(
    shouldPersistOfflineQuery([
      "sessions",
      "profile-1",
      SERVER_QUERY_SCOPE,
      "https://atlas.example.com",
      "org",
      "org-1",
    ])
  ).toBe(true);
  expect(
    shouldPersistOfflineQuery([
      "providers",
      SERVER_QUERY_SCOPE,
      "https://atlas.example.com",
    ])
  ).toBe(false);
  expect(shouldPersistOfflineQuery(["sessions"])).toBe(false);
});

test("rejects expired or malformed offline cache snapshots", () => {
  const state = { mutations: [], queries: [] };
  expect(
    parsePersistedQueryCache(
      JSON.stringify({ savedAt: NOW, state, version: 1 }),
      NOW
    )
  ).toEqual({ savedAt: NOW, state, version: 1 });
  expect(
    parsePersistedQueryCache(
      JSON.stringify({
        savedAt: NOW - 8 * 24 * 60 * 60 * 1000,
        state,
        version: 1,
      }),
      NOW
    )
  ).toBeNull();
  expect(parsePersistedQueryCache("not-json", NOW)).toBeNull();
});

import { expect, test } from "bun:test";
import {
  migrateSavedServers,
  removeServerFromState,
  sanitizeSavedServerState,
} from "./server-records";
import { serverIdFromUrl } from "./server-url";

test("migrates a legacy server ID and preserves its active selection", () => {
  const url = "https://atlas.example.com:4310";
  const legacyId = "atlas-example-com-4310";
  const id = serverIdFromUrl(url);

  const migration = migrateSavedServers(
    [{ id: legacyId, name: "Atlas", url }],
    legacyId
  );

  expect(migration.activeServerId).toBe(id);
  expect(migration.clearSessionTokenIds).toEqual([]);
  expect(migration.hasChanges).toBe(true);
  expect(migration.servers).toEqual([{ id, name: "Atlas", url }]);
  expect(migration.sessionTokenMigrations).toEqual([
    { fromServerId: legacyId, toServerId: id },
  ]);
});

test("does not transfer a token when a legacy ID maps to multiple URLs", () => {
  const legacyId = "127-0-0-1-4310";
  const migration = migrateSavedServers(
    [
      { id: legacyId, name: "HTTP", url: "http://127.0.0.1:4310" },
      { id: legacyId, name: "HTTPS", url: "https://127.0.0.1:4310" },
    ],
    legacyId
  );

  expect(migration.activeServerId).toBeNull();
  expect(migration.clearSessionTokenIds).toEqual([legacyId]);
  expect(migration.sessionTokenMigrations).toEqual([]);
  expect(migration.servers.map((server) => server.id)).toEqual([
    serverIdFromUrl("http://127.0.0.1:4310"),
    serverIdFromUrl("https://127.0.0.1:4310"),
  ]);
});

test("migrates a legacy token into a matching V2 record without replacing it", () => {
  const url = "https://atlas.example.com";
  const id = serverIdFromUrl(url);
  const legacyId = "atlas-example-com";

  const migration = migrateSavedServers(
    [
      { id, name: "Atlas", url },
      { id: legacyId, name: "Atlas (old)", url },
    ],
    legacyId
  );

  expect(migration.activeServerId).toBe(id);
  expect(migration.clearSessionTokenIds).toEqual([]);
  expect(migration.sessionTokenMigrations).toEqual([
    { fromServerId: legacyId, toServerId: id },
  ]);
});

test("removes unsafe legacy server records and their tokens", () => {
  const legacyId = "atlas-example-com";
  const migration = migrateSavedServers(
    [{ id: legacyId, name: "Atlas", url: "http://atlas.example.com" }],
    legacyId
  );

  expect(migration.activeServerId).toBeNull();
  expect(migration.clearSessionTokenIds).toEqual([legacyId]);
  expect(migration.servers).toEqual([]);
  expect(migration.sessionTokenMigrations).toEqual([]);
});

test("never exposes an unsafe legacy server during a failed migration", () => {
  const legacyId = "atlas-example-com";

  expect(
    sanitizeSavedServerState({
      activeServerId: legacyId,
      pendingSessionTokenCleanupIds: [legacyId],
      servers: [
        { id: legacyId, name: "Atlas", url: "http://atlas.example.com" },
      ],
    })
  ).toEqual({
    activeServerId: null,
    pendingSessionTokenCleanupIds: [legacyId],
    servers: [],
  });
});

test("keeps a remaining valid server when the active record is unsafe", () => {
  const url = "https://atlas.example.com";
  const id = serverIdFromUrl(url);
  const unsafeId = "atlas-example-com";

  const migration = migrateSavedServers(
    [
      { id, name: "Atlas", url },
      { id: unsafeId, name: "Bad", url: "http://atlas.example.com" },
    ],
    unsafeId
  );

  expect(migration.activeServerId).toBe(id);
  expect(migration.clearSessionTokenIds).toEqual([unsafeId]);
  expect(migration.servers).toEqual([{ id, name: "Atlas", url }]);
  expect(migration.sessionTokenMigrations).toEqual([]);
});

test("does not migrate tokens when two legacy IDs collapse onto one server", () => {
  const url = "https://atlas.example.com";
  const id = serverIdFromUrl(url);

  const migration = migrateSavedServers(
    [
      { id: "legacy-a", name: "A", url },
      { id: "legacy-b", name: "B", url },
    ],
    "legacy-a"
  );

  expect(migration.activeServerId).toBe(id);
  expect([...migration.clearSessionTokenIds].sort()).toEqual([
    "legacy-a",
    "legacy-b",
  ]);
  expect(migration.sessionTokenMigrations).toEqual([]);
  expect(migration.servers).toEqual([{ id, name: "A", url }]);
});

test("removes a server and its pending cleanup without touching other sessions", () => {
  const first = {
    id: "server-one",
    name: "One",
    url: "https://one.example.com",
  };
  const second = {
    id: "server-two",
    name: "Two",
    url: "https://two.example.com",
  };

  expect(
    removeServerFromState(
      {
        activeServerId: first.id,
        pendingSessionTokenCleanupIds: [first.id, "legacy-id"],
        servers: [first, second],
      },
      first.id
    )
  ).toEqual({
    activeServerId: second.id,
    pendingSessionTokenCleanupIds: ["legacy-id"],
    servers: [second],
  });
});

test("removing the last server clears the active selection", () => {
  const only = {
    id: "server-one",
    name: "One",
    url: "https://one.example.com",
  };

  expect(
    removeServerFromState(
      {
        activeServerId: only.id,
        pendingSessionTokenCleanupIds: [],
        servers: [only],
      },
      only.id
    )
  ).toEqual({
    activeServerId: null,
    pendingSessionTokenCleanupIds: [],
    servers: [],
  });
});

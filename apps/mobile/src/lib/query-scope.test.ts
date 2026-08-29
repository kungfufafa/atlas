import { expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  createServerQueryClient,
  getServerScopeKey,
  hasServerScope,
  SERVER_QUERY_SCOPE,
  withServerScope,
} from "./query-scope";

test("scopes the same resource and org independently for each server", () => {
  const resourceKey = ["profiles"] as const;

  const serverAKey = [
    ...withServerScope(resourceKey, "server-a"),
    "org",
    "org-1",
  ];
  const serverBKey = [
    ...withServerScope(resourceKey, "server-b"),
    "org",
    "org-1",
  ];

  expect(serverAKey).toEqual([
    "profiles",
    SERVER_QUERY_SCOPE,
    "server-a",
    "org",
    "org-1",
  ]);
  expect(serverBKey).not.toEqual(serverAKey);
});

test("recognizes the active server scope without matching another server", () => {
  const queryKey = withServerScope(["sessions", "profile-1"], "server-a");

  expect(hasServerScope(queryKey, "server-a")).toBe(true);
  expect(hasServerScope(queryKey, "server-b")).toBe(false);
});

test("uses a stable scope while no server is connected", () => {
  expect(getServerScopeKey(null)).toBe("none");
  expect(getServerScopeKey(undefined)).toBe("none");
});

test("invalidates only the server that started a mutation", async () => {
  const queryClient = new QueryClient();
  const serverAKey = [
    ...withServerScope(["tools"], "server-a"),
    "org",
    "org-1",
  ];
  const serverBKey = [
    ...withServerScope(["tools"], "server-b"),
    "org",
    "org-1",
  ];
  queryClient.setQueryData(serverAKey, ["a"]);
  queryClient.setQueryData(serverBKey, ["b"]);

  await createServerQueryClient(queryClient, "server-a").invalidateQueries({
    queryKey: ["tools"],
  });

  expect(queryClient.getQueryState(serverAKey)?.isInvalidated).toBe(true);
  expect(queryClient.getQueryState(serverBKey)?.isInvalidated).toBe(false);
});

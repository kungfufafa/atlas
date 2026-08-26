import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { invalidateProviderQueries } from "./use-app-queries";

describe("provider discovery cache invalidation", () => {
  test("removes cached remote models after a provider rekey", async () => {
    const queryClient = new QueryClient();
    const discoveryKey = [
      "remoteModelDiscovery",
      { baseUrl: "https://api.example/v1", providerId: "provider-1" },
    ] as const;
    queryClient.setQueryData(discoveryKey, [{ id: "key-a-model" }]);

    await invalidateProviderQueries(queryClient);

    expect(queryClient.getQueryData(discoveryKey)).toBeUndefined();
  });
});

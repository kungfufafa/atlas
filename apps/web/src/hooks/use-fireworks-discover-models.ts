import type { CustomModelEntry } from "@atlas/core/contract";
import { queryOptions, useQuery } from "@tanstack/react-query";
import type { CapabilityBrowseRow } from "@/components/model-browse-utils";
import { client } from "@/lib/client";
import { queryKeys } from "@/lib/query-keys";

export function fireworksEntryToCapabilityRow(
  entry: CustomModelEntry
): CapabilityBrowseRow {
  return {
    ...entry,
    contextLength: entry.contextWindow,
    id: entry.id,
    name: entry.name?.trim() || entry.id,
    reasoning: entry.supportsThinking,
    tools:
      entry.capabilities?.["chat.tool-use"]?.status === "supported"
        ? true
        : undefined,
    vision: entry.supportsVision,
  };
}

async function fetchFireworksDiscoverRows(options: {
  providerId?: string;
  apiKey?: string;
}): Promise<{ rows: CapabilityBrowseRow[]; usedFallback: boolean }> {
  const providerId = options.providerId?.trim();
  const apiKey = options.apiKey?.trim() ?? "";

  const response = await client.discoverModels(
    providerId ? { providerId } : { apiKey, provider: "fireworks" }
  );
  const rows = (response.customModels ?? [])
    .map(fireworksEntryToCapabilityRow)
    .sort((left, right) => left.name.localeCompare(right.name));
  return { rows, usedFallback: false };
}

export function fireworksDiscoverQueryOptions(options: {
  providerId?: string;
  apiKey?: string;
}) {
  const providerId = options.providerId?.trim() ?? "";
  const apiKey = options.apiKey?.trim() ?? "";

  return queryOptions({
    enabled: Boolean(providerId || apiKey),
    queryFn: () => fetchFireworksDiscoverRows(options),
    queryKey: queryKeys.remoteModelDiscovery({
      apiKey: apiKey ? "set" : "",
      provider: "fireworks",
      providerId,
    }),
    staleTime: 1000 * 60 * 30,
  });
}

export function useFireworksDiscoverModels(options: {
  providerId?: string;
  apiKey?: string;
}) {
  return useQuery(fireworksDiscoverQueryOptions(options));
}

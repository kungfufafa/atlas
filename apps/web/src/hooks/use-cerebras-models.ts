import { queryOptions, useQuery } from "@tanstack/react-query";
import {
  type CerebrasModelRow,
  type CerebrasModelsApiResponse,
  normalizeCerebrasModels,
} from "@/lib/cerebras-models";
import { client } from "@/lib/client";
import { queryKeys } from "@/lib/query-keys";

async function fetchCerebrasModels(): Promise<{
  rows: CerebrasModelRow[];
  usedFallback: boolean;
}> {
  const data = (await client.getExternalModelCatalog(
    "cerebras"
  )) as CerebrasModelsApiResponse;
  return { rows: normalizeCerebrasModels(data), usedFallback: false };
}

export const cerebrasModelsQueryOptions = queryOptions({
  queryFn: fetchCerebrasModels,
  queryKey: queryKeys.cerebrasModels,
  staleTime: 1000 * 60 * 30,
});

export function useCerebrasModels() {
  return useQuery(cerebrasModelsQueryOptions);
}

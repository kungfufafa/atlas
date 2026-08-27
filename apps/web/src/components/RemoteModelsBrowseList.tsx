import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { CatalogModelsBrowseList } from "@/components/CatalogModelsBrowseList";
import {
  advanceCredentialRevision,
  type RemoteModelBrowseProvider,
  type RemoteModelRow,
  remoteModelEntryToRow,
  resolveRemoteModelBrowseReadiness,
} from "@/components/remote-models-browse.shared";
import { client } from "@/lib/client";
import { queryKeys } from "@/lib/query-keys";

export type { RemoteModelRow } from "@/components/remote-models-browse.shared";

export type RemoteBrowseSelectHandler = (row: RemoteModelRow) => void;

const EMPTY_ROWS: RemoteModelRow[] = [];

interface RemoteModelsBrowseListProps {
  apiKey?: string;
  baseUrl?: string;
  browseLabel?: string;
  className?: string;
  credentialRevision?: number;
  disabled?: boolean;
  hostMode?: "local" | "cloud";
  multiSelect?: boolean;
  onAddMany?: (rows: RemoteModelRow[]) => void;
  onSelect: RemoteBrowseSelectHandler;
  provider?: RemoteModelBrowseProvider;
  providerId?: string;
  selectedIds?: ReadonlySet<string>;
}

export function RemoteModelsBrowseList({
  onSelect,
  className,
  providerId,
  baseUrl,
  apiKey = "",
  provider,
  hostMode,
  browseLabel = "endpoint",
  selectedIds,
  multiSelect,
  onAddMany,
  credentialRevision: credentialRevisionOverride,
  disabled = false,
}: RemoteModelsBrowseListProps) {
  const [credentialState, setCredentialState] = useState({
    credential: apiKey,
    revision: 0,
  });
  if (credentialState.credential !== apiKey) {
    setCredentialState({
      credential: apiKey,
      revision: advanceCredentialRevision({
        currentCredential: credentialState.credential,
        nextCredential: apiKey,
        revision: credentialState.revision,
      }),
    });
  }
  const credentialRevision =
    credentialRevisionOverride ?? credentialState.revision;
  const trimmedBaseUrl = baseUrl?.trim() ?? "";
  const { canFetch, idleMessage } = resolveRemoteModelBrowseReadiness({
    apiKey,
    baseUrl: trimmedBaseUrl,
    provider,
    providerId,
  });

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    enabled: canFetch,
    queryFn: async ({ signal }) => {
      // When providerId is set, still forward baseUrl so Edit provider can probe a
      // typed (unsaved) URL while the server resolves stored credentials via id.
      const response = await client.discoverModels(
        providerId?.trim()
          ? {
              providerId: providerId.trim(),
              ...(trimmedBaseUrl ? { baseUrl: trimmedBaseUrl } : {}),
              ...(apiKey.trim() ? { apiKey } : {}),
              ...(provider ? { provider } : {}),
              ...(hostMode ? { hostMode } : {}),
            }
          : {
              apiKey,
              baseUrl: trimmedBaseUrl,
              ...(provider ? { provider } : {}),
              ...(hostMode ? { hostMode } : {}),
            },
        { signal }
      );

      return (response.customModels ?? response.models ?? []).map(
        remoteModelEntryToRow
      );
    },
    queryKey: queryKeys.remoteModelDiscovery({
      baseUrl: trimmedBaseUrl,
      credentialRevision,
      hostMode,
      provider,
      providerId,
    }),
    staleTime: 1000 * 30,
  });

  return (
    <CatalogModelsBrowseList<RemoteModelRow>
      className={className}
      disabled={disabled}
      emptyMessage={`No models found on this ${browseLabel}.`}
      idleMessage={idleMessage}
      multiSelect={multiSelect}
      onAddMany={onAddMany}
      onSelect={onSelect}
      query={{
        canFetch,
        error,
        isFetching,
        isLoading,
        onRefresh: () => void refetch(),
        refreshDisabled: isFetching,
      }}
      rows={data ?? EMPTY_ROWS}
      selectedIds={selectedIds}
      status={({ filteredCount }) =>
        canFetch
          ? `${filteredCount} model${filteredCount === 1 ? "" : "s"} from ${browseLabel}`
          : `Browse models from your ${browseLabel}`
      }
      toDisplayRow={(row) => ({
        capabilities: [
          ...(row.supportsThinking ? (["reasoning"] as const) : []),
          ...(row.supportsVision ? (["vision"] as const) : []),
        ],
        id: row.id,
        name: row.name,
      })}
    />
  );
}

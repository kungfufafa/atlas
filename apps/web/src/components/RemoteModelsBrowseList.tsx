import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { CatalogModelsBrowseList } from "@/components/CatalogModelsBrowseList";
import {
  advanceCredentialRevision,
  type RemoteModelBrowseProvider,
  resolveRemoteModelBrowseReadiness,
} from "@/components/remote-models-browse.shared";
import { client } from "@/lib/client";
import { queryKeys } from "@/lib/query-keys";

export interface RemoteModelRow {
  id: string;
  name: string;
  reasoningEffortValues?: string[];
  supportsThinking?: boolean;
  supportsVision?: boolean;
}

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
  const credentialStateRef = useRef({ credential: apiKey, revision: 0 });
  const localCredentialRevision = advanceCredentialRevision({
    currentCredential: credentialStateRef.current.credential,
    nextCredential: apiKey,
    revision: credentialStateRef.current.revision,
  });
  credentialStateRef.current = {
    credential: apiKey,
    revision: localCredentialRevision,
  };
  const credentialRevision =
    credentialRevisionOverride ?? localCredentialRevision;
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

      return (response.customModels ?? response.models ?? []).map((entry) => ({
        id: entry.id,
        name: entry.name?.trim() || entry.id,
        ...(entry.supportsThinking === undefined
          ? {}
          : { supportsThinking: entry.supportsThinking }),
        ...(entry.reasoningEffortValues?.length
          ? { reasoningEffortValues: entry.reasoningEffortValues }
          : {}),
        ...(entry.supportsVision === undefined
          ? {}
          : { supportsVision: entry.supportsVision }),
      }));
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

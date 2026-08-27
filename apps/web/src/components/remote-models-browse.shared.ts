import type {
  CustomModelEntry,
  DiscoverModelsRequest,
} from "@atlas/core/contract";

export interface RemoteModelRow {
  capabilities?: CustomModelEntry["capabilities"];
  id: string;
  name: string;
  reasoningEffortValues?: string[];
  supportsThinking?: boolean;
  supportsVision?: boolean;
}

export type RemoteModelBrowseProvider = Exclude<
  DiscoverModelsRequest["provider"],
  "fireworks" | "opencode_go" | undefined
>;

export function remoteModelEntryToRow(entry: CustomModelEntry): RemoteModelRow {
  return {
    id: entry.id,
    name: entry.name?.trim() || entry.id,
    ...(entry.capabilities === undefined
      ? {}
      : { capabilities: entry.capabilities }),
    ...(entry.supportsThinking === undefined
      ? {}
      : { supportsThinking: entry.supportsThinking }),
    ...(entry.reasoningEffortValues?.length
      ? { reasoningEffortValues: entry.reasoningEffortValues }
      : {}),
    ...(entry.supportsVision === undefined
      ? {}
      : { supportsVision: entry.supportsVision }),
  };
}

export function remoteModelRowToCustomModelEntry(
  row: RemoteModelRow
): CustomModelEntry {
  return {
    id: row.id,
    name: row.name,
    ...(row.capabilities === undefined
      ? {}
      : { capabilities: row.capabilities }),
    ...(row.supportsThinking === undefined
      ? {}
      : { supportsThinking: row.supportsThinking }),
    ...(row.reasoningEffortValues?.length
      ? { reasoningEffortValues: row.reasoningEffortValues }
      : {}),
    ...(row.supportsVision === undefined
      ? {}
      : { supportsVision: row.supportsVision }),
  };
}

export function advanceCredentialRevision(options: {
  currentCredential: string;
  nextCredential: string;
  revision: number;
}): number {
  return options.currentCredential === options.nextCredential
    ? options.revision
    : options.revision + 1;
}

export function resolveRemoteModelBrowseReadiness(options: {
  apiKey?: string;
  baseUrl?: string;
  provider?: RemoteModelBrowseProvider;
  providerId?: string;
}): { canFetch: boolean; idleMessage: string } {
  const hasStoredProvider = Boolean(options.providerId?.trim());
  const directProviderRequiresApiKey =
    !hasStoredProvider &&
    options.provider !== undefined &&
    options.provider !== "ollama" &&
    options.provider !== "openai_compatible";
  const canFetch = Boolean(
    hasStoredProvider ||
      (options.baseUrl?.trim() &&
        (!directProviderRequiresApiKey || Boolean(options.apiKey?.trim())))
  );
  const idleMessage =
    directProviderRequiresApiKey && !options.apiKey?.trim()
      ? "Enter an API key before browsing models."
      : "Enter a base URL before browsing models.";

  return { canFetch, idleMessage };
}

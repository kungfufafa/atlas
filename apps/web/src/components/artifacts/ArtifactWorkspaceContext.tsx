import type { ArtifactPreview, PreviewOptions } from "@atlas/core";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { client } from "@/lib/client";

export interface WorkspaceArtifactTarget {
  artifactId?: string;
  filename: string;
  mimeType?: string;
  path: string;
  profileId: string;
  revision?: number;
  sizeBytes?: number;
}

interface ArtifactWorkspaceContextValue {
  activeArtifact: WorkspaceArtifactTarget | null;
  activeOptions: PreviewOptions;
  activePreview: ArtifactPreview | null;
  closeArtifact: () => void;
  error: string | null;
  isOpen: boolean;
  loading: boolean;
  openArtifact: (
    artifact: {
      artifactId?: string;
      filename: string;
      mimeType?: string;
      path?: string;
      profileId?: string;
      revision?: number;
      sizeBytes?: number;
    },
    profileId?: string,
    initialOptions?: PreviewOptions
  ) => void;
  refreshPreview: () => Promise<void>;
  setOptions: (opts: Partial<PreviewOptions>) => void;
  setRevision: (revision: number) => void;
  setSheet: (sheetName: string, sheetIndex?: number) => void;
}

const ArtifactWorkspaceContext =
  createContext<ArtifactWorkspaceContextValue | null>(null);

export function ArtifactWorkspaceProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [activeArtifact, setActiveArtifact] =
    useState<WorkspaceArtifactTarget | null>(null);
  const [activeOptions, setActiveOptions] = useState<PreviewOptions>({});
  const [activePreview, setActivePreview] = useState<ArtifactPreview | null>(
    null
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchPreview = useCallback(
    async (target: WorkspaceArtifactTarget, options: PreviewOptions) => {
      setLoading(true);
      setError(null);
      try {
        let preview: ArtifactPreview;
        if (target.artifactId) {
          preview = await client.getArtifactPreview(target.artifactId, options);
        } else {
          preview = await client.getProfileArtifactPreview(
            target.profileId,
            target.path || target.filename,
            options
          );
        }
        setActivePreview(preview);
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : "Failed to generate artifact preview.";
        setError(msg);
        setActivePreview(null);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const openArtifact = useCallback(
    (
      artifact: {
        artifactId?: string;
        filename: string;
        mimeType?: string;
        path?: string;
        profileId?: string;
        revision?: number;
        sizeBytes?: number;
      },
      profileIdFallback?: string,
      initialOptions: PreviewOptions = {}
    ) => {
      const resolvedProfileId =
        artifact.profileId || profileIdFallback || "default";
      const resolvedPath = artifact.path || artifact.filename;
      const target: WorkspaceArtifactTarget = {
        artifactId: artifact.artifactId,
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        path: resolvedPath,
        profileId: resolvedProfileId,
        revision: artifact.revision,
        sizeBytes: artifact.sizeBytes,
      };

      setActiveArtifact(target);
      setActiveOptions(initialOptions);
      void fetchPreview(target, initialOptions);
    },
    [fetchPreview]
  );

  const closeArtifact = useCallback(() => {
    setActiveArtifact(null);
    setActivePreview(null);
    setError(null);
    setActiveOptions({});
  }, []);

  const setOptions = useCallback(
    (opts: Partial<PreviewOptions>) => {
      if (!activeArtifact) {
        return;
      }
      const newOpts = { ...activeOptions, ...opts };
      setActiveOptions(newOpts);
      void fetchPreview(activeArtifact, newOpts);
    },
    [activeArtifact, activeOptions, fetchPreview]
  );

  const setRevision = useCallback(
    (revision: number) => {
      setOptions({ revision });
    },
    [setOptions]
  );

  const setSheet = useCallback(
    (sheetName: string, sheetIndex?: number) => {
      setOptions({ sheet: sheetName, sheetIndex });
    },
    [setOptions]
  );

  const refreshPreview = useCallback(async () => {
    if (!activeArtifact) {
      return;
    }
    await fetchPreview(activeArtifact, {
      ...activeOptions,
      forceRegenerate: true,
    });
  }, [activeArtifact, activeOptions, fetchPreview]);

  const value = useMemo(
    () => ({
      activeArtifact,
      activeOptions,
      activePreview,
      closeArtifact,
      error,
      isOpen: Boolean(activeArtifact),
      loading,
      openArtifact,
      refreshPreview,
      setOptions,
      setRevision,
      setSheet,
    }),
    [
      activeArtifact,
      activeOptions,
      activePreview,
      closeArtifact,
      error,
      loading,
      openArtifact,
      refreshPreview,
      setOptions,
      setRevision,
      setSheet,
    ]
  );

  return (
    <ArtifactWorkspaceContext.Provider value={value}>
      {children}
    </ArtifactWorkspaceContext.Provider>
  );
}

export function useArtifactWorkspace(): ArtifactWorkspaceContextValue {
  const ctx = useContext(ArtifactWorkspaceContext);
  if (!ctx) {
    throw new Error(
      "useArtifactWorkspace must be used within ArtifactWorkspaceProvider"
    );
  }
  return ctx;
}

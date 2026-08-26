import type { EditableArtifactResponse } from "@atlas/core";
import { AtlasApiError } from "@atlas/core/api-error";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  cloneEditableRows,
  createArtifactEditOperationGate,
} from "@/lib/artifact-editing";
import { client, formatError } from "@/lib/client";

export interface ArtifactEditDraft {
  content: string;
  rows: string[][];
  source: EditableArtifactResponse;
}

export function useArtifactEditor(input: {
  artifactPath: string;
  profileId: string;
  onSaved: () => Promise<void>;
}) {
  const { artifactPath, onSaved, profileId } = input;
  const operationGate = useRef(createArtifactEditOperationGate());
  const artifactKey = `${profileId}\u0000${artifactPath}`;
  const artifactKeyRef = useRef(artifactKey);
  if (artifactKeyRef.current !== artifactKey) {
    artifactKeyRef.current = artifactKey;
    operationGate.current.invalidate();
  }
  const [draft, setDraft] = useState<ArtifactEditDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(
    null
  );

  useEffect(
    () => () => {
      operationGate.current.invalidate();
    },
    []
  );

  useEffect(() => {
    setDraft(null);
    setError(null);
    setLoading(false);
    setSaving(false);
    setUnavailableReason(null);
  }, [artifactPath, profileId]);

  const start = useCallback(async () => {
    const currentOperation = operationGate.current.begin();
    setLoading(true);
    setError(null);
    try {
      const source = await client.getEditableProfileArtifact(
        profileId,
        artifactPath
      );
      if (!operationGate.current.isCurrent(currentOperation)) {
        return;
      }
      if (!source.editable || source.truncated) {
        setUnavailableReason(
          source.reason ?? "This artifact cannot be edited in the dashboard."
        );
        return;
      }
      setUnavailableReason(null);
      setDraft({
        content: source.content ?? "",
        rows: cloneEditableRows(source.rows),
        source,
      });
    } catch (loadError) {
      if (operationGate.current.isCurrent(currentOperation)) {
        setError(formatError(loadError));
      }
    } finally {
      if (operationGate.current.isCurrent(currentOperation)) {
        setLoading(false);
      }
    }
  }, [artifactPath, profileId]);

  const cancel = useCallback(() => {
    if (saving) {
      return;
    }
    operationGate.current.invalidate();
    setDraft(null);
    setError(null);
  }, [saving]);

  const save = useCallback(async () => {
    if (!draft) {
      return;
    }
    const saveOperation = operationGate.current.current();
    const savedDraft = draft;
    setSaving(true);
    setError(null);
    try {
      await client.updateEditableProfileArtifact(
        profileId,
        artifactPath,
        draft.source.kind === "markdown"
          ? {
              content: draft.content,
              expectedHash: draft.source.expectedHash,
            }
          : {
              expectedHash: draft.source.expectedHash,
              rows: draft.rows,
            }
      );
      if (!operationGate.current.isCurrent(saveOperation)) {
        return;
      }
      setDraft((current) => (current === savedDraft ? null : current));
      await onSaved();
    } catch (saveError) {
      if (operationGate.current.isCurrent(saveOperation)) {
        setError(
          saveError instanceof AtlasApiError && saveError.status === 409
            ? "This artifact changed after you opened it. Your draft is still here; cancel and reopen before saving again."
            : formatError(saveError)
        );
      }
    } finally {
      if (operationGate.current.isCurrent(saveOperation)) {
        setSaving(false);
      }
    }
  }, [artifactPath, draft, onSaved, profileId]);

  const setContent = useCallback((content: string) => {
    setError(null);
    setDraft((current) => (current ? { ...current, content } : current));
  }, []);

  const setRows = useCallback((rows: string[][]) => {
    setError(null);
    setDraft((current) => (current ? { ...current, rows } : current));
  }, []);

  return {
    cancel,
    draft,
    error,
    loading,
    save,
    saving,
    setContent,
    setRows,
    start,
    unavailableReason,
  };
}

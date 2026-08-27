import type { EditableArtifactResponse } from "@atlas/core";
import { AtlasApiError } from "@atlas/core/api-error";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ArtifactEditOperationGate,
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
  onSavingChange?: (saving: boolean) => void;
}) {
  const { artifactPath, onSaved, profileId, onSavingChange } = input;
  const operationGateRef = useRef<ArtifactEditOperationGate | null>(null);
  if (operationGateRef.current === null) {
    operationGateRef.current = createArtifactEditOperationGate();
  }
  const operationGate = operationGateRef.current;
  const [draft, setDraft] = useState<ArtifactEditDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [unavailableReason, setUnavailableReason] = useState<string | null>(
    null
  );

  useEffect(
    () => () => {
      operationGate.invalidate();
    },
    [operationGate]
  );

  const start = useCallback(async () => {
    const currentOperation = operationGate.begin();
    setLoading(true);
    setError(null);
    try {
      const source = await client.getEditableProfileArtifact(
        profileId,
        artifactPath
      );
      if (!operationGate.isCurrent(currentOperation)) {
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
      if (operationGate.isCurrent(currentOperation)) {
        setError(formatError(loadError));
      }
    } finally {
      setLoading((current) =>
        operationGate.isCurrent(currentOperation) ? false : current
      );
    }
  }, [artifactPath, operationGate, profileId]);

  const cancel = useCallback(() => {
    if (saving) {
      return;
    }
    operationGate.invalidate();
    setDraft(null);
    setError(null);
  }, [operationGate, saving]);

  const save = useCallback(async () => {
    if (!draft) {
      return;
    }
    const saveOperation = operationGate.current();
    const savedDraft = draft;
    setSaving(true);
    onSavingChange?.(true);
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
      if (!operationGate.isCurrent(saveOperation)) {
        return;
      }
      setDraft((current) => (current === savedDraft ? null : current));
      await onSaved();
    } catch (saveError) {
      if (operationGate.isCurrent(saveOperation)) {
        setError(
          saveError instanceof AtlasApiError && saveError.status === 409
            ? "This artifact changed after you opened it. Your draft is still here; cancel and reopen before saving again."
            : formatError(saveError)
        );
      }
    } finally {
      const isCurrent = operationGate.isCurrent(saveOperation);
      setSaving((current) => (isCurrent ? false : current));
      if (isCurrent) {
        onSavingChange?.(false);
      }
    }
  }, [artifactPath, draft, onSaved, onSavingChange, operationGate, profileId]);

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

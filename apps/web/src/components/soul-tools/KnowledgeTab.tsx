import type { KnowledgeBaseDocument } from "@atlas/core/contract";
import { useEffect, useRef, useState } from "react";
import { KnowledgeTabPanel } from "@/components/soul-tools/knowledge-tab-panel";
import {
  formatKnowledgeBaseDuplicatePrompt,
  type KnowledgeBaseDuplicateContext,
  type KnowledgeBaseDuplicateDecision,
  type PreparedKnowledgeBaseUpload,
  uploadPreparedKnowledgeBaseDocuments,
} from "@/components/soul-tools/knowledge-upload.shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useProfilesQuery } from "@/hooks/use-app-queries";
import {
  useDeleteKnowledgeBaseDocumentMutation,
  useKnowledgeBaseQuery,
  useUploadKnowledgeBaseDocumentMutation,
} from "@/hooks/use-resource-mutations";
import { formatError } from "@/lib/client";
import {
  fileToDocumentAttachment,
  isKnowledgeBaseFile,
} from "@/lib/knowledge-base-files";

type DuplicatePrompt = KnowledgeBaseDuplicateContext & {
  profileId: string;
};

type DuplicateResolver = {
  profileId: string;
  resolve: (decision: KnowledgeBaseDuplicateDecision) => void;
};

export function KnowledgeTab({ profileId }: { profileId: string | null }) {
  const { data: profiles = [], error: profilesError } = useProfilesQuery();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const duplicateResolverRef = useRef<DuplicateResolver | null>(null);
  const profileIdRef = useRef(profileId);
  profileIdRef.current = profileId;
  const {
    data: knowledgeBase = null,
    isLoading: knowledgeLoading,
    error: knowledgeError,
  } = useKnowledgeBaseQuery(profileId);
  const uploadMutation = useUploadKnowledgeBaseDocumentMutation();
  const deleteMutation = useDeleteKnowledgeBaseDocumentMutation();
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] =
    useState<KnowledgeBaseDocument | null>(null);
  const [duplicatePrompt, setDuplicatePrompt] =
    useState<DuplicatePrompt | null>(null);

  const selectedProfile =
    profiles.find((profile) => profile.id === profileId) ?? null;
  const documents = knowledgeBase?.documents ?? [];
  const sources = knowledgeBase?.sources ?? [];
  const readyCount = documents.filter(
    (document) => document.status === "ready"
  ).length;
  const loading = knowledgeLoading && !knowledgeBase;
  const activeDuplicatePrompt =
    duplicatePrompt?.profileId === profileId ? duplicatePrompt : null;
  const busy =
    uploadMutation.isPending ||
    deleteMutation.isPending ||
    activeDuplicatePrompt !== null;

  useEffect(() => {
    const queryError = profilesError ?? knowledgeError;
    if (queryError) {
      setError(formatError(queryError));
    }
  }, [profilesError, knowledgeError]);

  useEffect(
    () => () => {
      const pending = duplicateResolverRef.current;
      if (pending?.profileId === profileId) {
        duplicateResolverRef.current = null;
        setDuplicatePrompt((current) =>
          current?.profileId === profileId ? null : current
        );
        pending.resolve("cancel");
      }
    },
    [profileId]
  );

  function askDuplicateDecision(
    context: KnowledgeBaseDuplicateContext,
    uploadProfileId: string
  ): Promise<KnowledgeBaseDuplicateDecision> {
    if (profileIdRef.current !== uploadProfileId) {
      return Promise.resolve("cancel");
    }

    return new Promise((resolve) => {
      duplicateResolverRef.current?.resolve("cancel");
      duplicateResolverRef.current = { profileId: uploadProfileId, resolve };
      setDuplicatePrompt({ ...context, profileId: uploadProfileId });
    });
  }

  function settleDuplicatePrompt(
    decision: KnowledgeBaseDuplicateDecision
  ): void {
    const pending = duplicateResolverRef.current;
    duplicateResolverRef.current = null;
    setDuplicatePrompt(null);
    pending?.resolve(decision);
  }

  async function handleUpload(files: FileList | null) {
    if (!(profileId && files?.length)) {
      return;
    }

    setError(null);
    const uploadProfileId = profileId;

    try {
      const prepared: PreparedKnowledgeBaseUpload[] = [];
      for (const file of Array.from(files)) {
        if (!isKnowledgeBaseFile(file)) {
          setError(
            `Unsupported file type: ${file.name}. Allowed: txt, md, csv, pdf.`
          );
          continue;
        }

        const document = await fileToDocumentAttachment(file);
        if (!document) {
          setError(`Failed to read file: ${file.name}`);
          continue;
        }
        prepared.push({ document, filename: file.name });
      }

      await uploadPreparedKnowledgeBaseDocuments(prepared, {
        decideDuplicate: (context) =>
          askDuplicateDecision(context, uploadProfileId),
        isCancelled: () => profileIdRef.current !== uploadProfileId,
        upload: (item, onDuplicate) =>
          uploadMutation.mutateAsync({
            document: item.document,
            onDuplicate,
            profileId: uploadProfileId,
          }),
      });
    } catch (err) {
      setError(formatError(err));
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }

  async function handleDelete() {
    if (!(profileId && deleteTarget)) {
      return;
    }

    setError(null);

    try {
      await deleteMutation.mutateAsync({
        documentId: deleteTarget.id,
        profileId,
      });
      setDeleteTarget(null);
    } catch (err) {
      setError(formatError(err));
    }
  }

  if (!profileId) {
    return (
      <p className="text-muted-foreground text-sm">
        Select a profile to manage knowledge base documents.
      </p>
    );
  }

  if (loading && !knowledgeBase) {
    return (
      <div className="flex min-h-48 flex-col items-center justify-center gap-3 text-muted-foreground text-sm">
        <Spinner className="size-5" />
        Loading knowledge base…
      </div>
    );
  }

  return (
    <>
      {error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-destructive text-sm">
          {error}
        </p>
      ) : null}

      <KnowledgeTabPanel
        busy={busy}
        documents={documents}
        fileInputRef={fileInputRef}
        onDeleteDocument={setDeleteTarget}
        onUpload={(files) => void handleUpload(files)}
        profileId={profileId}
        readyCount={readyCount}
        sources={sources}
        uploadPending={uploadMutation.isPending}
      />

      <Dialog
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        open={deleteTarget !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete document</DialogTitle>
            <DialogDescription>
              Remove {deleteTarget?.filename} from{" "}
              {selectedProfile?.name ?? "this profile"}?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => setDeleteTarget(null)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={deleteMutation.isPending}
              onClick={() => void handleDelete()}
              type="button"
              variant="destructive"
            >
              {deleteMutation.isPending ? <Spinner className="size-4" /> : null}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        onOpenChange={(open) => {
          if (!open && activeDuplicatePrompt) {
            settleDuplicatePrompt("skip");
          }
        }}
        open={activeDuplicatePrompt !== null}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Document already exists</DialogTitle>
            <DialogDescription>
              {activeDuplicatePrompt
                ? formatKnowledgeBaseDuplicatePrompt(activeDuplicatePrompt)
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              onClick={() => settleDuplicatePrompt("skip")}
              type="button"
              variant="outline"
            >
              Skip
            </Button>
            <Button
              onClick={() => settleDuplicatePrompt("replace")}
              type="button"
              variant="destructive"
            >
              Replace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

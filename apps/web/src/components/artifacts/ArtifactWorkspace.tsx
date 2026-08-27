import type { ArtifactPreview } from "@atlas/core";
import {
  ARTIFACT_EDIT_MAX_COLUMNS,
  ARTIFACT_EDIT_MAX_ROWS,
} from "@atlas/core/artifact-editing-limits";
import {
  Cancel01Icon,
  Copy01Icon,
  Download01Icon,
  FloppyDiskIcon,
  Maximize01Icon,
  Minimize01Icon,
  PencilEdit01Icon,
} from "hugeicons-react";
import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  type ArtifactPreviewMode,
  ArtifactPreviewModeToggle,
} from "@/components/artifacts/ArtifactPreviewModeToggle";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAuth } from "@/context/use-auth";
import {
  artifactPreviewCanCopy,
  artifactPreviewUsesFetchedSource,
  artifactSupportsPreviewCodeToggle,
} from "@/lib/artifact-canvas";
import {
  addEditableColumn,
  addEditableRow,
  isEditableArtifactFilename,
  knownArtifactEditLimitReason,
  updateEditableCell,
} from "@/lib/artifact-editing";
import {
  isMermaidArtifactFilename,
  markdownForMermaidSource,
  mermaidPreviewError,
} from "@/lib/artifact-mermaid-preview";
import { client } from "@/lib/client";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/lib/query-keys";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import {
  useArtifactWorkspace,
  type WorkspaceArtifactTarget,
} from "./ArtifactWorkspaceContext";
import { useArtifactEditor } from "./use-artifact-editor";
import { CodeViewer } from "./viewers/CodeViewer";
import { DocumentViewer } from "./viewers/DocumentViewer";
import { GenericViewer } from "./viewers/GenericViewer";
import { HtmlViewer } from "./viewers/HtmlViewer";
import { ImageViewer } from "./viewers/ImageViewer";
import { JsonViewer } from "./viewers/JsonViewer";
import { MarkdownViewer } from "./viewers/MarkdownViewer";
import { PdfViewer } from "./viewers/PdfViewer";
import { PresentationViewer } from "./viewers/PresentationViewer";
import { SpreadsheetViewer } from "./viewers/SpreadsheetViewer";

export function ArtifactWorkspace() {
  const { isOpen, activeArtifact } = useArtifactWorkspace();
  if (!(isOpen && activeArtifact)) {
    return null;
  }

  return (
    <ArtifactWorkspaceSession
      key={`${activeArtifact.profileId}\u0000${activeArtifact.path}`}
    />
  );
}

function ArtifactWorkspaceSession() {
  const {
    activeArtifact,
    activePreview,
    loading,
    error,
    closeArtifact,
    refreshPreview,
    setRevision,
    setSheet,
  } = useArtifactWorkspace();
  const { activeOrg, user } = useAuth();
  const dialogRef = useRef<HTMLDialogElement>(null);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [previewMode, setPreviewMode] =
    useState<ArtifactPreviewMode>("preview");
  const [copied, setCopied] = useState(false);

  const artifactPath = activeArtifact?.path ?? "";
  const artifactProfileId = activeArtifact?.profileId ?? "";
  const handleArtifactSaved = useCallback(async () => {
    if (!activeArtifact) {
      return;
    }
    await Promise.all([
      refreshPreview(),
      queryClient.invalidateQueries({
        queryKey: queryKeys.artifacts.profile(activeArtifact.profileId),
      }),
    ]);
    toast("Artifact saved.");
  }, [activeArtifact, refreshPreview]);
  const editor = useArtifactEditor({
    artifactPath,
    onSaved: handleArtifactSaved,
    profileId: artifactProfileId,
  });
  useShowModal(dialogRef);

  if (!activeArtifact) {
    return null;
  }

  const artifact = activeArtifact;
  const downloadUrl = artifact.artifactId
    ? client.getArtifactDownloadUrl(artifact.artifactId)
    : client.getProfileArtifactDownloadUrl(artifact.profileId, artifact.path);

  const revision = activePreview?.revision ?? activeArtifact.revision ?? 1;
  const showModeToggle = artifactSupportsPreviewCodeToggle(
    artifact.filename,
    artifact.mimeType ?? ""
  );
  const isWorkspaceAdmin =
    activeOrg?.role === "admin" || user?.isPlatformAdmin === true;
  const supportsEditing = isEditableArtifactFilename(artifact.filename);
  const isLatestRevision =
    !activeArtifact.revision || revision === activeArtifact.revision;
  const knownEditLimitReason = knownArtifactEditLimitReason(
    activeArtifact.sizeBytes
  );
  const canOfferEditing =
    isWorkspaceAdmin && supportsEditing && isLatestRevision;
  const editDisabledReason =
    knownEditLimitReason ?? editor.unavailableReason ?? null;

  const canCopy = artifactPreviewCanCopy(activePreview);

  async function handleCopy() {
    const text = await readWorkspacePreviewText(activePreview, downloadUrl);
    if (!text) {
      return;
    }
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <dialog
      aria-labelledby="artifact-workspace-title"
      className="fixed inset-0 z-50 m-0 flex h-dvh max-h-none w-dvw max-w-none items-center justify-center border-0 bg-transparent p-0 backdrop:bg-black/50 open:flex sm:p-4"
      onCancel={(event) => {
        event.preventDefault();
        if (editor.saving) {
          return;
        }
        if (editor.draft) {
          editor.cancel();
        } else {
          closeArtifact();
        }
      }}
      ref={dialogRef}
    >
      <div
        className={cn(
          "flex w-full flex-col overflow-hidden bg-background shadow-2xl",
          isFullscreen
            ? "fixed inset-0 h-full w-full"
            : "h-full max-h-[92vh] max-w-6xl rounded-none border border-border sm:rounded-xl"
        )}
      >
        <header className="flex h-11 shrink-0 items-center gap-2 border-border border-b px-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <h3
              className="truncate font-medium text-sm"
              id="artifact-workspace-title"
            >
              {activeArtifact.filename}
            </h3>
            {activeArtifact.revision && activeArtifact.revision > 1 ? (
              <div className="flex items-center rounded-md bg-muted p-0.5">
                {Array.from(
                  { length: activeArtifact.revision },
                  (_, i) => i + 1
                ).map((rev) => (
                  <button
                    className={cn(
                      "rounded px-1.5 py-0.5 font-medium text-2xs",
                      revision === rev
                        ? "bg-background text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground",
                      "disabled:cursor-not-allowed disabled:opacity-50"
                    )}
                    disabled={
                      Boolean(editor.draft) || editor.loading || editor.saving
                    }
                    key={rev}
                    onClick={() => setRevision(rev)}
                    type="button"
                  >
                    v{rev}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {showModeToggle && !editor.draft ? (
            <ArtifactPreviewModeToggle
              mode={previewMode}
              onChange={setPreviewMode}
            />
          ) : null}

          <div className="flex shrink-0 items-center">
            {canOfferEditing && editor.draft ? (
              <>
                <Button
                  disabled={editor.saving}
                  onClick={() => void editor.save()}
                  size="sm"
                  type="button"
                >
                  {editor.saving ? (
                    <Spinner className="size-3.5" />
                  ) : (
                    <FloppyDiskIcon className="size-3.5" />
                  )}
                  Save
                </Button>
                <Button
                  disabled={editor.saving}
                  onClick={editor.cancel}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Cancel
                </Button>
              </>
            ) : canOfferEditing ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label="Edit artifact"
                      disabled={
                        editor.loading || Boolean(editDisabledReason) || loading
                      }
                      onClick={() => void editor.start()}
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      {editor.loading ? (
                        <Spinner className="size-4" />
                      ) : (
                        <PencilEdit01Icon className="size-4" />
                      )}
                    </Button>
                  }
                />
                <TooltipContent side="bottom" sideOffset={6}>
                  {editDisabledReason ?? "Edit artifact"}
                </TooltipContent>
              </Tooltip>
            ) : null}

            {canCopy && !editor.draft ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label={copied ? "Copied" : "Copy"}
                      onClick={() => void handleCopy()}
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      <Copy01Icon className="size-4" />
                    </Button>
                  }
                />
                <TooltipContent side="bottom" sideOffset={6}>
                  {copied ? "Copied" : "Copy"}
                </TooltipContent>
              </Tooltip>
            ) : null}

            <Tooltip>
              <TooltipTrigger
                render={
                  <a
                    aria-label="Download"
                    className={cn(
                      buttonVariants({ size: "icon-sm", variant: "ghost" })
                    )}
                    download={activeArtifact.filename}
                    href={downloadUrl}
                    rel="noopener"
                  >
                    <Download01Icon className="size-4" />
                  </a>
                }
              />
              <TooltipContent side="bottom" sideOffset={6}>
                Download
              </TooltipContent>
            </Tooltip>

            <Button
              aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              onClick={() => setIsFullscreen((v) => !v)}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              {isFullscreen ? (
                <Minimize01Icon className="size-4" />
              ) : (
                <Maximize01Icon className="size-4" />
              )}
            </Button>

            <Button
              aria-label="Close"
              disabled={editor.saving}
              onClick={closeArtifact}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <Cancel01Icon className="size-4" />
            </Button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {editor.error || editor.unavailableReason ? (
            <div
              className="border-destructive/30 border-b bg-destructive/5 px-4 py-2 text-destructive text-sm"
              role="alert"
            >
              {editor.error ?? editor.unavailableReason}
            </div>
          ) : null}
          <ArtifactWorkspaceViewer
            activeArtifact={artifact}
            activePreview={activePreview}
            downloadUrl={downloadUrl}
            editor={editor}
            error={error}
            loading={loading}
            onRetry={() => void refreshPreview()}
            onSelectSheet={setSheet}
            previewMode={previewMode}
          />
        </div>
      </div>
    </dialog>
  );
}

function useShowModal(dialogRef: RefObject<HTMLDialogElement | null>) {
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (!dialog.open) {
      dialog.showModal();
    }
    return () => {
      if (dialog.open) {
        dialog.close();
      }
    };
  }, [dialogRef]);
}

async function readWorkspacePreviewText(
  activePreview: ArtifactPreview | null,
  downloadUrl: string
): Promise<string | null> {
  if (!activePreview) {
    return null;
  }
  let text: string | null = null;
  if (artifactPreviewUsesFetchedSource(activePreview)) {
    try {
      const response = await fetch(downloadUrl, { credentials: "include" });
      if (response.ok) {
        text = await response.text();
      }
    } catch {
      text = null;
    }
    if (!text && "safeHtml" in activePreview) {
      text = activePreview.safeHtml;
    }
  } else if ("content" in activePreview) {
    text = activePreview.content;
  } else if ("formatted" in activePreview) {
    text = activePreview.formatted;
  }
  return text;
}

function ArtifactWorkspaceViewer({
  activeArtifact,
  activePreview,
  downloadUrl,
  editor,
  error,
  loading,
  onRetry,
  onSelectSheet,
  previewMode,
}: {
  activeArtifact: WorkspaceArtifactTarget;
  activePreview: ArtifactPreview | null;
  downloadUrl: string;
  editor: ReturnType<typeof useArtifactEditor>;
  error: string | null;
  loading: boolean;
  onRetry: () => void;
  onSelectSheet: (sheetName: string, sheetIndex?: number) => void;
  previewMode: ArtifactPreviewMode;
}) {
  if (loading) {
    return (
      <div className="flex h-full w-full items-center justify-center text-muted-foreground">
        <Spinner className="size-5" />
      </div>
    );
  }

  if (error || !activePreview || activePreview.status === "failed") {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="max-w-md text-muted-foreground text-sm">
          {activePreview?.error || error || "This file couldn't be previewed."}
        </p>
        <div className="flex items-center gap-2">
          <Button onClick={onRetry} size="sm" type="button" variant="outline">
            Try again
          </Button>
          <a
            className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
            download={activeArtifact.filename}
            href={downloadUrl}
          >
            Download
          </a>
        </div>
      </div>
    );
  }

  switch (activePreview.type) {
    case "pdf":
      return <PdfViewer downloadUrl={downloadUrl} preview={activePreview} />;
    case "spreadsheet":
      return (
        <SpreadsheetViewer
          downloadUrl={downloadUrl}
          editor={
            editor.draft?.source.kind === "delimited"
              ? {
                  canAddColumn:
                    Math.max(0, ...editor.draft.rows.map((row) => row.length)) <
                    ARTIFACT_EDIT_MAX_COLUMNS,
                  canAddRow: editor.draft.rows.length < ARTIFACT_EDIT_MAX_ROWS,
                  disabled: editor.saving,
                  onAddColumn: () =>
                    editor.setRows(addEditableColumn(editor.draft.rows)),
                  onAddRow: () =>
                    editor.setRows(addEditableRow(editor.draft.rows)),
                  onChangeCell: (rowIndex, columnIndex, value) =>
                    editor.setRows(
                      updateEditableCell(
                        editor.draft.rows,
                        rowIndex,
                        columnIndex,
                        value
                      )
                    ),
                  rows: editor.draft.rows,
                }
              : undefined
          }
          onSelectSheet={onSelectSheet}
          preview={activePreview}
        />
      );
    case "presentation":
      return (
        <PresentationViewer downloadUrl={downloadUrl} preview={activePreview} />
      );
    case "document":
      return (
        <DocumentViewer downloadUrl={downloadUrl} preview={activePreview} />
      );
    case "markdown":
      return (
        <MarkdownViewer
          downloadUrl={downloadUrl}
          editor={
            editor.draft?.source.kind === "markdown"
              ? {
                  content: editor.draft.content,
                  disabled: editor.saving,
                  onChange: editor.setContent,
                }
              : undefined
          }
          preview={activePreview}
        />
      );
    case "code":
    case "text": {
      if (isMermaidArtifactFilename(activeArtifact.filename)) {
        const source = activePreview.content;
        if (previewMode === "code") {
          return (
            <CodeViewer
              downloadUrl={downloadUrl}
              preview={{
                ...activePreview,
                language: "mermaid",
                type: "code",
              }}
            />
          );
        }
        const mermaidError = mermaidPreviewError(source);
        return (
          <MarkdownViewer
            downloadUrl={downloadUrl}
            preview={{
              ...activePreview,
              content: mermaidError
                ? mermaidError
                : markdownForMermaidSource(source),
              type: "markdown",
              wordCount: source.trim().split(/\s+/).filter(Boolean).length,
            }}
          />
        );
      }
      if (activePreview.type === "code") {
        return <CodeViewer downloadUrl={downloadUrl} preview={activePreview} />;
      }
      return (
        <CodeViewer
          downloadUrl={downloadUrl}
          preview={{
            ...activePreview,
            language: "text",
            type: "code",
          }}
        />
      );
    }
    case "json":
      return <JsonViewer downloadUrl={downloadUrl} preview={activePreview} />;
    case "image":
      return (
        <ImageViewer
          downloadUrl={downloadUrl}
          mode={previewMode}
          preview={activePreview}
        />
      );
    case "html":
      return (
        <HtmlViewer
          downloadUrl={downloadUrl}
          mode={previewMode}
          preview={activePreview}
        />
      );
    default:
      return (
        <GenericViewer downloadUrl={downloadUrl} preview={activePreview} />
      );
  }
}

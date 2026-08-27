import type { ArtifactPreview } from "@atlas/core";
import {
  ARTIFACT_EDIT_MAX_COLUMNS,
  ARTIFACT_EDIT_MAX_ROWS,
} from "@atlas/core/artifact-editing-limits";
import type { ArtifactFile } from "@atlas/core/contract";
import {
  Cancel01Icon,
  Download01Icon,
  FloppyDiskIcon,
  PencilEdit01Icon,
} from "hugeicons-react";
import { useCallback, useEffect, useState } from "react";
import { ArtifactCodeCanvas } from "@/components/artifacts/ArtifactCodeCanvas";
import {
  type ArtifactPreviewMode,
  ArtifactPreviewModeToggle,
} from "@/components/artifacts/ArtifactPreviewModeToggle";
import { HtmlPreviewFrame } from "@/components/artifacts/HtmlPreviewFrame";
import { SafeMarkdownPreview } from "@/components/artifacts/SafeMarkdownPreview";
import { SvgPreview } from "@/components/artifacts/SvgPreview";
import {
  type ArtifactEditDraft,
  useArtifactEditor,
} from "@/components/artifacts/use-artifact-editor";
import { DocumentViewer } from "@/components/artifacts/viewers/DocumentViewer";
import { MarkdownViewer } from "@/components/artifacts/viewers/MarkdownViewer";
import { PdfViewer } from "@/components/artifacts/viewers/PdfViewer";
import { PresentationViewer } from "@/components/artifacts/viewers/PresentationViewer";
import { SpreadsheetViewer } from "@/components/artifacts/viewers/SpreadsheetViewer";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button-variants";
import { Spinner } from "@/components/ui/spinner";
import { useAuth } from "@/context/use-auth";
import {
  artifactCanvasSourceLanguage,
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
import {
  buildArtifactContentUrl,
  isHtmlArtifactMimeType,
  isImageArtifactMimeType,
  isJsxArtifactFilename,
  isSvgArtifactMimeType,
  isVideoArtifactMimeType,
  resolveArtifactMimeType,
} from "@/lib/chat-artifacts";
import { client, formatError } from "@/lib/client";
import {
  dirnameArtifactPath,
  htmlWithVirtualArtifactFiles,
} from "@/lib/playable-html-preview";
import { queryClient } from "@/lib/query-client";
import { queryKeys } from "@/lib/query-keys";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const TEXT_SIBLING = /\.(css|js|json|svg|txt|csv|map)$/i;

function basenamePath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function sameDirectorySiblings(
  artifact: ArtifactFile,
  artifacts: ArtifactFile[]
): ArtifactFile[] {
  const path = artifact.path || artifact.filename;
  const dir = dirnameArtifactPath(path);

  return artifacts.filter((candidate) => {
    const candidatePath = candidate.path || candidate.filename;
    return candidatePath !== path && dirnameArtifactPath(candidatePath) === dir;
  });
}

function FilesLiveHtml({
  artifact,
  artifacts,
  profileId,
}: {
  artifact: ArtifactFile;
  artifacts: ArtifactFile[];
  profileId: string;
}) {
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const path = artifact.path || artifact.filename;
    const siblings = sameDirectorySiblings(artifact, artifacts).filter((file) =>
      TEXT_SIBLING.test(file.path || file.filename)
    );

    void (async () => {
      try {
        const htmlResult = await client.readProfileArtifactContent(
          profileId,
          path,
          { inline: true }
        );
        const html = new TextDecoder().decode(htmlResult.data);
        const files: Record<string, string> = {};

        await Promise.all(
          siblings.map(async (sibling) => {
            const siblingPath = sibling.path || sibling.filename;
            const result = await client.readProfileArtifactContent(
              profileId,
              siblingPath,
              { inline: true }
            );
            const text = new TextDecoder().decode(result.data);
            const name = basenamePath(siblingPath);
            files[name] = text;
            files[`./${name}`] = text;
          })
        );

        if (!cancelled) {
          setSrcDoc(
            Object.keys(files).length > 0
              ? htmlWithVirtualArtifactFiles(html, files)
              : html
          );
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(formatError(loadError));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [artifact, artifacts, profileId]);

  if (error) {
    return <p className="p-4 text-destructive text-sm">{error}</p>;
  }

  if (!srcDoc) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <Spinner className="size-5" />
      </div>
    );
  }

  return (
    <HtmlPreviewFrame
      filename={artifact.filename}
      html={srcDoc}
      title={artifact.filename}
    />
  );
}

function FilesJsxPreview({
  filename,
  path,
  profileId,
}: {
  filename: string;
  path: string;
  profileId: string;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void client
      .readProfileArtifactContent(profileId, path, { inline: true })
      .then((result) => {
        if (!cancelled) {
          setSource(new TextDecoder().decode(result.data));
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Failed to load JSX."
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path, profileId]);

  if (error) {
    return <p className="p-4 text-muted-foreground text-sm">{error}</p>;
  }
  if (!source) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <Spinner className="size-5" />
      </div>
    );
  }
  return (
    <HtmlPreviewFrame filename={filename} html={source} title={filename} />
  );
}

function FilesSourceCanvas({
  path,
  profileId,
  language,
}: {
  path: string;
  profileId: string;
  language: string;
}) {
  const [source, setSource] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void client
      .readProfileArtifactContent(profileId, path, { inline: true })
      .then((result) => {
        if (!cancelled) {
          setSource(new TextDecoder().decode(result.data));
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Failed to load source."
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path, profileId]);

  if (error) {
    return <p className="p-6 text-muted-foreground text-sm">{error}</p>;
  }
  if (!source) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <Spinner className="size-5" />
      </div>
    );
  }
  return <ArtifactCodeCanvas code={source} language={language} />;
}

function FilesSvgPreview({ filename, url }: { filename: string; url: string }) {
  const [markup, setMarkup] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);

    void fetch(url, { credentials: "include" })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Failed to load SVG (${response.status})`);
        }
        return response.text();
      })
      .then((text) => {
        if (!cancelled) {
          setMarkup(text);
        }
      })
      .catch((loadError: unknown) => {
        if (!cancelled) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Failed to load SVG."
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [url]);

  if (error) {
    return <p className="p-4 text-muted-foreground text-sm">{error}</p>;
  }

  if (!markup) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground">
        <Spinner className="size-5" />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-4">
      <SvgPreview content={markup} filename={filename} />
    </div>
  );
}

function FilesPreviewBody({
  artifact,
  artifacts,
  profileId,
  preview,
  downloadUrl,
  onSelectSheet,
  mode,
  editDraft,
  editSaving,
  onEditContent,
  onEditRows,
}: {
  artifact: ArtifactFile;
  artifacts: ArtifactFile[];
  profileId: string;
  preview: ArtifactPreview;
  downloadUrl: string;
  onSelectSheet: (sheetName: string, sheetIndex?: number) => void;
  mode: ArtifactPreviewMode;
  editDraft: ArtifactEditDraft | null;
  editSaving: boolean;
  onEditContent: (content: string) => void;
  onEditRows: (rows: string[][]) => void;
}) {
  const mimeType = resolveArtifactMimeType(
    artifact.mimeType,
    artifact.filename
  );

  if (isJsxArtifactFilename(artifact.filename)) {
    if (mode === "code") {
      return (
        <FilesSourceCanvas
          language={artifactCanvasSourceLanguage(
            artifact.filename,
            artifact.mimeType
          )}
          path={artifact.path || artifact.filename}
          profileId={profileId}
        />
      );
    }
    return (
      <FilesJsxPreview
        filename={artifact.filename}
        path={artifact.path || artifact.filename}
        profileId={profileId}
      />
    );
  }

  if (isHtmlArtifactMimeType(mimeType) || preview.type === "html") {
    if (mode === "code") {
      return (
        <FilesSourceCanvas
          language="html"
          path={artifact.path || artifact.filename}
          profileId={profileId}
        />
      );
    }
    return (
      <FilesLiveHtml
        artifact={artifact}
        artifacts={artifacts}
        profileId={profileId}
      />
    );
  }

  if (
    (isSvgArtifactMimeType(mimeType) ||
      artifact.filename.toLowerCase().endsWith(".svg")) &&
    preview.type === "image"
  ) {
    if (mode === "code") {
      return (
        <FilesSourceCanvas
          language="xml"
          path={artifact.path || artifact.filename}
          profileId={profileId}
        />
      );
    }
    return (
      <FilesSvgPreview
        filename={artifact.filename}
        url={
          preview.url ||
          buildArtifactContentUrl(
            profileId,
            artifact.path || artifact.filename,
            true
          )
        }
      />
    );
  }

  if (isMermaidArtifactFilename(artifact.filename)) {
    const source =
      preview.type === "text" ||
      preview.type === "code" ||
      preview.type === "markdown"
        ? preview.content
        : null;
    if (source) {
      if (mode === "code") {
        return <ArtifactCodeCanvas code={source} language="mermaid" />;
      }
      const mermaidError = mermaidPreviewError(source);
      return (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-8">
          {mermaidError ? (
            <p className="text-muted-foreground text-sm">{mermaidError}</p>
          ) : (
            <SafeMarkdownPreview content={markdownForMermaidSource(source)} />
          )}
        </div>
      );
    }
  }

  if (isImageArtifactMimeType(mimeType) || preview.type === "image") {
    const url =
      preview.type === "image"
        ? preview.url
        : buildArtifactContentUrl(
            profileId,
            artifact.path || artifact.filename,
            true
          );
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-muted/20 p-6">
        <img
          alt={artifact.filename}
          className="max-h-full max-w-full object-contain"
          src={url}
        />
      </div>
    );
  }

  if (isVideoArtifactMimeType(mimeType)) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        <video
          aria-label={artifact.filename}
          className="max-h-full w-full object-contain"
          controls
          playsInline
          src={buildArtifactContentUrl(
            profileId,
            artifact.path || artifact.filename,
            true
          )}
        />
      </div>
    );
  }

  switch (preview.type) {
    case "json":
      return <ArtifactCodeCanvas code={preview.formatted} language="json" />;
    case "markdown":
      return (
        <MarkdownViewer
          downloadUrl={downloadUrl}
          editor={
            editDraft?.source.kind === "markdown"
              ? {
                  content: editDraft.content,
                  disabled: editSaving,
                  onChange: onEditContent,
                }
              : undefined
          }
          preview={preview}
        />
      );
    case "code":
      return (
        <ArtifactCodeCanvas
          code={preview.content}
          language={preview.language}
        />
      );
    case "text":
      return <ArtifactCodeCanvas code={preview.content} language="text" />;
    case "pdf":
      return <PdfViewer downloadUrl={downloadUrl} preview={preview} />;
    case "spreadsheet":
      return (
        <SpreadsheetViewer
          downloadUrl={downloadUrl}
          editor={
            editDraft?.source.kind === "delimited"
              ? {
                  canAddColumn:
                    Math.max(0, ...editDraft.rows.map((row) => row.length)) <
                    ARTIFACT_EDIT_MAX_COLUMNS,
                  canAddRow: editDraft.rows.length < ARTIFACT_EDIT_MAX_ROWS,
                  disabled: editSaving,
                  onAddColumn: () =>
                    onEditRows(addEditableColumn(editDraft.rows)),
                  onAddRow: () => onEditRows(addEditableRow(editDraft.rows)),
                  onChangeCell: (rowIndex, columnIndex, value) =>
                    onEditRows(
                      updateEditableCell(
                        editDraft.rows,
                        rowIndex,
                        columnIndex,
                        value
                      )
                    ),
                  rows: editDraft.rows,
                }
              : undefined
          }
          onSelectSheet={onSelectSheet}
          preview={preview}
        />
      );
    case "presentation":
      return <PresentationViewer downloadUrl={downloadUrl} preview={preview} />;
    case "document":
      return <DocumentViewer downloadUrl={downloadUrl} preview={preview} />;
    default:
      return (
        <p className="p-4 text-muted-foreground text-sm">
          Preview is not available for this file type.
        </p>
      );
  }
}

export function FilesPreviewPanel({
  artifact,
  artifacts,
  profileId,
  onClose,
  onSavingChange,
}: {
  artifact: ArtifactFile;
  artifacts: ArtifactFile[];
  profileId: string;
  onClose: () => void;
  onSavingChange?: (saving: boolean) => void;
}) {
  const { activeOrg, user } = useAuth();
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sheet, setSheet] = useState<{
    sheet?: string;
    sheetIndex?: number;
  }>({});
  const [previewMode, setPreviewMode] =
    useState<ArtifactPreviewMode>("preview");

  const path = artifact.path || artifact.filename;
  const downloadUrl = `${client.baseUrl}${buildArtifactContentUrl(profileId, path)}`;
  const showModeToggle = artifactSupportsPreviewCodeToggle(
    artifact.filename,
    artifact.mimeType
  );
  const handleArtifactSaved = useCallback(async () => {
    const next = await client.getProfileArtifactPreview(profileId, path, {
      forceRegenerate: true,
      sheet: sheet.sheet,
      sheetIndex: sheet.sheetIndex,
    });
    setPreview(next);
    await queryClient.invalidateQueries({
      queryKey: queryKeys.artifacts.profile(profileId),
    });
    toast("Artifact saved.");
  }, [path, profileId, sheet.sheet, sheet.sheetIndex]);
  const editor = useArtifactEditor({
    artifactPath: path,
    onSaved: handleArtifactSaved,
    onSavingChange,
    profileId,
  });
  const canOfferEditing =
    (activeOrg?.role === "admin" || user?.isPlatformAdmin === true) &&
    isEditableArtifactFilename(artifact.filename);
  const editDisabledReason =
    knownArtifactEditLimitReason(artifact.sizeBytes) ??
    editor.unavailableReason;

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        if (editor.saving) {
          event.preventDefault();
          return;
        }
        if (editor.draft) {
          editor.cancel();
        } else {
          onClose();
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editor.cancel, editor.draft, editor.saving, onClose]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void client
      .getProfileArtifactPreview(profileId, path, {
        sheet: sheet.sheet,
        sheetIndex: sheet.sheetIndex,
      })
      .then((next) => {
        if (!cancelled) {
          setPreview(next);
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setError(formatError(loadError));
          setPreview(null);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [path, profileId, sheet.sheet, sheet.sheetIndex]);

  return (
    <aside
      aria-label={artifact.filename}
      className="flex h-full min-h-0 w-full max-w-full shrink-0 flex-col border-border border-l bg-background max-sm:absolute max-sm:inset-0 max-sm:z-20 sm:w-[28rem] lg:w-[36rem]"
    >
      <div className="flex h-11 items-center gap-2 border-border border-b px-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-medium text-sm">{artifact.filename}</h2>
        </div>
        {showModeToggle && !editor.draft ? (
          <ArtifactPreviewModeToggle
            mode={previewMode}
            onChange={setPreviewMode}
          />
        ) : null}
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
          <Button
            aria-label="Edit artifact"
            disabled={editor.loading || loading || Boolean(editDisabledReason)}
            onClick={() => void editor.start()}
            size="icon-sm"
            title={editDisabledReason ?? "Edit artifact"}
            type="button"
            variant="ghost"
          >
            {editor.loading ? (
              <Spinner className="size-4" />
            ) : (
              <PencilEdit01Icon className="size-4" />
            )}
          </Button>
        ) : null}
        <a
          aria-label="Download"
          className={cn(buttonVariants({ size: "icon-sm", variant: "ghost" }))}
          download={artifact.filename}
          href={downloadUrl}
          rel="noopener"
        >
          <Download01Icon className="size-4" />
        </a>
        <Button
          aria-label="Close preview"
          disabled={editor.saving}
          onClick={onClose}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <Cancel01Icon className="size-4" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {editor.error || editor.unavailableReason ? (
          <div
            className="border-destructive/30 border-b bg-destructive/5 px-4 py-2 text-destructive text-sm"
            role="alert"
          >
            {editor.error ?? editor.unavailableReason}
          </div>
        ) : null}
        {loading ? (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <Spinner className="size-5" />
          </div>
        ) : error ? (
          <p className="p-6 text-destructive text-sm">{error}</p>
        ) : preview ? (
          <FilesPreviewBody
            artifact={artifact}
            artifacts={artifacts}
            downloadUrl={downloadUrl}
            editDraft={editor.draft}
            editSaving={editor.saving}
            mode={previewMode}
            onEditContent={editor.setContent}
            onEditRows={editor.setRows}
            onSelectSheet={(sheetName, sheetIndex) =>
              setSheet({ sheet: sheetName, sheetIndex })
            }
            preview={preview}
            profileId={profileId}
          />
        ) : null}
      </div>
    </aside>
  );
}

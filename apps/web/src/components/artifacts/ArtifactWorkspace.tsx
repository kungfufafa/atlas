import {
  Cancel01Icon,
  Copy01Icon,
  Download01Icon,
  Maximize01Icon,
  Minimize01Icon,
} from "hugeicons-react";
import { useEffect, useState } from "react";
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
import {
  artifactPreviewCanCopy,
  artifactPreviewUsesFetchedSource,
  artifactSupportsPreviewCodeToggle,
} from "@/lib/artifact-canvas";
import {
  isMermaidArtifactFilename,
  markdownForMermaidSource,
  mermaidPreviewError,
} from "@/lib/artifact-mermaid-preview";
import { client } from "@/lib/client";
import { cn } from "@/lib/utils";
import { useArtifactWorkspace } from "./ArtifactWorkspaceContext";
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
  const {
    isOpen,
    activeArtifact,
    activePreview,
    loading,
    error,
    closeArtifact,
    refreshPreview,
    setRevision,
    setSheet,
  } = useArtifactWorkspace();

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [previewMode, setPreviewMode] =
    useState<ArtifactPreviewMode>("preview");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setPreviewMode("preview");
    setCopied(false);
  }, [activeArtifact?.path, activeArtifact?.artifactId]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && isOpen) {
        closeArtifact();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, closeArtifact]);

  if (!(isOpen && activeArtifact)) {
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

  async function handleCopy() {
    if (!activePreview) {
      return;
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
    if (!text) {
      return;
    }
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  const canCopy = artifactPreviewCanCopy(activePreview);

  function renderViewer() {
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
            {activePreview?.error ||
              error ||
              "This file couldn't be previewed."}
          </p>
          <div className="flex items-center gap-2">
            <Button
              onClick={() => void refreshPreview()}
              size="sm"
              type="button"
              variant="outline"
            >
              Try again
            </Button>
            <a
              className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
              download={activeArtifact?.filename}
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
            onSelectSheet={(sheetName, sheetIndex) =>
              setSheet(sheetName, sheetIndex)
            }
            preview={activePreview}
          />
        );
      case "presentation":
        return (
          <PresentationViewer
            downloadUrl={downloadUrl}
            preview={activePreview}
          />
        );
      case "document":
        return (
          <DocumentViewer downloadUrl={downloadUrl} preview={activePreview} />
        );
      case "markdown":
        return (
          <MarkdownViewer downloadUrl={downloadUrl} preview={activePreview} />
        );
      case "code":
      case "text": {
        if (isMermaidArtifactFilename(artifact.filename)) {
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
          return (
            <CodeViewer downloadUrl={downloadUrl} preview={activePreview} />
          );
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

  return (
    <div
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-0 sm:p-4"
      role="dialog"
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
            <h3 className="truncate font-medium text-sm">
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
                        : "text-muted-foreground hover:text-foreground"
                    )}
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

          {showModeToggle ? (
            <ArtifactPreviewModeToggle
              mode={previewMode}
              onChange={setPreviewMode}
            />
          ) : null}

          <div className="flex shrink-0 items-center">
            {canCopy ? (
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
          {renderViewer()}
        </div>
      </div>
    </div>
  );
}

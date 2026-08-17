import {
  Cancel01Icon,
  Download01Icon,
  Maximize01Icon,
  Minimize01Icon,
  RefreshIcon,
} from "hugeicons-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  isMermaidArtifactFilename,
  markdownForMermaidSource,
  mermaidPreviewError,
} from "@/lib/artifact-mermaid-preview";
import { client } from "@/lib/client";
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

  // Close on Escape key
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

  function renderViewer() {
    if (loading) {
      return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-muted/10 p-8 text-muted-foreground">
          <Spinner className="size-6 text-primary" />
          <p className="font-medium text-sm">Preparing preview…</p>
        </div>
      );
    }

    if (error || !activePreview || activePreview.status === "failed") {
      return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-muted/10 p-6 text-center">
          <div className="max-w-md rounded-2xl border border-destructive/20 bg-destructive/5 p-6 text-foreground shadow-xs">
            <h4 className="font-semibold text-base text-destructive">
              We couldn't generate a preview for this file
            </h4>
            <p className="mt-2 text-muted-foreground text-xs leading-relaxed">
              {activePreview?.error ||
                error ||
                "An unexpected issue occurred while rendering the document preview. You can still download the original."}
            </p>
            <div className="mt-5 flex items-center justify-center gap-3">
              <Button
                className="gap-1.5"
                onClick={() => void refreshPreview()}
                size="sm"
                type="button"
                variant="outline"
              >
                <RefreshIcon className="size-3.5" />
                Try again
              </Button>
              <a
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 font-semibold text-primary-foreground text-xs shadow-xs transition-colors hover:bg-primary/90"
                download={activeArtifact?.filename}
                href={downloadUrl}
              >
                <Download01Icon className="size-3.5" />
                Download Original
              </a>
            </div>
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
          <ImageViewer downloadUrl={downloadUrl} preview={activePreview} />
        );
      case "html":
        return <HtmlViewer downloadUrl={downloadUrl} preview={activePreview} />;
      default:
        return (
          <GenericViewer downloadUrl={downloadUrl} preview={activePreview} />
        );
    }
  }

  return (
    <div
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-0 backdrop-blur-xs sm:p-4 md:p-6"
      role="dialog"
    >
      <div
        className={`flex w-full flex-col overflow-hidden bg-background shadow-2xl transition-all ${
          isFullscreen
            ? "fixed inset-0 h-full w-full rounded-none"
            : "h-full max-h-[92vh] max-w-6xl rounded-none border border-border sm:rounded-2xl"
        }`}
      >
        {/* Modal Shell Header */}
        <header className="flex shrink-0 items-center justify-between border-border border-b bg-card px-4 py-2.5 shadow-xs sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <h3 className="truncate font-bold text-foreground text-sm sm:text-base">
              {activeArtifact.filename}
            </h3>

            {/* Revision Badge / Selector */}
            <div className="flex items-center gap-1">
              {activeArtifact.revision && activeArtifact.revision > 1 ? (
                <div className="flex items-center gap-0.5 rounded-md bg-muted/80 p-0.5">
                  {Array.from(
                    { length: activeArtifact.revision },
                    (_, i) => i + 1
                  ).map((rev) => (
                    <button
                      className={`rounded px-1.5 py-0.5 font-bold text-[10px] uppercase transition-colors ${
                        revision === rev
                          ? "bg-background text-foreground shadow-2xs"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                      key={rev}
                      onClick={() => setRevision(rev)}
                      type="button"
                    >
                      v{rev}
                    </button>
                  ))}
                </div>
              ) : (
                <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 font-bold text-[10px] text-muted-foreground uppercase tracking-wider">
                  v{revision}
                </span>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <Button
              aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              className="size-8 p-0"
              onClick={() => setIsFullscreen((v) => !v)}
              size="sm"
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
              aria-label="Close artifact preview"
              className="size-8 p-0 text-muted-foreground hover:text-foreground"
              onClick={closeArtifact}
              size="sm"
              type="button"
              variant="ghost"
            >
              <Cancel01Icon className="size-4" />
            </Button>
          </div>
        </header>

        {/* Viewer Canvas Area */}
        <div className="min-h-0 flex-1 overflow-hidden">{renderViewer()}</div>
      </div>
    </div>
  );
}

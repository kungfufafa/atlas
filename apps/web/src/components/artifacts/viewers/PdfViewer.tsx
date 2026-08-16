import type { PdfPreview } from "@atlas/core";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  Download01Icon,
  SidebarLeftIcon,
  ZoomInAreaIcon,
  ZoomOutAreaIcon,
} from "hugeicons-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export function PdfViewer({
  preview,
  downloadUrl,
}: {
  preview: PdfPreview;
  downloadUrl: string;
}) {
  const totalPages = Math.max(1, preview.pageCount || 1);
  const [currentPage, setCurrentPage] = useState(1);
  const [zoom, setZoom] = useState(100);
  const [showThumbnails, setShowThumbnails] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loadingPdf, setLoadingPdf] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  const rawPdfUrl = preview.previewUrl || downloadUrl;

  useEffect(() => {
    let cancelled = false;
    setLoadingPdf(true);
    setPdfError(null);

    fetch(rawPdfUrl, { credentials: "include" })
      .then((res) => {
        if (!res.ok) {
          throw new Error(`Failed to load PDF (${res.status})`);
        }
        return res.blob();
      })
      .then((blob) => {
        if (cancelled) {
          return;
        }
        const objectUrl = URL.createObjectURL(
          new Blob([blob], { type: "application/pdf" })
        );
        setBlobUrl(objectUrl);
      })
      .catch((err) => {
        if (cancelled) {
          return;
        }
        setPdfError(err?.message || "Failed to load PDF preview.");
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingPdf(false);
        }
      });

    return () => {
      cancelled = true;
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
      }
    };
  }, [rawPdfUrl]);

  // Sync zoom / page to embed URL
  const pdfSource = blobUrl
    ? `${blobUrl}#page=${currentPage}&zoom=${zoom}`
    : `${rawPdfUrl}#page=${currentPage}&zoom=${zoom}`;

  function handleZoomIn() {
    setZoom((z) => Math.min(250, z + 25));
  }

  function handleZoomOut() {
    setZoom((z) => Math.max(50, z - 25));
  }

  function handleResetZoom() {
    setZoom(100);
  }

  function handlePrevPage() {
    setCurrentPage((p) => Math.max(1, p - 1));
  }

  function handleNextPage() {
    setCurrentPage((p) => Math.min(totalPages, p + 1));
  }

  // Keyboard navigation
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "PageUp") {
        setCurrentPage((p) => Math.max(1, p - 1));
      } else if (e.key === "ArrowRight" || e.key === "PageDown") {
        setCurrentPage((p) => Math.min(totalPages, p + 1));
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [totalPages]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-muted/10">
      {/* Viewer Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-border border-b bg-card px-4 py-2 text-sm shadow-xs">
        <div className="flex items-center gap-1.5">
          <Button
            aria-label="Toggle thumbnails"
            className="size-8 p-0"
            onClick={() => setShowThumbnails((v) => !v)}
            size="sm"
            type="button"
            variant={showThumbnails ? "secondary" : "ghost"}
          >
            <SidebarLeftIcon className="size-4" />
          </Button>

          <div className="h-4 w-px bg-border" />

          <Button
            aria-label="Previous page"
            className="size-8 p-0"
            disabled={currentPage <= 1}
            onClick={handlePrevPage}
            size="sm"
            type="button"
            variant="ghost"
          >
            <ArrowLeft01Icon className="size-4" />
          </Button>

          <div className="flex items-center gap-1 font-medium text-xs">
            <input
              aria-label="Page number"
              className="w-12 rounded border border-border bg-background px-1.5 py-0.5 text-center font-semibold text-xs tabular-nums focus:outline-hidden focus:ring-1 focus:ring-primary"
              max={totalPages}
              min={1}
              onChange={(e) => {
                const val = Number.parseInt(e.target.value, 10);
                if (!Number.isNaN(val) && val >= 1 && val <= totalPages) {
                  setCurrentPage(val);
                }
              }}
              type="number"
              value={currentPage}
            />
            <span className="text-muted-foreground">/ {totalPages}</span>
          </div>

          <Button
            aria-label="Next page"
            className="size-8 p-0"
            disabled={currentPage >= totalPages}
            onClick={handleNextPage}
            size="sm"
            type="button"
            variant="ghost"
          >
            <ArrowRight01Icon className="size-4" />
          </Button>
        </div>

        {/* Zoom Controls */}
        <div className="flex items-center gap-1.5">
          <Button
            aria-label="Zoom out"
            className="size-8 p-0"
            disabled={zoom <= 50}
            onClick={handleZoomOut}
            size="sm"
            type="button"
            variant="ghost"
          >
            <ZoomOutAreaIcon className="size-4" />
          </Button>

          <button
            aria-label="Reset zoom"
            className="min-w-12 rounded px-1.5 py-1 text-center font-medium text-muted-foreground text-xs hover:bg-muted"
            onClick={handleResetZoom}
            type="button"
          >
            {zoom}%
          </button>

          <Button
            aria-label="Zoom in"
            className="size-8 p-0"
            disabled={zoom >= 250}
            onClick={handleZoomIn}
            size="sm"
            type="button"
            variant="ghost"
          >
            <ZoomInAreaIcon className="size-4" />
          </Button>

          <div className="h-4 w-px bg-border" />

          <a
            aria-label="Download PDF"
            className="inline-flex size-8 items-center justify-center rounded-md border border-border bg-background text-foreground transition-colors hover:bg-accent hover:text-foreground"
            download={preview.filename}
            href={downloadUrl}
          >
            <Download01Icon className="size-4" />
          </a>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* Left Thumbnail Rail */}
        {showThumbnails ? (
          <aside className="w-48 shrink-0 overflow-y-auto border-border border-r bg-card/60 p-3">
            <h4 className="mb-2 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
              Pages ({totalPages})
            </h4>
            <div className="space-y-2">
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                <button
                  className={`w-full rounded-md border p-2 text-left transition-all ${
                    currentPage === p
                      ? "border-primary bg-primary/10 shadow-xs"
                      : "border-border/60 bg-background hover:border-border"
                  }`}
                  key={p}
                  onClick={() => setCurrentPage(p)}
                  type="button"
                >
                  <div className="flex aspect-[1/1.414] w-full items-center justify-center rounded bg-muted/40 font-bold text-muted-foreground text-xs">
                    Page {p}
                  </div>
                  <span className="mt-1 block text-center font-medium text-[11px] text-muted-foreground">
                    {p}
                  </span>
                </button>
              ))}
            </div>
          </aside>
        ) : null}

        {/* PDF Frame / Render Container */}
        <main className="relative min-h-0 flex-1 overflow-auto bg-muted/20 p-4">
          <div className="mx-auto flex h-full min-h-[500px] w-full max-w-5xl items-center justify-center overflow-hidden rounded-lg border border-border bg-background shadow-sm">
            {loadingPdf ? (
              <div className="flex flex-col items-center justify-center gap-2 p-8 text-muted-foreground">
                <Spinner className="size-6 text-primary" />
                <p className="font-medium text-xs">Loading document preview…</p>
              </div>
            ) : pdfError ? (
              <div className="flex flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
                <p className="text-destructive text-sm">{pdfError}</p>
                <a
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 font-semibold text-primary-foreground text-xs shadow-xs"
                  download={preview.filename}
                  href={downloadUrl}
                >
                  <Download01Icon className="size-3.5" />
                  Download File
                </a>
              </div>
            ) : (
              <iframe
                className="h-full w-full border-0"
                key={`${preview.filename}-${currentPage}-${zoom}`}
                src={pdfSource}
                title={`PDF Preview - ${preview.filename}`}
              />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

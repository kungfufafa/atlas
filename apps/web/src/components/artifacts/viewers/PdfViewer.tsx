import type { PdfPreview } from "@atlas/core";
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  SidebarLeftIcon,
  ZoomInAreaIcon,
  ZoomOutAreaIcon,
} from "hugeicons-react";
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
} from "pdfjs-dist";
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

GlobalWorkerOptions.workerSrc = pdfjsWorker;

export function PdfViewer({
  preview,
  downloadUrl,
}: {
  preview: PdfPreview;
  downloadUrl: string;
}) {
  const [currentPage, setCurrentPage] = useState(1);
  const [zoom, setZoom] = useState(100);
  const [showThumbnails, setShowThumbnails] = useState(false);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(
    Math.max(1, preview.pageCount || 1)
  );
  const [loadingPdf, setLoadingPdf] = useState(true);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rawPdfUrl = preview.previewUrl || downloadUrl;

  useEffect(() => {
    let cancelled = false;
    let documentProxy: PDFDocumentProxy | null = null;
    setLoadingPdf(true);
    setPdfError(null);
    setPdf(null);

    void (async () => {
      try {
        const response = await fetch(rawPdfUrl, { credentials: "include" });
        if (!response.ok) {
          throw new Error(`Failed to load PDF (${response.status})`);
        }
        const data = await response.arrayBuffer();
        const loadingTask = getDocument({ data });
        documentProxy = await loadingTask.promise;
        if (cancelled) {
          await documentProxy.destroy();
          return;
        }
        setPageCount(documentProxy.numPages);
        setCurrentPage((page) =>
          Math.min(Math.max(1, page), documentProxy?.numPages ?? 1)
        );
        setPdf(documentProxy);
      } catch (error) {
        if (!cancelled) {
          setPdfError(
            error instanceof Error
              ? error.message
              : "Failed to load PDF preview."
          );
        }
      } finally {
        if (!cancelled) {
          setLoadingPdf(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      void documentProxy?.destroy();
    };
  }, [rawPdfUrl]);

  useEffect(() => {
    if (!pdf) {
      return;
    }

    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    void (async () => {
      try {
        const page = await pdf.getPage(currentPage);
        if (cancelled) {
          return;
        }
        const viewport = page.getViewport({ scale: zoom / 100 });
        const context = canvas.getContext("2d");
        if (!context) {
          throw new Error("Canvas is not available.");
        }
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        await page.render({ canvasContext: context, viewport }).promise;
        if (!cancelled) {
          setRenderError(null);
        }
      } catch (error) {
        if (!cancelled) {
          setRenderError(
            error instanceof Error
              ? error.message
              : "This PDF couldn't be previewed."
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentPage, pdf, zoom]);

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
    setCurrentPage((p) => Math.min(pageCount, p + 1));
  }

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
        setCurrentPage((p) => Math.min(pageCount, p + 1));
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [pageCount]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-muted/20">
      <div className="flex flex-wrap items-center justify-between gap-2 border-border border-b px-2 py-1.5">
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
              max={pageCount}
              min={1}
              onChange={(e) => {
                const val = Number.parseInt(e.target.value, 10);
                if (!Number.isNaN(val) && val >= 1 && val <= pageCount) {
                  setCurrentPage(val);
                }
              }}
              type="number"
              value={currentPage}
            />
            <span className="text-muted-foreground">/ {pageCount}</span>
          </div>

          <Button
            aria-label="Next page"
            className="size-8 p-0"
            disabled={currentPage >= pageCount}
            onClick={handleNextPage}
            size="sm"
            type="button"
            variant="ghost"
          >
            <ArrowRight01Icon className="size-4" />
          </Button>
        </div>

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
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {showThumbnails ? (
          <aside className="w-40 shrink-0 overflow-y-auto border-border border-r p-2">
            <div className="space-y-1.5">
              {Array.from({ length: pageCount }, (_, i) => i + 1).map((p) => (
                <button
                  className={`w-full rounded-md border p-1.5 text-left ${
                    currentPage === p
                      ? "border-foreground/20 bg-muted"
                      : "border-transparent hover:bg-muted/60"
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

        <main className="relative min-h-0 flex-1 overflow-auto">
          <div className="mx-auto flex min-h-full w-full items-center justify-center p-6">
            {loadingPdf ? (
              <Spinner className="size-5 text-muted-foreground" />
            ) : pdfError || renderError ? (
              <p className="text-muted-foreground text-sm">
                {pdfError || renderError || "This PDF couldn't be previewed."}
              </p>
            ) : (
              <canvas
                className="max-h-full max-w-full bg-background shadow-sm"
                ref={canvasRef}
              />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

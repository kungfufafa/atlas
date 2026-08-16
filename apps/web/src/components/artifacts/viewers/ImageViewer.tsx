import type { ImagePreview } from "@atlas/core";
import {
  Download01Icon,
  Image01Icon,
  ZoomInAreaIcon,
  ZoomOutAreaIcon,
} from "hugeicons-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function ImageViewer({
  preview,
  downloadUrl,
}: {
  preview: ImagePreview;
  downloadUrl: string;
}) {
  const [zoom, setZoom] = useState(100);

  function handleZoomIn() {
    setZoom((z) => Math.min(300, z + 25));
  }

  function handleZoomOut() {
    setZoom((z) => Math.max(25, z - 25));
  }

  function handleReset() {
    setZoom(100);
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      {/* Top Toolbar */}
      <div className="flex items-center justify-between border-border border-b bg-card px-4 py-2 text-sm shadow-xs">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-md bg-pink-500/10 text-pink-600 dark:text-pink-400">
            <Image01Icon className="size-4" />
          </div>
          <span className="truncate font-semibold text-foreground text-xs sm:text-sm">
            {preview.filename}
          </span>
          <span className="rounded bg-muted px-2 py-0.5 font-medium text-[11px] text-muted-foreground uppercase">
            {preview.format}
          </span>
          {preview.dimensions ? (
            <span className="rounded bg-muted px-2 py-0.5 font-medium text-[11px] text-muted-foreground">
              {preview.dimensions}
            </span>
          ) : null}
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            aria-label="Zoom out"
            className="size-8 p-0"
            disabled={zoom <= 25}
            onClick={handleZoomOut}
            size="sm"
            type="button"
            variant="ghost"
          >
            <ZoomOutAreaIcon className="size-4" />
          </Button>

          <button
            className="rounded px-2 py-1 font-medium text-muted-foreground text-xs hover:bg-accent hover:text-foreground"
            onClick={handleReset}
            type="button"
          >
            {zoom}%
          </button>

          <Button
            aria-label="Zoom in"
            className="size-8 p-0"
            disabled={zoom >= 300}
            onClick={handleZoomIn}
            size="sm"
            type="button"
            variant="ghost"
          >
            <ZoomInAreaIcon className="size-4" />
          </Button>

          <div className="h-4 w-px bg-border" />

          <a
            aria-label="Download image"
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2.5 font-medium text-foreground text-xs shadow-2xs transition-colors hover:bg-accent hover:text-foreground"
            download={preview.filename}
            href={downloadUrl}
          >
            <Download01Icon className="size-3.5" />
            Download
          </a>
        </div>
      </div>

      {/* Main Image View */}
      <main className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/20 p-6">
        <div
          className="transition-transform duration-150"
          style={{ transform: `scale(${zoom / 100})` }}
        >
          <img
            alt={preview.filename}
            className="max-h-[min(75vh,50rem)] max-w-full rounded-lg border border-border bg-card object-contain shadow-md"
            src={preview.url || downloadUrl}
          />
        </div>
      </main>
    </div>
  );
}

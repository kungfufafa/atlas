import type { ImagePreview } from "@atlas/core";
import { ZoomInAreaIcon, ZoomOutAreaIcon } from "hugeicons-react";
import { useEffect, useState } from "react";
import { ArtifactCodeCanvas } from "@/components/artifacts/ArtifactCodeCanvas";
import type { ArtifactPreviewMode } from "@/components/artifacts/ArtifactPreviewModeToggle";
import { SvgPreview } from "@/components/artifacts/SvgPreview";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

function isSvgPreview(preview: ImagePreview): boolean {
  return (
    preview.format.toLowerCase() === "svg" ||
    preview.mimeType === "image/svg+xml" ||
    preview.filename.toLowerCase().endsWith(".svg")
  );
}

export function ImageViewer({
  preview,
  downloadUrl,
  mode = "preview",
}: {
  preview: ImagePreview;
  downloadUrl: string;
  mode?: ArtifactPreviewMode;
}) {
  const [zoom, setZoom] = useState(100);
  const svg = isSvgPreview(preview);
  const [svgMarkup, setSvgMarkup] = useState<string | null>(null);
  const [svgError, setSvgError] = useState<string | null>(null);

  useEffect(() => {
    if (!svg) {
      return;
    }

    let cancelled = false;
    setSvgError(null);

    fetch(preview.url || downloadUrl, { credentials: "include" })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Failed to load SVG (${response.status})`);
        }
        return response.text();
      })
      .then((text) => {
        if (!cancelled) {
          setSvgMarkup(text);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setSvgError(
            error instanceof Error ? error.message : "Failed to load SVG."
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [downloadUrl, preview.url, svg]);

  if (mode === "code" && svg && svgMarkup) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
        <ArtifactCodeCanvas code={svgMarkup} language="xml" />
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-muted/20">
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
        <div
          className="origin-center transition-transform duration-150"
          style={{ transform: `scale(${zoom / 100})` }}
        >
          {svg ? (
            svgMarkup ? (
              <SvgPreview
                className="max-h-[min(75vh,50rem)] max-w-full object-contain"
                content={svgMarkup}
                filename={preview.filename}
              />
            ) : svgError ? (
              <p className="text-muted-foreground text-sm">{svgError}</p>
            ) : (
              <Spinner className="size-5 text-muted-foreground" />
            )
          ) : (
            <img
              alt={preview.filename}
              className="max-h-[min(75vh,50rem)] max-w-full object-contain"
              src={preview.url || downloadUrl}
            />
          )}
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-0.5 rounded-full border border-border bg-background/90 px-1 py-0.5 shadow-xs backdrop-blur-sm">
          <Button
            aria-label="Zoom out"
            className="size-7 p-0"
            disabled={zoom <= 25}
            onClick={() => setZoom((z) => Math.max(25, z - 25))}
            size="sm"
            type="button"
            variant="ghost"
          >
            <ZoomOutAreaIcon className="size-3.5" />
          </Button>
          <button
            className="min-w-10 rounded px-1.5 py-1 font-medium text-muted-foreground text-xs tabular-nums"
            onClick={() => setZoom(100)}
            type="button"
          >
            {zoom}%
          </button>
          <Button
            aria-label="Zoom in"
            className="size-7 p-0"
            disabled={zoom >= 300}
            onClick={() => setZoom((z) => Math.min(300, z + 25))}
            size="sm"
            type="button"
            variant="ghost"
          >
            <ZoomInAreaIcon className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

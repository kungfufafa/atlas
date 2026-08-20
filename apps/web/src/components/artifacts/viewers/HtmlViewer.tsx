import type { HtmlPreview } from "@atlas/core";
import { useEffect, useState } from "react";
import { ArtifactCodeCanvas } from "@/components/artifacts/ArtifactCodeCanvas";
import type { ArtifactPreviewMode } from "@/components/artifacts/ArtifactPreviewModeToggle";
import { HtmlPreviewFrame } from "@/components/artifacts/HtmlPreviewFrame";
import { Spinner } from "@/components/ui/spinner";

export function HtmlViewer({
  preview,
  downloadUrl,
  mode = "preview",
}: {
  preview: HtmlPreview;
  downloadUrl: string;
  mode?: ArtifactPreviewMode;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);

    fetch(downloadUrl, { credentials: "include" })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Failed to load HTML (${response.status})`);
        }
        return response.text();
      })
      .then((text) => {
        if (!cancelled) {
          setHtml(text);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(
            error instanceof Error ? error.message : "Failed to load HTML."
          );
          setHtml(preview.safeHtml);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [downloadUrl, preview.safeHtml]);

  const source = html ?? preview.safeHtml;

  if (mode === "code" && source) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
        <ArtifactCodeCanvas code={source} language="html" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-background">
      {html ? (
        <HtmlPreviewFrame
          className="h-full min-h-0 w-full flex-1 border-0 bg-background"
          html={html}
          title={preview.title || preview.filename}
        />
      ) : loadError ? (
        <p className="p-6 text-muted-foreground text-sm">{loadError}</p>
      ) : (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Spinner className="size-5" />
        </div>
      )}
    </div>
  );
}

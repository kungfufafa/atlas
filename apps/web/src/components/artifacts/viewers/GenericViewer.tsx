import type { GenericPreview } from "@atlas/core";
import { Download01Icon, File01Icon } from "hugeicons-react";
import { formatBytes } from "@/lib/knowledge-base-files";

export function GenericViewer({
  preview,
  downloadUrl,
}: {
  preview: GenericPreview;
  downloadUrl: string;
}) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-muted/10 p-6">
      <div className="flex w-full max-w-md flex-col items-center rounded-2xl border border-border/80 bg-card p-8 text-center shadow-sm">
        <div className="flex size-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          <File01Icon className="size-8" />
        </div>

        <h3 className="mt-4 truncate font-bold text-foreground text-lg">
          {preview.filename}
        </h3>

        <p className="mt-1 font-medium text-muted-foreground text-xs">
          {preview.mimeType} · {formatBytes(preview.sizeBytes)}
        </p>

        <div className="mt-6 rounded-lg border border-border/60 bg-muted/30 px-4 py-3 text-muted-foreground text-xs">
          Preview is not available for this file type. You can download the
          original file to view it locally.
        </div>

        <a
          aria-label="Download original artifact"
          className="mt-6 inline-flex h-10 w-full items-center justify-center gap-2 rounded-xl bg-primary font-semibold text-primary-foreground text-sm shadow-xs transition-colors hover:bg-primary/90"
          download={preview.filename}
          href={downloadUrl}
        >
          <Download01Icon className="size-4" />
          Download File
        </a>
      </div>
    </div>
  );
}

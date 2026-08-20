import type { GenericPreview } from "@atlas/core";
import { Download01Icon } from "hugeicons-react";
import { formatBytes } from "@/lib/knowledge-base-files";

export function GenericViewer({
  preview,
  downloadUrl,
}: {
  preview: GenericPreview;
  downloadUrl: string;
}) {
  return (
    <div className="flex h-full w-full items-center justify-center p-8">
      <div className="flex w-full max-w-sm flex-col items-center text-center">
        <p className="truncate font-medium text-foreground text-sm">
          {preview.filename}
        </p>
        <p className="mt-1 text-muted-foreground text-xs">
          {preview.mimeType} · {formatBytes(preview.sizeBytes)}
        </p>
        <a
          aria-label="Download original artifact"
          className="mt-6 inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-border px-3 font-medium text-sm transition-colors hover:bg-muted"
          download={preview.filename}
          href={downloadUrl}
        >
          <Download01Icon className="size-3.5" />
          Download
        </a>
      </div>
    </div>
  );
}

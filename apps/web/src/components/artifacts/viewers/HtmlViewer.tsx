import type { HtmlPreview } from "@atlas/core";
import { Download01Icon, Globe02Icon } from "hugeicons-react";

export function HtmlViewer({
  preview,
  downloadUrl,
}: {
  preview: HtmlPreview;
  downloadUrl: string;
}) {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      {/* Top Toolbar */}
      <div className="flex items-center justify-between border-border border-b bg-card px-4 py-2 text-sm shadow-xs">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-md bg-cyan-500/10 text-cyan-600 dark:text-cyan-400">
            <Globe02Icon className="size-4" />
          </div>
          <span className="truncate font-semibold text-foreground text-xs sm:text-sm">
            {preview.title || preview.filename}
          </span>
          <span className="rounded bg-muted px-2 py-0.5 font-medium text-[11px] text-muted-foreground">
            Sandboxed HTML
          </span>
        </div>

        <div className="flex items-center gap-2">
          <a
            aria-label="Download HTML"
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2.5 font-medium text-foreground text-xs shadow-2xs transition-colors hover:bg-accent hover:text-foreground"
            download={preview.filename}
            href={downloadUrl}
          >
            <Download01Icon className="size-3.5" />
            Download
          </a>
        </div>
      </div>

      {/* Sandboxed iframe */}
      <main className="min-h-0 flex-1 bg-muted/20 p-4">
        <div className="h-full w-full overflow-hidden rounded-lg border border-border bg-background shadow-xs">
          <iframe
            className="h-full w-full border-0"
            sandbox={preview.sandbox || "allow-same-origin"}
            srcDoc={preview.safeHtml}
            title={preview.title || preview.filename}
          />
        </div>
      </main>
    </div>
  );
}

import type { MarkdownPreview } from "@atlas/core";
import { Download01Icon, File01Icon } from "hugeicons-react";
import { SafeMarkdownPreview } from "@/components/artifacts/SafeMarkdownPreview";

export function MarkdownViewer({
  preview,
  downloadUrl,
}: {
  preview: MarkdownPreview;
  downloadUrl: string;
}) {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      <div className="flex items-center justify-between border-border border-b bg-card px-4 py-2 text-sm shadow-xs">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-md bg-indigo-500/10 text-indigo-600 dark:text-indigo-400">
            <File01Icon className="size-4" />
          </div>
          <span className="truncate font-semibold text-foreground text-xs sm:text-sm">
            {preview.filename}
          </span>
          <span className="rounded bg-muted px-2 py-0.5 font-medium text-[11px] text-muted-foreground">
            {preview.wordCount} words · {preview.readingTimeMinutes || 1} min
            read
          </span>
        </div>

        <div className="flex items-center gap-2">
          <a
            aria-label="Download markdown"
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2.5 font-medium text-foreground text-xs shadow-2xs transition-colors hover:bg-accent hover:text-foreground"
            download={preview.filename}
            href={downloadUrl}
          >
            <Download01Icon className="size-3.5" />
            Download
          </a>
        </div>
      </div>

      <main className="min-h-0 flex-1 overflow-y-auto bg-muted/10 p-4 sm:p-8">
        <div className="mx-auto max-w-4xl rounded-xl border border-border/80 bg-background p-6 shadow-sm sm:p-10">
          <SafeMarkdownPreview
            className="leading-relaxed sm:text-base"
            content={preview.content}
          />
        </div>
      </main>
    </div>
  );
}

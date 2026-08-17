import type { DocumentPreview } from "@atlas/core";
import { Download01Icon, File01Icon, SidebarLeftIcon } from "hugeicons-react";
import { useState } from "react";
import { SafeMarkdownPreview } from "@/components/artifacts/SafeMarkdownPreview";
import { Button } from "@/components/ui/button";

export function DocumentViewer({
  preview,
  downloadUrl,
}: {
  preview: DocumentPreview;
  downloadUrl: string;
}) {
  const [showOutline, setShowOutline] = useState(true);
  const headings = preview.headings || [];

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      {/* Top Toolbar */}
      <div className="flex items-center justify-between border-border border-b bg-card px-4 py-2 text-sm shadow-xs">
        <div className="flex items-center gap-2">
          {headings.length > 0 ? (
            <Button
              aria-label="Toggle document outline"
              className="size-8 p-0"
              onClick={() => setShowOutline((v) => !v)}
              size="sm"
              type="button"
              variant={showOutline ? "secondary" : "ghost"}
            >
              <SidebarLeftIcon className="size-4" />
            </Button>
          ) : null}

          <div className="flex size-7 items-center justify-center rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400">
            <File01Icon className="size-4" />
          </div>
          <span className="truncate font-semibold text-foreground text-xs sm:text-sm">
            {preview.title || preview.filename}
          </span>
          <span className="rounded bg-muted px-2 py-0.5 font-medium text-[11px] text-muted-foreground">
            {preview.pageCount || 1} page
            {(preview.pageCount || 1) === 1 ? "" : "s"} ·{" "}
            {preview.wordCount || 0} words
          </span>
        </div>

        <div className="flex items-center gap-2">
          <a
            aria-label="Download document"
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2.5 font-medium text-foreground text-xs shadow-2xs transition-colors hover:bg-accent hover:text-foreground"
            download={preview.filename}
            href={downloadUrl}
          >
            <Download01Icon className="size-3.5" />
            Download
          </a>
        </div>
      </div>

      {/* Workspace */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left Table of Contents Outline */}
        {showOutline && headings.length > 0 ? (
          <aside className="w-64 shrink-0 overflow-y-auto border-border border-r bg-card/50 p-4">
            <h4 className="mb-3 font-semibold text-muted-foreground text-xs uppercase tracking-wider">
              Outline ({headings.length})
            </h4>
            <nav className="space-y-1.5">
              {headings.map((h) => (
                <a
                  className={`block truncate rounded-md px-2 py-1 text-xs transition-colors hover:bg-accent hover:text-foreground ${
                    h.level === 1
                      ? "font-bold text-foreground"
                      : h.level === 2
                        ? "pl-4 font-medium text-muted-foreground"
                        : "pl-6 font-normal text-muted-foreground/80"
                  }`}
                  href={`#${h.id}`}
                  key={h.id}
                >
                  {h.text}
                </a>
              ))}
            </nav>
          </aside>
        ) : null}

        {/* Document Page Canvas */}
        <main className="min-h-0 flex-1 overflow-y-auto bg-muted/20 p-4 sm:p-8">
          <div className="mx-auto max-w-3xl rounded-xl border border-border/80 bg-background p-6 shadow-sm sm:p-12">
            {preview.markdown ? (
              <SafeMarkdownPreview
                className="leading-relaxed sm:text-base"
                content={preview.markdown}
              />
            ) : (
              <p className="text-muted-foreground text-sm">
                No text content available.
              </p>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

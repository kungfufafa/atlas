import type { DocumentPreview } from "@atlas/core";
import { SidebarLeftIcon } from "hugeicons-react";
import { useState } from "react";
import { SafeMarkdownPreview } from "@/components/artifacts/SafeMarkdownPreview";
import { Button } from "@/components/ui/button";

export function DocumentViewer({
  preview,
}: {
  preview: DocumentPreview;
  downloadUrl: string;
}) {
  const [showOutline, setShowOutline] = useState(true);
  const headings = preview.headings || [];

  return (
    <div className="flex h-full min-h-0 w-full overflow-hidden bg-background">
      {headings.length > 0 ? (
        <aside
          className={
            showOutline
              ? "w-52 shrink-0 overflow-y-auto border-border border-r"
              : "w-9 shrink-0 border-border border-r"
          }
        >
          <div className="flex h-9 items-center px-1">
            <Button
              aria-label="Toggle document outline"
              className="size-7 p-0"
              onClick={() => setShowOutline((v) => !v)}
              size="sm"
              type="button"
              variant="ghost"
            >
              <SidebarLeftIcon className="size-4" />
            </Button>
          </div>
          {showOutline ? (
            <nav className="space-y-0.5 px-2 pb-4">
              {headings.map((heading) => (
                <a
                  className={
                    heading.level === 1
                      ? "block truncate rounded-md px-2 py-1 font-medium text-foreground text-xs hover:bg-muted"
                      : heading.level === 2
                        ? "block truncate rounded-md py-1 pr-2 pl-4 text-muted-foreground text-xs hover:bg-muted"
                        : "block truncate rounded-md py-1 pr-2 pl-6 text-muted-foreground/80 text-xs hover:bg-muted"
                  }
                  href={`#${heading.id}`}
                  key={heading.id}
                >
                  {heading.text}
                </a>
              ))}
            </nav>
          ) : null}
        </aside>
      ) : null}

      <main className="min-h-0 flex-1 overflow-y-auto px-8 py-10">
        <div className="mx-auto w-full max-w-[42rem]">
          {preview.markdown ? (
            <SafeMarkdownPreview
              className="artifact-canvas-markdown leading-7"
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
  );
}

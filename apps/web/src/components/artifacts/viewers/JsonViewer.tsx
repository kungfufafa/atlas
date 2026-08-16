import type { JsonPreview } from "@atlas/core";
import {
  Copy01Icon,
  Download01Icon,
  SourceCodeIcon,
  Tick01Icon,
} from "hugeicons-react";
import { useState } from "react";
import { CodeBlock } from "@/components/ai-elements/code-block";
import { Button } from "@/components/ui/button";

export function JsonViewer({
  preview,
  downloadUrl,
}: {
  preview: JsonPreview;
  downloadUrl: string;
}) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    await navigator.clipboard.writeText(preview.formatted);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      {/* Top Toolbar */}
      <div className="flex items-center justify-between border-border border-b bg-card px-4 py-2 text-sm shadow-xs">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <SourceCodeIcon className="size-4" />
          </div>
          <span className="truncate font-semibold text-foreground text-xs sm:text-sm">
            {preview.filename}
          </span>
          <span className="rounded bg-muted px-2 py-0.5 font-medium text-[11px] text-muted-foreground">
            {preview.isArray
              ? `Array (${preview.itemCount ?? 0} items)`
              : `Object (${preview.itemCount ?? 0} keys)`}{" "}
            · {preview.lineCount} lines
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Button
            aria-label="Copy JSON"
            className="h-7 gap-1 px-2.5 text-xs"
            onClick={handleCopy}
            size="sm"
            type="button"
            variant="outline"
          >
            {copied ? (
              <>
                <Tick01Icon className="size-3.5 text-emerald-500" />
                Copied
              </>
            ) : (
              <>
                <Copy01Icon className="size-3.5" />
                Copy
              </>
            )}
          </Button>

          <a
            aria-label="Download JSON"
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2.5 font-medium text-foreground text-xs shadow-2xs transition-colors hover:bg-accent hover:text-foreground"
            download={preview.filename}
            href={downloadUrl}
          >
            <Download01Icon className="size-3.5" />
            Download
          </a>
        </div>
      </div>

      {/* Main JSON Code View */}
      <main className="min-h-0 flex-1 overflow-auto bg-card/60 p-4">
        <div className="h-full rounded-lg border border-border bg-background shadow-xs">
          <CodeBlock code={preview.formatted} fillHeight lang="json" />
        </div>
      </main>
    </div>
  );
}

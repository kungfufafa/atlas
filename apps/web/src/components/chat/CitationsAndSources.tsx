import type { SourceItem } from "@atlas/core";
import { BookOpen01Icon, Globe02Icon, Link01Icon } from "hugeicons-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

export function InlineCitationBadge({
  index,
  source,
}: {
  index: number;
  source?: SourceItem;
}) {
  const [open, setOpen] = useState(false);

  return (
    <span className="relative mx-0.5 inline-block align-baseline">
      <button
        aria-label={`Citation [${index}]`}
        className={cn(
          "inline-flex h-4 min-w-4 items-center justify-center rounded-sm px-1 font-medium text-[10px] leading-none transition-colors",
          "bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary-foreground focus:outline-none focus:ring-1 focus:ring-primary/40"
        )}
        onClick={() => setOpen(!open)}
        type="button"
      >
        {index}
      </button>

      {open && source ? (
        <div
          className="fade-in zoom-in-95 absolute bottom-full left-1/2 z-50 mb-1.5 w-72 -translate-x-1/2 animate-in space-y-2 rounded-lg border bg-popover p-3 text-popover-foreground text-xs shadow-lg duration-100"
          role="dialog"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <Globe02Icon className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate font-semibold">
                {source.publisher || source.domain || "Source"}
              </span>
            </div>
            {source.type ? (
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-semibold text-[9px] text-muted-foreground uppercase tracking-wider">
                {source.type}
              </span>
            ) : null}
          </div>

          <p className="line-clamp-2 font-medium text-foreground text-xs">
            {source.title}
          </p>

          {source.snippet ? (
            <p className="line-clamp-3 rounded border border-border/40 bg-muted/30 p-1.5 text-[11px] text-muted-foreground">
              “{source.snippet}”
            </p>
          ) : null}

          <div className="flex items-center justify-between border-border/50 border-t pt-1">
            <span className="max-w-[160px] truncate text-[10px] text-muted-foreground">
              {source.domain || source.url}
            </span>
            {source.url ? (
              <a
                className="inline-flex items-center gap-1 font-medium text-[11px] text-primary hover:underline"
                href={source.url}
                rel="noopener noreferrer"
                target="_blank"
              >
                <Link01Icon className="size-3" />
                Open
              </a>
            ) : null}
          </div>
        </div>
      ) : null}
    </span>
  );
}

export function SourcesPanel({
  sources,
  citedCount,
  reviewedCount,
}: {
  sources: SourceItem[];
  citedCount?: number;
  reviewedCount?: number;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!sources || sources.length === 0) {
    return null;
  }

  const displayCount = citedCount ?? sources.length;
  const totalReviewed = reviewedCount ?? sources.length;

  return (
    <div className="my-2 space-y-2 rounded-lg border bg-card/60 p-2.5 backdrop-blur-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BookOpen01Icon className="size-4 text-primary" />
          <span className="font-semibold text-foreground text-xs">
            Sources · {displayCount} cited
          </span>
          {totalReviewed > displayCount ? (
            <span className="text-[11px] text-muted-foreground">
              ({totalReviewed} reviewed)
            </span>
          ) : null}
        </div>
        <button
          className="font-medium text-muted-foreground text-xs transition-colors hover:text-foreground"
          onClick={() => setExpanded(!expanded)}
          type="button"
        >
          {expanded ? "Hide" : "View all"}
        </button>
      </div>

      {expanded ? (
        <div className="grid grid-cols-1 gap-2 pt-1 sm:grid-cols-2">
          {sources.map((src, i) => (
            <a
              className="group flex items-start gap-2 rounded-md border border-border/50 bg-background/60 p-2 text-left transition-colors hover:bg-accent/40"
              href={src.url}
              key={src.id || i}
              rel="noopener noreferrer"
              target="_blank"
            >
              <div className="flex size-5 shrink-0 items-center justify-center rounded bg-muted font-semibold text-[10px] text-muted-foreground transition-colors group-hover:bg-primary group-hover:text-primary-foreground">
                {i + 1}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-foreground text-xs transition-colors group-hover:text-primary">
                  {src.title || src.domain}
                </p>
                <p className="truncate text-[10px] text-muted-foreground">
                  {src.publisher || src.domain || src.url}
                </p>
              </div>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

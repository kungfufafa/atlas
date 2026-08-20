import type { SourceItem } from "@atlas/core";
import { Globe02Icon, Link01Icon } from "hugeicons-react";
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
          "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        )}
        onClick={() => setOpen(!open)}
        type="button"
      >
        {index}
      </button>

      {open && source ? (
        <div
          className="fade-in zoom-in-95 absolute bottom-full left-1/2 z-50 mb-1.5 w-72 -translate-x-1/2 animate-in space-y-2 rounded-lg border bg-popover p-3 text-popover-foreground text-xs shadow-md duration-100"
          role="dialog"
        >
          <div className="flex min-w-0 items-center gap-1.5">
            <Globe02Icon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate font-medium">
              {source.publisher || source.domain || "Source"}
            </span>
          </div>

          <p className="line-clamp-2 text-foreground">{source.title}</p>

          {source.url ? (
            <a
              className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
              href={source.url}
              rel="noopener noreferrer"
              target="_blank"
            >
              <Link01Icon className="size-3" />
              {source.domain || source.url}
            </a>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}

const VISIBLE_SOURCE_CHIPS = 5;

export function SourcesPanel({
  sources,
}: {
  sources: SourceItem[];
  citedCount?: number;
  reviewedCount?: number;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!sources || sources.length === 0) {
    return null;
  }

  const chips = sources.slice(0, VISIBLE_SOURCE_CHIPS);
  const extra = sources.length - chips.length;

  return (
    <div className="flex w-full max-w-xl flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          aria-expanded={expanded}
          className="rounded-md px-1.5 py-0.5 font-medium text-foreground text-sm hover:bg-muted"
          onClick={() => setExpanded((current) => !current)}
          type="button"
        >
          Sources
          <span className="ml-1.5 text-muted-foreground">{sources.length}</span>
        </button>
        {chips.map((source) => (
          <a
            className="max-w-[9rem] truncate rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs hover:bg-muted/80 hover:text-foreground"
            href={source.url}
            key={source.id || source.url}
            rel="noopener noreferrer"
            target="_blank"
          >
            {source.domain || source.title || source.url}
          </a>
        ))}
        {extra > 0 ? (
          <button
            className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs hover:bg-muted/80 hover:text-foreground"
            onClick={() => setExpanded(true)}
            type="button"
          >
            +{extra}
          </button>
        ) : null}
      </div>

      {expanded ? (
        <ul className="flex flex-col gap-0.5">
          {sources.map((source) => (
            <li key={source.id || source.url}>
              <a
                className="flex items-baseline gap-2 rounded-md px-1.5 py-1 hover:bg-muted/70"
                href={source.url}
                rel="noopener noreferrer"
                target="_blank"
              >
                <span className="min-w-0 truncate text-foreground text-sm">
                  {source.title || source.domain}
                </span>
                <span className="shrink-0 text-muted-foreground text-xs">
                  {source.domain}
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

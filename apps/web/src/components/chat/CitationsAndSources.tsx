import type { SourceItem } from "@atlas/core";
import { useState } from "react";

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

import { ArrowDown01Icon } from "hugeicons-react";
import type { RefObject } from "react";
import {
  findHeadingElement,
  MARKDOWN_TOC_MIN_HEADINGS,
  type MarkdownHeading,
} from "@/lib/markdown-toc";
import { cn } from "@/lib/utils";

const LEVEL_INDENT: Record<MarkdownHeading["level"], string> = {
  1: "pl-0",
  2: "pl-3",
  3: "pl-6",
};

function navigateToHeading(
  contentRef: RefObject<HTMLElement | null>,
  heading: MarkdownHeading
) {
  const element = findHeadingElement(contentRef.current, heading);
  if (!element) {
    return;
  }

  const reduceMotion = window.matchMedia?.(
    "(prefers-reduced-motion: reduce)"
  )?.matches;
  element.scrollIntoView({
    behavior: reduceMotion ? "auto" : "smooth",
    block: "start",
  });
  element.tabIndex = -1;
  element.focus({ preventScroll: true });
}

export function ArtifactMarkdownToc({
  contentRef,
  headings,
}: {
  contentRef: RefObject<HTMLElement | null>;
  headings: MarkdownHeading[];
}) {
  if (headings.length < MARKDOWN_TOC_MIN_HEADINGS) {
    return null;
  }

  return (
    <details
      className="group rounded-lg border border-border bg-muted/40 px-3 py-2"
      open
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded font-medium text-muted-foreground text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ArrowDown01Icon
          aria-hidden
          className="size-3.5 -rotate-90 transition-transform group-open:rotate-0"
        />
        Contents
      </summary>
      <nav aria-label="Table of contents" className="mt-2">
        <ul className="space-y-0.5">
          {headings.map((heading) => (
            <li className={LEVEL_INDENT[heading.level]} key={heading.slug}>
              <button
                className={cn(
                  "block w-full truncate rounded px-1 py-0.5 text-left text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                  heading.level === 1 && "font-medium text-foreground"
                )}
                onClick={() => navigateToHeading(contentRef, heading)}
                title={heading.text}
                type="button"
              >
                {heading.text}
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </details>
  );
}

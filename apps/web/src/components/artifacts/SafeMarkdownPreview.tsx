import { useMemo, useRef } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import { ArtifactMarkdownToc } from "@/components/artifacts/ArtifactMarkdownToc";
import {
  MAX_MARKDOWN_PREVIEW_CHARS,
  truncatePreviewText,
} from "@/lib/artifact-preview-limits";
import {
  extractMarkdownHeadings,
  MARKDOWN_TOC_MIN_HEADINGS,
} from "@/lib/markdown-toc";
import { cn } from "@/lib/utils";

export function SafeMarkdownPreview({
  content,
  className,
  showTableOfContents = false,
  streaming = false,
}: {
  content: string;
  className?: string;
  showTableOfContents?: boolean;
  streaming?: boolean;
}) {
  const { text, truncated } = truncatePreviewText(
    content,
    MAX_MARKDOWN_PREVIEW_CHARS
  );
  const renderedRef = useRef<HTMLDivElement>(null);
  const headings = useMemo(
    () => (showTableOfContents ? extractMarkdownHeadings(text) : []),
    [showTableOfContents, text]
  );
  const hasTableOfContents = headings.length >= MARKDOWN_TOC_MIN_HEADINGS;

  return (
    <div className="min-h-0" ref={renderedRef}>
      {truncated ? (
        <p className="mb-3 text-muted-foreground text-xs">
          Preview truncated. Download the original to see the rest.
        </p>
      ) : null}
      <ArtifactMarkdownToc contentRef={renderedRef} headings={headings} />
      <MessageResponse
        className={cn("text-sm", hasTableOfContents && "mt-4", className)}
        isAnimating={streaming}
      >
        {text}
      </MessageResponse>
    </div>
  );
}

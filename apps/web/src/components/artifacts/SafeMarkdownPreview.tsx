import { MessageResponse } from "@/components/ai-elements/message";
import {
  MAX_MARKDOWN_PREVIEW_CHARS,
  truncatePreviewText,
} from "@/lib/artifact-preview-limits";
import { cn } from "@/lib/utils";

export function SafeMarkdownPreview({
  content,
  className,
  streaming = false,
}: {
  content: string;
  className?: string;
  streaming?: boolean;
}) {
  const { text, truncated } = truncatePreviewText(
    content,
    MAX_MARKDOWN_PREVIEW_CHARS
  );

  return (
    <div className="min-h-0">
      {truncated ? (
        <p className="mb-3 text-muted-foreground text-xs">
          Preview truncated. Download the original to see the rest.
        </p>
      ) : null}
      <MessageResponse
        className={cn("text-sm", className)}
        isAnimating={streaming}
      >
        {text}
      </MessageResponse>
    </div>
  );
}

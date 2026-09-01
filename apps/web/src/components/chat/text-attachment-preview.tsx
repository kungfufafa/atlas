import { Cancel01Icon } from "hugeicons-react";
import { wordCountFromPastedFilename } from "@/lib/pasted-text";
import { cn } from "@/lib/utils";

interface TextAttachmentPreviewProps {
  className?: string;
  filename: string;
  onRemove?: () => void;
  url?: string;
  wordCount?: number;
}

export function TextAttachmentPreview({
  filename,
  wordCount,
  onRemove,
  className,
  url,
}: TextAttachmentPreviewProps) {
  const resolvedWordCount =
    wordCount ?? wordCountFromPastedFilename(filename) ?? undefined;
  const downloadable = Boolean(url && !onRemove);

  const attachmentClassName = cn(
    "relative inline-flex max-w-full shrink-0 items-center rounded-lg border border-border bg-muted px-3 py-2",
    onRemove ? "pr-8" : undefined,
    downloadable ? "transition-colors hover:bg-muted/70" : undefined,
    className
  );
  const content = (
    <>
      <div className="min-w-0">
        <p className="font-medium text-foreground text-xs">Pasted text</p>
        {resolvedWordCount == null ? null : (
          <p className="text-2xs text-muted-foreground">
            {resolvedWordCount} words
          </p>
        )}
      </div>
      {onRemove ? (
        <button
          aria-label={`Remove ${filename}`}
          className="absolute top-1 right-1 flex size-6 items-center justify-center rounded-full bg-transparent text-muted-foreground transition-colors hover:text-foreground"
          onClick={onRemove}
          type="button"
        >
          <Cancel01Icon className="size-3" />
        </button>
      ) : null}
    </>
  );

  return downloadable ? (
    <a className={attachmentClassName} download={filename} href={url}>
      {content}
    </a>
  ) : (
    <div className={attachmentClassName}>{content}</div>
  );
}

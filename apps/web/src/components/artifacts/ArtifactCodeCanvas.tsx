import { CodeBlock } from "@/components/ai-elements/code-block";
import { MessageResponse } from "@/components/ai-elements/message";
import { toCodeFence } from "@/lib/artifact-code-fence";
import { MAX_HIGHLIGHTED_CHARS } from "@/lib/artifact-preview-limits";
import { cn } from "@/lib/utils";

export function ArtifactCodeCanvas({
  code,
  language,
  streaming = false,
}: {
  code: string;
  language?: string | null;
  streaming?: boolean;
}) {
  const lang = language?.trim() || "text";
  const highlight = lang !== "text" && code.length <= MAX_HIGHLIGHTED_CHARS;

  return (
    <div
      className={cn(
        "artifact-code-canvas",
        // Streamdown ships a chat fence (rounded-xl, p-2, language header, 200px
        // placeholder). Beat those utilities here so the canvas is full-bleed.
        "[&_[data-streamdown=code-block-header]]:hidden",
        "[&_[data-streamdown=code-block]]:m-0 [&_[data-streamdown=code-block]]:gap-0 [&_[data-streamdown=code-block]]:rounded-none [&_[data-streamdown=code-block]]:border-0 [&_[data-streamdown=code-block]]:bg-background [&_[data-streamdown=code-block]]:p-0",
        "[&_[data-streamdown=code-block-body]]:rounded-none [&_[data-streamdown=code-block-body]]:border-0 [&_[data-streamdown=code-block-body]]:bg-background [&_[data-streamdown=code-block-body]]:p-0"
      )}
    >
      {highlight ? (
        <MessageResponse
          className="artifact-canvas-code !space-y-0 min-h-0 flex-1"
          controls={{ code: { copy: false, download: false }, table: false }}
          isAnimating={streaming}
          lineNumbers
        >
          {toCodeFence(code, lang)}
        </MessageResponse>
      ) : (
        <CodeBlock code={code} fillHeight lang={lang} showHeader={false} />
      )}
    </div>
  );
}

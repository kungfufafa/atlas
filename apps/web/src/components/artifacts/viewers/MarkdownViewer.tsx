import type { MarkdownPreview } from "@atlas/core";
import { SafeMarkdownPreview } from "@/components/artifacts/SafeMarkdownPreview";

export function MarkdownViewer({
  preview,
  editor,
}: {
  preview: MarkdownPreview;
  downloadUrl: string;
  editor?: {
    content: string;
    disabled: boolean;
    onChange: (content: string) => void;
  };
}) {
  if (editor) {
    return (
      <div className="flex min-h-0 flex-1 bg-background p-4">
        <textarea
          aria-label="Edit Markdown artifact"
          className="min-h-0 w-full flex-1 resize-none rounded-md border border-border bg-background p-4 font-mono text-sm leading-6 outline-none focus:ring-1 focus:ring-ring"
          disabled={editor.disabled}
          onChange={(event) => editor.onChange(event.target.value)}
          spellCheck={false}
          value={editor.content}
        />
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-background px-8 py-10">
      <div className="mx-auto w-full max-w-[42rem]">
        <SafeMarkdownPreview
          className="artifact-canvas-markdown leading-7"
          content={preview.content}
          showTableOfContents
        />
      </div>
    </div>
  );
}

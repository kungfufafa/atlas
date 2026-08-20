import type { MarkdownPreview } from "@atlas/core";
import { SafeMarkdownPreview } from "@/components/artifacts/SafeMarkdownPreview";

export function MarkdownViewer({
  preview,
}: {
  preview: MarkdownPreview;
  downloadUrl: string;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-background px-8 py-10">
      <div className="mx-auto w-full max-w-[42rem]">
        <SafeMarkdownPreview
          className="artifact-canvas-markdown leading-7"
          content={preview.content}
        />
      </div>
    </div>
  );
}

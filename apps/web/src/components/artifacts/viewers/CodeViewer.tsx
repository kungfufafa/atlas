import type { CodePreview } from "@atlas/core";
import { ArtifactCodeCanvas } from "@/components/artifacts/ArtifactCodeCanvas";

export function CodeViewer({
  preview,
}: {
  preview: CodePreview;
  downloadUrl: string;
}) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-background">
      <ArtifactCodeCanvas code={preview.content} language={preview.language} />
    </div>
  );
}

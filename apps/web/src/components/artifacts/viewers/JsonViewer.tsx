import type { JsonPreview } from "@atlas/core";
import { ArtifactCodeCanvas } from "@/components/artifacts/ArtifactCodeCanvas";

export function JsonViewer({
  preview,
}: {
  preview: JsonPreview;
  downloadUrl: string;
}) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-background">
      <ArtifactCodeCanvas code={preview.formatted} language="json" />
    </div>
  );
}

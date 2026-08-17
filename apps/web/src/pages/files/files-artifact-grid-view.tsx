import type { ArtifactFile } from "@atlas/core/contract";
import { ArtifactGridCard } from "@/pages/files/files-artifact-grid-card";

export function ArtifactGridView({
  profileId,
  artifacts,
  deletePending,
  onDelete,
  onPreview,
}: {
  profileId: string;
  artifacts: ArtifactFile[];
  deletePending: boolean;
  onDelete: (artifact: ArtifactFile) => void;
  onPreview: (artifact: ArtifactFile) => void;
}) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3">
      {artifacts.map((artifact) => (
        <ArtifactGridCard
          artifact={artifact}
          deletePending={deletePending}
          key={artifact.filename}
          onDelete={() => onDelete(artifact)}
          onPreview={() => onPreview(artifact)}
          profileId={profileId}
        />
      ))}
    </ul>
  );
}

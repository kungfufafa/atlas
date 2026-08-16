import type { ArtifactFile } from "@atlas/core/contract";
import { EyeIcon } from "hugeicons-react";
import { useArtifactWorkspace } from "@/components/artifacts/ArtifactWorkspaceContext";
import { formatBytes } from "@/lib/knowledge-base-files";
import { ArtifactIcon } from "@/pages/files/files-artifact-icon";
import { ArtifactRowMenu } from "@/pages/files/files-artifact-row-menu";
import { formatTimestamp } from "@/pages/files/files-shared";

export function ArtifactListView({
  profileId,
  artifacts,
  deletePending,
  onDelete,
}: {
  profileId: string;
  artifacts: ArtifactFile[];
  deletePending: boolean;
  onDelete: (artifact: ArtifactFile) => void;
}) {
  const { openArtifact } = useArtifactWorkspace();

  function handleOpenPreview(artifact: ArtifactFile) {
    openArtifact(
      {
        filename: artifact.filename,
        mimeType: artifact.mimeType,
        path: artifact.path || artifact.filename,
        profileId,
        sizeBytes: artifact.sizeBytes,
      },
      profileId
    );
  }

  return (
    <ul className="divide-y divide-border">
      {artifacts.map((artifact) => (
        <li
          className="flex items-center justify-between gap-3 px-4 py-3 transition-colors duration-100 ease-out hover:bg-muted/40"
          key={artifact.filename}
        >
          <div
            className="flex min-w-0 flex-1 cursor-pointer items-start gap-3"
            onClick={() => handleOpenPreview(artifact)}
          >
            <ArtifactIcon
              className="mt-0.5"
              filename={artifact.filename}
              mimeType={artifact.mimeType}
            />
            <div className="min-w-0">
              <p className="truncate font-medium text-foreground text-sm transition-colors hover:text-primary">
                {artifact.filename}
              </p>
              <p className="text-pretty text-muted-foreground text-xs">
                {artifact.mimeType} ·{" "}
                <span className="tabular-nums">
                  {formatBytes(artifact.sizeBytes)}
                </span>
                {" · "}
                {formatTimestamp(artifact.updatedAt)}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              aria-label={`Preview ${artifact.filename}`}
              className="inline-flex size-7 items-center justify-center rounded-md border border-border/60 bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => handleOpenPreview(artifact)}
              type="button"
            >
              <EyeIcon className="size-3.5" />
            </button>
            <ArtifactRowMenu
              artifact={artifact}
              deletePending={deletePending}
              onDelete={() => onDelete(artifact)}
              profileId={profileId}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

import type { ArtifactFile } from "@atlas/core/contract";
import { EyeIcon } from "hugeicons-react";
import {
  ARTIFACT_TYPE_FILTER_LABELS,
  classifyArtifactType,
} from "@/components/soul-tools/artifacts-tab-filters";
import {
  buildArtifactContentUrl,
  buildArtifactThumbnailUrl,
} from "@/lib/chat-artifacts";
import { formatBytes } from "@/lib/knowledge-base-files";
import { ArtifactIcon } from "@/pages/files/files-artifact-icon";
import { ArtifactRowMenu } from "@/pages/files/files-artifact-row-menu";
import { formatTimestamp } from "@/pages/files/files-shared";

export function ArtifactGridCard({
  profileId,
  artifact,
  deletePending,
  onDelete,
  onPreview,
}: {
  profileId: string;
  artifact: ArtifactFile;
  deletePending: boolean;
  onDelete: () => void;
  onPreview: () => void;
}) {
  const kind = classifyArtifactType(artifact);
  const typeLabel = ARTIFACT_TYPE_FILTER_LABELS[kind];
  const isImage = kind === "image";
  const isOffice = /\.(pptx|ppt|docx|doc|xlsx|xls|odp|odt|ods)$/i.test(
    artifact.filename
  );
  const thumbSrc = isImage
    ? buildArtifactContentUrl(
        profileId,
        artifact.path || artifact.filename,
        true
      )
    : isOffice
      ? buildArtifactThumbnailUrl(profileId, artifact.path || artifact.filename)
      : null;

  return (
    <li className="flex min-w-0 flex-col overflow-hidden rounded-md border border-border bg-background">
      <button
        aria-label={`Preview ${artifact.filename}`}
        className="relative aspect-[4/3] overflow-hidden border-border border-b bg-muted/20"
        onClick={onPreview}
        type="button"
      >
        {thumbSrc ? (
          <img
            alt=""
            className="absolute inset-0 h-full w-full object-cover"
            onError={(event) => {
              event.currentTarget.style.display = "none";
            }}
            src={thumbSrc}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <ArtifactIcon
              className="mt-0 size-8"
              filename={artifact.filename}
              mimeType={artifact.mimeType}
            />
          </div>
        )}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
        <button
          className="min-w-0 flex-1 space-y-1 text-left"
          onClick={onPreview}
          type="button"
        >
          <p className="truncate font-medium text-foreground text-sm transition-colors hover:text-primary">
            {artifact.filename}
          </p>
          <p className="text-pretty text-muted-foreground text-xs">
            {typeLabel}
            {" · "}
            <span className="tabular-nums">
              {formatBytes(artifact.sizeBytes)}
            </span>
          </p>
          <p className="truncate text-muted-foreground text-xs">
            {formatTimestamp(artifact.updatedAt)}
          </p>
        </button>
        <div className="mt-auto flex items-center justify-end gap-1.5">
          <button
            aria-label={`Preview ${artifact.filename}`}
            className="inline-flex size-7 items-center justify-center rounded-md border border-border/60 bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={onPreview}
            type="button"
          >
            <EyeIcon className="size-3.5" />
          </button>
          <ArtifactRowMenu
            artifact={artifact}
            deletePending={deletePending}
            onDelete={onDelete}
            profileId={profileId}
          />
        </div>
      </div>
    </li>
  );
}

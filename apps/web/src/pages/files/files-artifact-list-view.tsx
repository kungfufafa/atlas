import type { ArtifactFile } from "@atlas/core/contract";
import { ArrowRight01Icon, EyeIcon, Folder01Icon } from "hugeicons-react";
import { formatBytes } from "@/lib/knowledge-base-files";
import { cn } from "@/lib/utils";
import {
  type ArtifactFolderEntry,
  artifactBasename,
  artifactFolderFileLabel,
} from "@/pages/files/files-artifact-folders";
import { ArtifactIcon } from "@/pages/files/files-artifact-icon";
import { ArtifactRowMenu } from "@/pages/files/files-artifact-row-menu";
import { formatTimestamp } from "@/pages/files/files-shared";

function ArtifactFolderRow({
  folder,
  onOpen,
}: {
  folder: ArtifactFolderEntry;
  onOpen: (prefix: string) => void;
}) {
  return (
    <li>
      <button
        className={cn(
          "flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-3 text-left transition-colors duration-100 ease-out",
          "hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
        )}
        onClick={() => onOpen(folder.prefix)}
        type="button"
      >
        <div className="flex min-w-0 items-start gap-3">
          <Folder01Icon
            aria-hidden
            className="mt-0.5 size-4 text-muted-foreground"
          />
          <div className="min-w-0">
            <p className="truncate font-medium text-foreground text-sm">
              {folder.name}
            </p>
            <p className="text-pretty text-muted-foreground text-xs">
              <span className="tabular-nums">
                {artifactFolderFileLabel(folder.fileCount)}
              </span>
              {" · "}
              {formatTimestamp(folder.latestUpdatedAt)}
            </p>
          </div>
        </div>
        <ArrowRight01Icon
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground"
        />
      </button>
    </li>
  );
}

export function ArtifactListView({
  profileId,
  folders,
  artifacts,
  deletePending,
  showFullPath,
  onDelete,
  onOpenFolder,
  onPreview,
}: {
  profileId: string;
  folders: ArtifactFolderEntry[];
  artifacts: ArtifactFile[];
  deletePending: boolean;
  showFullPath: boolean;
  onDelete: (artifact: ArtifactFile) => void;
  onOpenFolder: (prefix: string) => void;
  onPreview: (artifact: ArtifactFile) => void;
}) {
  return (
    <ul className="divide-y divide-border">
      {folders.map((folder) => (
        <ArtifactFolderRow
          folder={folder}
          key={folder.prefix}
          onOpen={onOpenFolder}
        />
      ))}
      {artifacts.map((artifact) => (
        <li
          className="flex items-center justify-between gap-3 px-4 py-3 transition-colors duration-100 ease-out hover:bg-muted/40"
          key={artifact.filename}
        >
          <button
            className="flex min-w-0 flex-1 items-start gap-3 text-left"
            onClick={() => onPreview(artifact)}
            type="button"
          >
            <ArtifactIcon
              className="mt-0.5"
              filename={artifact.filename}
              mimeType={artifact.mimeType}
            />
            <div className="min-w-0">
              <p className="truncate font-medium text-foreground text-sm transition-colors hover:text-primary">
                {showFullPath
                  ? artifact.filename
                  : artifactBasename(artifact.filename)}
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
          </button>
          <div className="flex items-center gap-1.5">
            <button
              aria-label={`Preview ${artifact.filename}`}
              className="inline-flex size-7 items-center justify-center rounded-md border border-border/60 bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => onPreview(artifact)}
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

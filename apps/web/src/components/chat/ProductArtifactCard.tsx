import type { Artifact } from "@atlas/core";
import {
  Download01Icon,
  EyeIcon,
  File01Icon,
  Image01Icon,
  Presentation01Icon,
  SourceCodeIcon,
  TableIcon,
} from "hugeicons-react";
import { useArtifactWorkspace } from "@/components/artifacts/ArtifactWorkspaceContext";
import { client } from "@/lib/client";

export function ProductArtifactCard({
  artifact,
  profileId = "default",
  onPreview,
  onDownload,
}: {
  artifact: Artifact;
  profileId?: string;
  onPreview?: (artifact: Artifact) => void;
  onDownload?: (artifact: Artifact) => void;
}) {
  const { openArtifact } = useArtifactWorkspace();

  const isPresentation =
    artifact.type === "presentation" || artifact.filename.endsWith(".pptx");
  const isSpreadsheet =
    artifact.type === "spreadsheet" ||
    artifact.filename.endsWith(".xlsx") ||
    artifact.filename.endsWith(".csv");
  const isDocument =
    artifact.type === "document" ||
    artifact.filename.endsWith(".docx") ||
    artifact.filename.endsWith(".pdf");
  const isImage =
    artifact.type === "image" ||
    /\.(png|jpe?g|webp|gif|svg)$/i.test(artifact.filename);
  const isCode = /\.(ts|tsx|js|jsx|py|go|rs|json|sh|html|css)$/i.test(
    artifact.filename
  );

  let Icon = File01Icon;
  let typeLabel = "Deliverable";
  let metaSubtitle = artifact.size
    ? `${Math.round(artifact.size / 1024)} KB`
    : "Ready";

  if (isPresentation) {
    Icon = Presentation01Icon;
    typeLabel = "PowerPoint";
    const slides =
      (artifact.metadata?.slides as number) ??
      (artifact.metadata?.slideCount as number);
    if (slides) {
      metaSubtitle = `${slides} slide${slides === 1 ? "" : "s"}`;
    }
  } else if (isSpreadsheet) {
    Icon = TableIcon;
    typeLabel = artifact.filename.endsWith(".csv")
      ? "CSV Table"
      : "Excel Workbook";
    const sheets =
      (artifact.metadata?.sheets as number) ??
      (artifact.metadata?.sheetCount as number);
    const rows =
      (artifact.metadata?.rows as number) ??
      (artifact.metadata?.rowCount as number);
    if (sheets && rows) {
      metaSubtitle = `${sheets} sheet${sheets === 1 ? "" : "s"} · ${rows} rows`;
    } else if (rows) {
      metaSubtitle = `${rows} rows`;
    }
  } else if (isDocument) {
    Icon = File01Icon;
    typeLabel = artifact.filename.endsWith(".pdf")
      ? "PDF Document"
      : "Word Document";
    const pages =
      (artifact.metadata?.pages as number) ??
      (artifact.metadata?.pageCount as number);
    if (pages) {
      metaSubtitle = `${pages} page${pages === 1 ? "" : "s"}`;
    }
  } else if (isImage) {
    Icon = Image01Icon;
    typeLabel = "Image";
  } else if (isCode) {
    Icon = SourceCodeIcon;
    typeLabel = "Source Code";
  }

  const revisionLabel = artifact.revision ? `v${artifact.revision}` : "v1";
  const downloadUrl = client.getProfileArtifactDownloadUrl(
    profileId,
    artifact.path || artifact.filename
  );

  function handlePreviewClick() {
    if (onPreview) {
      onPreview(artifact);
    } else {
      openArtifact(
        {
          artifactId: artifact.id,
          filename: artifact.filename,
          path: artifact.path || artifact.filename,
          profileId,
          revision: artifact.revision,
          sizeBytes: artifact.size,
        },
        profileId
      );
    }
  }

  return (
    <div className="my-2.5 rounded-xl border border-border/70 bg-gradient-to-br from-card to-card/60 p-4 shadow-sm backdrop-blur-sm transition-all hover:border-primary/40 hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <div
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-3"
          onClick={handlePreviewClick}
        >
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Icon className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h4 className="truncate font-semibold text-foreground text-sm">
                {artifact.filename}
              </h4>
              <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-bold text-[10px] text-muted-foreground uppercase tracking-wider">
                {revisionLabel}
              </span>
            </div>
            <p className="mt-0.5 text-muted-foreground text-xs">
              {typeLabel} · {metaSubtitle}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <button
            className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background px-2.5 py-1.5 font-medium text-xs transition-colors hover:bg-accent"
            onClick={handlePreviewClick}
            type="button"
          >
            <EyeIcon className="size-3.5" />
            Preview
          </button>
          <a
            aria-label="Download artifact"
            className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 font-medium text-primary-foreground text-xs shadow-xs transition-colors hover:bg-primary/90"
            download={artifact.filename}
            href={downloadUrl}
            onClick={() => onDownload?.(artifact)}
          >
            <Download01Icon className="size-3.5" />
            Download
          </a>
        </div>
      </div>
    </div>
  );
}

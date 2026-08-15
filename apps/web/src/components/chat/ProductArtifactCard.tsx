import type { Artifact } from "@atlas/core";
import {
  Download01Icon,
  EyeIcon,
  File01Icon,
  Presentation01Icon,
  TableIcon,
} from "hugeicons-react";

export function ProductArtifactCard({
  artifact,
  onPreview,
  onDownload,
}: {
  artifact: Artifact;
  onPreview?: (artifact: Artifact) => void;
  onDownload?: (artifact: Artifact) => void;
}) {
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

  let Icon = File01Icon;
  let typeLabel = "Deliverable";
  let metaSubtitle = `${Math.round(artifact.size / 1024)} KB`;

  if (isPresentation) {
    Icon = Presentation01Icon;
    typeLabel = "PowerPoint";
    const slides = (artifact.metadata?.slides as number) ?? 8;
    metaSubtitle = `${slides} slides`;
  } else if (isSpreadsheet) {
    Icon = TableIcon;
    typeLabel = "Excel Workbook";
    const sheets = (artifact.metadata?.sheets as number) ?? 3;
    const rows = (artifact.metadata?.rows as number) ?? 241;
    metaSubtitle = `${sheets} sheets · ${rows} rows`;
  } else if (isDocument) {
    Icon = File01Icon;
    typeLabel = artifact.filename.endsWith(".pdf")
      ? "PDF Document"
      : "DOCX Document";
    const pages = (artifact.metadata?.pages as number) ?? 12;
    metaSubtitle = `${pages} pages`;
  }

  const revisionLabel = artifact.revision ? `v${artifact.revision}` : "v1";

  return (
    <div className="my-2.5 rounded-xl border border-border/70 bg-gradient-to-br from-card to-card/60 p-4 shadow-sm backdrop-blur-sm transition-all hover:border-primary/40 hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
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
          {onPreview ? (
            <button
              className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background px-2.5 py-1.5 font-medium text-xs transition-colors hover:bg-accent"
              onClick={() => onPreview(artifact)}
              type="button"
            >
              <EyeIcon className="size-3.5" />
              Preview
            </button>
          ) : null}
          <a
            className="inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1.5 font-medium text-primary-foreground text-xs shadow-xs transition-colors hover:bg-primary/90"
            download={artifact.filename}
            href={`/v1/profiles/default/artifacts/${encodeURIComponent(artifact.path || artifact.filename)}`}
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

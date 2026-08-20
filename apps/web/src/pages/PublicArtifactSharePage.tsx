import { Download04Icon } from "hugeicons-react";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { ArtifactAttachmentPanelBody } from "@/components/chat/artifact-attachment-panel-body";
import { usePublicArtifactShare } from "@/hooks/use-public-artifact-share";
import {
  buildPublicArtifactShareDownloadUrl,
  resolvePublicArtifactShareView,
} from "@/lib/chat-artifacts";
import { client } from "@/lib/client";
import { cn } from "@/lib/utils";

export function PublicArtifactSharePage() {
  const { token = "" } = useParams();
  const [sheetOptions, setSheetOptions] = useState<{
    sheet?: string;
    sheetIndex?: number;
  }>({});
  const {
    data,
    isLoading,
    error: loadError,
  } = usePublicArtifactShare(token, sheetOptions);
  const metadata = data?.metadata ?? null;
  const content = data?.content ?? null;
  const preview = data?.preview ?? null;
  const error = token
    ? loadError instanceof Error
      ? loadError.message
      : loadError
        ? "Unable to load share."
        : null
    : "Share link not found.";
  const loading = token.length > 0 && isLoading;

  const view = metadata
    ? resolvePublicArtifactShareView({
        baseUrl: client.baseUrl,
        content,
        filename: metadata.filename,
        mimeType: metadata.mimeType,
        token,
      })
    : { kind: "download" as const };
  const showRichPreview =
    view.kind === "rich" &&
    preview != null &&
    preview.status !== "failed" &&
    preview.status !== "unsupported";
  const isFullBleed =
    view.kind === "html" || (view.kind === "rich" && showRichPreview);
  const canPreview = view.kind !== "download";

  const artifact = useMemo(
    () =>
      metadata
        ? {
            filename: metadata.filename,
            mimeType: metadata.mimeType,
            path: metadata.filename,
            savedAt: "",
            sizeBytes: metadata.sizeBytes,
          }
        : null,
    [metadata]
  );

  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "referrer";
    meta.content = "no-referrer";
    document.head.append(meta);
    return () => {
      meta.remove();
    };
  }, []);

  const downloadUrl = token
    ? buildPublicArtifactShareDownloadUrl(token, client.baseUrl)
    : "";

  return (
    <div
      className={cn(
        "artifact-share-page bg-background text-foreground",
        isFullBleed
          ? "flex h-svh flex-col overflow-hidden"
          : "h-svh overflow-y-auto"
      )}
    >
      <header className="border-border border-b px-3 py-1.5">
        <div className="flex items-center justify-between gap-3">
          <p className="truncate font-medium text-xs">
            {metadata?.filename ?? "Shared artifact"}
          </p>
          {token ? (
            <a
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2 py-1 font-medium text-xs hover:bg-muted"
              download={metadata?.filename}
              href={downloadUrl}
            >
              <Download04Icon className="h-3 w-3" />
              Download
            </a>
          ) : null}
        </div>
      </header>

      <main
        className={cn(
          isFullBleed
            ? "flex min-h-0 flex-1 flex-col overflow-hidden"
            : "mx-auto max-w-5xl px-4 py-6"
        )}
      >
        {loading ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : error ? (
          <p className="text-destructive text-sm">{error}</p>
        ) : artifact && view.kind === "image" ? (
          <ArtifactAttachmentPanelBody
            artifact={artifact}
            canPreview={canPreview}
            error={null}
            imagePreviewUrl={view.previewUrl}
            kind="image"
            loading={false}
          />
        ) : artifact && view.kind === "video" ? (
          <ArtifactAttachmentPanelBody
            artifact={artifact}
            canPreview={canPreview}
            error={null}
            kind="video"
            loading={false}
            videoPreviewUrl={view.previewUrl}
          />
        ) : artifact && view.kind === "html" ? (
          <ArtifactAttachmentPanelBody
            artifact={artifact}
            canPreview={canPreview}
            content={view.content}
            error={null}
            kind="html"
            loading={false}
          />
        ) : artifact && view.kind === "svg" ? (
          <ArtifactAttachmentPanelBody
            artifact={artifact}
            canPreview={canPreview}
            content={view.content}
            error={null}
            kind="svg"
            loading={false}
          />
        ) : artifact && view.kind === "text" ? (
          <ArtifactAttachmentPanelBody
            artifact={artifact}
            canPreview={canPreview}
            content={view.content}
            error={null}
            format={view.format}
            kind="text"
            language={view.language}
            loading={false}
          />
        ) : artifact && showRichPreview ? (
          <ArtifactAttachmentPanelBody
            artifact={artifact}
            canPreview={canPreview}
            downloadUrl={downloadUrl}
            error={null}
            kind="rich"
            loading={false}
            onSelectSheet={(sheetName, sheetIndex) => {
              setSheetOptions({ sheet: sheetName, sheetIndex });
            }}
            preview={preview}
          />
        ) : (
          <div className="space-y-3 text-muted-foreground text-sm">
            <p>This file is available for download.</p>
            {downloadUrl ? (
              <a
                className="font-medium text-foreground underline"
                download={metadata?.filename}
                href={downloadUrl}
              >
                Download {metadata?.filename}
              </a>
            ) : null}
          </div>
        )}
      </main>
    </div>
  );
}

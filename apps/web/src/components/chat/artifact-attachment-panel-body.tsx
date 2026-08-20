import type { ArtifactPreview } from "@atlas/core";
import type { ReactNode } from "react";
import { ArtifactCodeCanvas } from "@/components/artifacts/ArtifactCodeCanvas";
import { HtmlPreviewFrame } from "@/components/artifacts/HtmlPreviewFrame";
import { SafeMarkdownPreview } from "@/components/artifacts/SafeMarkdownPreview";
import { SvgPreview } from "@/components/artifacts/SvgPreview";
import { DocumentViewer } from "@/components/artifacts/viewers/DocumentViewer";
import { PdfViewer } from "@/components/artifacts/viewers/PdfViewer";
import { PresentationViewer } from "@/components/artifacts/viewers/PresentationViewer";
import { SpreadsheetViewer } from "@/components/artifacts/viewers/SpreadsheetViewer";
import { Spinner } from "@/components/ui/spinner";
import {
  markdownForMermaidSource,
  mermaidPreviewError,
} from "@/lib/artifact-mermaid-preview";
import type { ChatArtifactRef } from "@/lib/chat-artifacts";
import { cn } from "@/lib/utils";

type ArtifactPanelSharedProps = {
  loading: boolean;
  error: string | null;
  canPreview: boolean;
  artifact: ChatArtifactRef;
};

export type ArtifactAttachmentPanelBodyProps =
  | (ArtifactPanelSharedProps & {
      kind: "rich";
      preview: ArtifactPreview | null;
      downloadUrl: string;
      onSelectSheet?: (sheetName: string, sheetIndex?: number) => void;
    })
  | (ArtifactPanelSharedProps & {
      kind: "image";
      imagePreviewUrl?: string | null;
    })
  | (ArtifactPanelSharedProps & {
      kind: "video";
      videoPreviewUrl?: string | null;
    })
  | (ArtifactPanelSharedProps & {
      kind: "html";
      content: string | null;
    })
  | (ArtifactPanelSharedProps & {
      kind: "svg";
      content: string | null;
    })
  | (ArtifactPanelSharedProps & {
      kind: "text";
      content: string | null;
      format: "markdown" | "plain" | "mermaid";
      language: string | null;
      streaming?: boolean;
    });

function renderTextContent({
  content,
  format,
  language,
  streaming = false,
}: {
  content: string;
  format: "markdown" | "plain" | "mermaid";
  language: string | null;
  streaming?: boolean;
}) {
  if (format === "mermaid") {
    const mermaidError = mermaidPreviewError(content);
    if (mermaidError) {
      return (
        <p className="p-6 text-muted-foreground text-sm">{mermaidError}</p>
      );
    }
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-8">
        <SafeMarkdownPreview
          content={markdownForMermaidSource(content)}
          streaming={streaming}
        />
      </div>
    );
  }

  if (format === "markdown") {
    return (
      <div className="mx-auto w-full max-w-[42rem]">
        <SafeMarkdownPreview
          className="artifact-canvas-markdown leading-7"
          content={content}
          streaming={streaming}
        />
      </div>
    );
  }

  return (
    <ArtifactCodeCanvas
      code={content}
      language={language}
      streaming={streaming}
    />
  );
}

function LoadingState() {
  return (
    <div className="flex flex-1 items-center justify-center p-6 text-muted-foreground">
      <Spinner className="size-5" />
    </div>
  );
}

function UnavailablePreview() {
  return (
    <p className="p-6 text-muted-foreground text-sm">
      Preview is not available for this file type.
    </p>
  );
}

function ArtifactAttachmentImageBody({
  loading,
  error,
  imagePreviewUrl = null,
  canPreview,
  artifact,
}: Extract<ArtifactAttachmentPanelBodyProps, { kind: "image" }>) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-muted/20">
      {loading ? <LoadingState /> : null}
      {error ? <p className="p-6 text-destructive text-sm">{error}</p> : null}
      {!(loading || error) && imagePreviewUrl ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
          <img
            alt={artifact.filename}
            className="max-h-full max-w-full object-contain"
            src={imagePreviewUrl}
          />
        </div>
      ) : null}
      {loading || error || imagePreviewUrl || canPreview ? null : (
        <UnavailablePreview />
      )}
    </div>
  );
}

function ArtifactAttachmentVideoBody({
  loading,
  error,
  videoPreviewUrl = null,
  canPreview,
  artifact,
}: Extract<ArtifactAttachmentPanelBodyProps, { kind: "video" }>) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-black">
      {loading ? <LoadingState /> : null}
      {error ? <p className="p-6 text-destructive text-sm">{error}</p> : null}
      {!(loading || error) && videoPreviewUrl ? (
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <video
            aria-label={artifact.filename}
            className="max-h-full max-w-full object-contain"
            controls
            playsInline
            preload="metadata"
            src={videoPreviewUrl}
          />
        </div>
      ) : null}
      {loading || error || videoPreviewUrl || canPreview ? null : (
        <UnavailablePreview />
      )}
    </div>
  );
}

function ArtifactAttachmentHtmlBody({
  loading,
  error,
  content,
  canPreview,
  artifact,
}: Extract<ArtifactAttachmentPanelBodyProps, { kind: "html" }>) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {loading ? <LoadingState /> : null}
      {error ? <p className="p-6 text-destructive text-sm">{error}</p> : null}
      {!(loading || error) && content ? (
        <HtmlPreviewFrame
          filename={artifact.filename}
          html={content}
          title={artifact.filename}
        />
      ) : null}
      {loading || error || content || canPreview ? null : (
        <UnavailablePreview />
      )}
    </div>
  );
}

function ArtifactAttachmentSvgBody({
  loading,
  error,
  content,
  canPreview,
  artifact,
}: Extract<ArtifactAttachmentPanelBodyProps, { kind: "svg" }>) {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-muted/20">
      {loading ? <LoadingState /> : null}
      {error ? <p className="p-6 text-destructive text-sm">{error}</p> : null}
      {!(loading || error) && content ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6">
          <SvgPreview content={content} filename={artifact.filename} />
        </div>
      ) : null}
      {loading || error || content || canPreview ? null : (
        <UnavailablePreview />
      )}
    </div>
  );
}

function ArtifactAttachmentTextBody({
  loading,
  error,
  content,
  format,
  language,
  streaming = false,
  canPreview,
}: Extract<ArtifactAttachmentPanelBodyProps, { kind: "text" }>) {
  return (
    <div
      className={cn(
        "flex min-h-0 flex-1 flex-col",
        format === "markdown" && "overflow-y-auto"
      )}
    >
      {loading ? <LoadingState /> : null}
      {error ? <p className="p-6 text-destructive text-sm">{error}</p> : null}
      {!(loading || error) && content
        ? renderTextContent({
            content,
            format,
            language,
            streaming,
          })
        : null}
      {loading || error || canPreview ? null : <UnavailablePreview />}
    </div>
  );
}

function ArtifactAttachmentRichBody({
  loading,
  error,
  preview,
  downloadUrl,
  onSelectSheet,
}: Extract<ArtifactAttachmentPanelBodyProps, { kind: "rich" }>) {
  if (loading) {
    return <LoadingState />;
  }

  if (error) {
    return <p className="p-6 text-destructive text-sm">{error}</p>;
  }

  if (!preview) {
    return <UnavailablePreview />;
  }

  let viewer: ReactNode;
  switch (preview.type) {
    case "presentation":
      viewer = (
        <PresentationViewer downloadUrl={downloadUrl} preview={preview} />
      );
      break;
    case "spreadsheet":
      viewer = (
        <SpreadsheetViewer
          downloadUrl={downloadUrl}
          onSelectSheet={onSelectSheet}
          preview={preview}
        />
      );
      break;
    case "pdf":
      viewer = <PdfViewer downloadUrl={downloadUrl} preview={preview} />;
      break;
    case "document":
      viewer = <DocumentViewer downloadUrl={downloadUrl} preview={preview} />;
      break;
    default:
      viewer = <UnavailablePreview />;
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      {viewer}
    </div>
  );
}

export function ArtifactAttachmentPanelBody(
  props: ArtifactAttachmentPanelBodyProps
) {
  switch (props.kind) {
    case "rich":
      return <ArtifactAttachmentRichBody {...props} />;
    case "image":
      return <ArtifactAttachmentImageBody {...props} />;
    case "video":
      return <ArtifactAttachmentVideoBody {...props} />;
    case "html":
      return <ArtifactAttachmentHtmlBody {...props} />;
    case "svg":
      return <ArtifactAttachmentSvgBody {...props} />;
    case "text":
      return <ArtifactAttachmentTextBody {...props} />;
    default: {
      const _exhaustive: never = props;
      return _exhaustive;
    }
  }
}

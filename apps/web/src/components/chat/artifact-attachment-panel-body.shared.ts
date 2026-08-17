import { clampAttachmentPanelWidth } from "@/components/chat/attachment-panel-width";
import {
  isDocxFile,
  isHtmlArtifactMimeType,
  isImageArtifactMimeType,
  isLegacyDocFile,
  isMarkdownArtifactMimeType,
  isVideoArtifactMimeType,
} from "@/lib/chat-artifacts";

/** Split-view canvas width — close to Claude/Grok, still leaves the thread readable. */
const CANVAS_PANEL_WIDTH = 720;
/** Videos (often portrait reels) leave chat usable on tablet. */
const VIDEO_ARTIFACT_PANEL_WIDTH = 420;

export function artifactPanelDefaultWidth(
  _filename: string,
  mimeType: string
): number {
  const isVideo = isVideoArtifactMimeType(mimeType);
  const baseWidth = isVideo ? VIDEO_ARTIFACT_PANEL_WIDTH : CANVAS_PANEL_WIDTH;
  return clampAttachmentPanelWidth(baseWidth);
}

export function artifactPanelBodyClassName({
  isHtml,
  isImage,
  isSvg = false,
  isVideo = false,
  isMarkdown,
}: {
  isHtml: boolean;
  isImage: boolean;
  isSvg?: boolean;
  isVideo?: boolean;
  isMarkdown: boolean;
}): string | undefined {
  if (isHtml || isImage || isSvg || isVideo) {
    return "flex flex-col overflow-hidden p-0";
  }

  if (isMarkdown) {
    return "overflow-y-auto px-6 py-6 sm:px-8 sm:py-8";
  }

  return "flex flex-col overflow-hidden";
}

export function artifactPanelSubtitle({
  streaming = false,
}: {
  mimeType?: string;
  sizeBytes?: number;
  streaming?: boolean;
}): string | null {
  if (streaming) {
    return "Writing…";
  }

  return null;
}

export function downloadActionLabel(mimeType: string): string {
  if (isHtmlArtifactMimeType(mimeType)) {
    return "Download as HTML";
  }

  if (isDocxFile("", mimeType) || isLegacyDocFile("", mimeType)) {
    return "Download as Word";
  }

  if (isMarkdownArtifactMimeType(mimeType)) {
    return "Download as Markdown";
  }

  if (isImageArtifactMimeType(mimeType)) {
    return "Download image";
  }

  if (isVideoArtifactMimeType(mimeType)) {
    return "Download video";
  }

  if (mimeType === "application/json") {
    return "Download as JSON";
  }

  return "Download";
}

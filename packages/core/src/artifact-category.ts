import {
  isDocxFile,
  isHtmlArtifactMimeType,
  isImageArtifactMimeType,
  isLegacyDocFile,
  isMarkdownArtifactMimeType,
  isTextArtifactMimeType,
  isVideoArtifactMimeType,
  resolveArtifactMimeType,
} from "./artifact-mime";
import type { ArtifactCategory, ArtifactFile } from "./contract";

export function classifyArtifactCategory(
  artifact: Pick<ArtifactFile, "filename" | "mimeType">
): ArtifactCategory {
  const mimeType = resolveArtifactMimeType(
    artifact.mimeType,
    artifact.filename
  );

  if (isMarkdownArtifactMimeType(mimeType)) {
    return "markdown";
  }
  if (isHtmlArtifactMimeType(mimeType)) {
    return "html";
  }
  if (isImageArtifactMimeType(mimeType)) {
    return "image";
  }
  if (isVideoArtifactMimeType(mimeType)) {
    return "video";
  }
  if (
    isDocxFile(artifact.filename, mimeType) ||
    isLegacyDocFile(artifact.filename, mimeType) ||
    mimeType === "application/pdf"
  ) {
    return "document";
  }
  if (isTextArtifactMimeType(mimeType)) {
    return "text";
  }
  return "other";
}

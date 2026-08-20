import type { ArtifactPreview } from "@atlas/core";
import type { ChatArtifactRef } from "@/lib/chat-artifacts";
import {
  artifactCodeLanguage,
  isDocxFile,
  isHtmlArtifactMimeType,
  isImageArtifactMimeType,
  isJsxArtifactFilename,
  isLegacyDocFile,
  isMarkdownArtifactMimeType,
  isMermaidArtifactFilename,
  isSvgArtifactMimeType,
  isVideoArtifactMimeType,
  resolveArtifactMimeType,
  toArtifactsRelativePath,
} from "@/lib/chat-artifacts";

export function artifactCanvasId(path: string): string {
  return `artifact:${path}`;
}

export interface StructuredCanvasArtifact {
  createdAt?: string;
  filename: string;
  mimeType: string;
  path: string;
  size: number;
}

export function chatRefFromStructuredArtifact(
  artifact: StructuredCanvasArtifact
): ChatArtifactRef {
  const rawPath = artifact.path || artifact.filename;
  return {
    filename: artifact.filename,
    mimeType: artifact.mimeType,
    path: toArtifactsRelativePath(rawPath) ?? rawPath,
    savedAt: artifact.createdAt ?? "",
    sizeBytes: artifact.size,
  };
}

export function mergeTurnCanvasArtifacts(
  toolArtifacts: ChatArtifactRef[],
  structured: StructuredCanvasArtifact[] | undefined
): ChatArtifactRef[] {
  const byPath = new Map<string, ChatArtifactRef>();

  for (const artifact of toolArtifacts) {
    byPath.set(artifact.path, artifact);
  }

  for (const artifact of structured ?? []) {
    const ref = chatRefFromStructuredArtifact(artifact);
    if (!byPath.has(ref.path)) {
      byPath.set(ref.path, ref);
    }
  }

  return [...byPath.values()];
}

export function isSvgArtifactPreview(preview: ArtifactPreview): boolean {
  if (preview.type !== "image") {
    return false;
  }

  return (
    preview.format.toLowerCase() === "svg" ||
    isSvgArtifactMimeType(preview.mimeType) ||
    preview.filename.toLowerCase().endsWith(".svg")
  );
}

export function artifactPreviewCanCopy(
  preview: ArtifactPreview | null | undefined
): boolean {
  if (!preview) {
    return false;
  }

  return (
    preview.type === "code" ||
    preview.type === "text" ||
    preview.type === "markdown" ||
    preview.type === "json" ||
    preview.type === "html" ||
    isSvgArtifactPreview(preview)
  );
}

export function artifactPreviewUsesFetchedSource(
  preview: ArtifactPreview
): boolean {
  return preview.type === "html" || isSvgArtifactPreview(preview);
}

export function artifactSupportsPreviewCodeToggle(
  filename: string,
  mimeType: string
): boolean {
  const resolved = resolveArtifactMimeType(mimeType, filename);
  return (
    isMermaidArtifactFilename(filename) ||
    isJsxArtifactFilename(filename) ||
    isHtmlArtifactMimeType(resolved) ||
    isSvgArtifactMimeType(resolved)
  );
}

export function artifactCanvasSourceLanguage(
  filename: string,
  mimeType: string
): string {
  if (isMermaidArtifactFilename(filename)) {
    return "mermaid";
  }
  if (isJsxArtifactFilename(filename)) {
    return artifactCodeLanguage(filename) ?? "jsx";
  }
  const resolved = resolveArtifactMimeType(mimeType, filename);
  if (isHtmlArtifactMimeType(resolved)) {
    return "html";
  }
  if (isSvgArtifactMimeType(resolved)) {
    return "xml";
  }
  return artifactCodeLanguage(filename) ?? "text";
}

export function artifactCanvasTypeLabel(
  filename: string,
  mimeType: string
): string {
  const resolved = resolveArtifactMimeType(mimeType, filename);

  if (isMermaidArtifactFilename(filename)) {
    return "Mermaid";
  }
  if (isJsxArtifactFilename(filename)) {
    return "JSX";
  }
  if (isHtmlArtifactMimeType(resolved)) {
    return "HTML";
  }
  if (isSvgArtifactMimeType(resolved)) {
    return "SVG";
  }
  if (isMarkdownArtifactMimeType(resolved)) {
    return "Markdown";
  }
  if (isImageArtifactMimeType(resolved)) {
    return "Image";
  }
  if (isVideoArtifactMimeType(resolved)) {
    return "Video";
  }
  if (isDocxFile(filename, resolved) || isLegacyDocFile(filename, resolved)) {
    return "Document";
  }
  if (
    filename.toLowerCase().endsWith(".pdf") ||
    resolved === "application/pdf"
  ) {
    return "PDF";
  }
  if (
    filename.toLowerCase().endsWith(".pptx") ||
    filename.toLowerCase().endsWith(".ppt")
  ) {
    return "Slides";
  }
  if (
    filename.toLowerCase().endsWith(".xlsx") ||
    filename.toLowerCase().endsWith(".xls") ||
    filename.toLowerCase().endsWith(".csv")
  ) {
    return "Spreadsheet";
  }

  return "File";
}

import type { ChatArtifactRef } from "@/lib/chat-artifacts";
import {
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

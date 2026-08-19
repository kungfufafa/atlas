import {
  artifactCodeLanguage,
  isDocxFile,
  isHtmlArtifactMimeType,
  isImageArtifactMimeType,
  isLegacyDocFile,
  isMarkdownArtifactMimeType,
  isMermaidArtifactFilename,
  isSvgArtifactMimeType,
  isTextArtifactMimeType,
  isUnknownArtifactMimeType,
  isVideoArtifactMimeType,
  resolveArtifactMimeType,
} from "@/lib/chat-artifacts";

export type PublicArtifactShareView =
  | { kind: "image"; previewUrl: string }
  | { kind: "video"; previewUrl: string }
  | { kind: "html"; content: string }
  | { kind: "svg"; content: string }
  | {
      format: "markdown" | "mermaid" | "plain";
      kind: "text";
      content: string;
      language: string | null;
    }
  | { kind: "download" };

export function buildPublicArtifactShareContentUrl(
  token: string,
  baseUrl = ""
): string {
  return `${baseUrl}/v1/public/artifact-shares/${encodeURIComponent(token)}`;
}

export function buildPublicArtifactShareDownloadUrl(
  token: string,
  baseUrl = ""
): string {
  return `${buildPublicArtifactShareContentUrl(token, baseUrl)}?download=1`;
}

export function isOfficeDocumentShare(
  filename: string,
  mimeType: string
): boolean {
  return isDocxFile(filename, mimeType) || isLegacyDocFile(filename, mimeType);
}

export function resolvePublicArtifactShareView(input: {
  token: string;
  filename: string;
  mimeType: string;
  content: string | null;
  baseUrl?: string;
}): PublicArtifactShareView {
  const mimeType = resolveArtifactMimeType(input.mimeType, input.filename);
  const previewUrl = buildPublicArtifactShareContentUrl(
    input.token,
    input.baseUrl ?? ""
  );

  if (isImageArtifactMimeType(mimeType)) {
    return { kind: "image", previewUrl };
  }

  if (isVideoArtifactMimeType(mimeType)) {
    return { kind: "video", previewUrl };
  }

  if (isOfficeDocumentShare(input.filename, mimeType)) {
    return { kind: "download" };
  }

  if (!input.content) {
    return { kind: "download" };
  }

  if (isHtmlArtifactMimeType(mimeType)) {
    return { content: input.content, kind: "html" };
  }

  if (isSvgArtifactMimeType(mimeType)) {
    return { content: input.content, kind: "svg" };
  }

  if (
    isMermaidArtifactFilename(input.filename) ||
    isMarkdownArtifactMimeType(mimeType) ||
    isTextArtifactMimeType(mimeType) ||
    isUnknownArtifactMimeType(mimeType)
  ) {
    return {
      content: input.content,
      format: isMermaidArtifactFilename(input.filename)
        ? "mermaid"
        : isMarkdownArtifactMimeType(mimeType)
          ? "markdown"
          : "plain",
      kind: "text",
      language: artifactCodeLanguage(input.filename),
    };
  }

  return { kind: "download" };
}

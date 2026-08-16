import { convertDocxToMarkdown } from "../../docx-text";
import type { ArtifactFileTarget, ArtifactPreviewer } from "../previewer";
import {
  type DocumentHeading,
  type DocumentPreview,
  PREVIEW_VERSION,
  type PreviewContext,
  type PreviewMetadata,
  type PreviewOptions,
} from "../types";

export function extractHeadingsFromMarkdown(
  markdown: string
): DocumentHeading[] {
  const headings: DocumentHeading[] = [];
  const lines = markdown.split("\n");

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const match = line.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      const level = match[1].length;
      const text = match[2].trim();
      const id = `heading-${headings.length + 1}-${text.toLowerCase().replace(/[^\w]+/g, "-")}`;
      headings.push({ id, level, text });
    }
  }

  return headings;
}

export class DocumentPreviewer implements ArtifactPreviewer {
  readonly type = "document" as const;

  supports(artifact: { filename: string; mimeType: string }): boolean {
    const lowerName = artifact.filename.toLowerCase();
    return (
      lowerName.endsWith(".docx") ||
      lowerName.endsWith(".doc") ||
      lowerName.endsWith(".rtf") ||
      lowerName.endsWith(".odt") ||
      artifact.mimeType ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      artifact.mimeType === "application/msword" ||
      artifact.mimeType === "application/rtf"
    );
  }

  async inspect(
    _artifact: ArtifactFileTarget,
    buffer: Buffer,
    _context: PreviewContext
  ): Promise<PreviewMetadata> {
    try {
      const markdown = await convertDocxToMarkdown(buffer);
      const words = markdown.trim().split(/\s+/).filter(Boolean);
      const wordCount = words.length;
      const pageCount = Math.max(1, Math.ceil(wordCount / 350));
      const headings = extractHeadingsFromMarkdown(markdown);

      return {
        metadata: {
          characterCount: markdown.length,
          headingsCount: headings.length,
          pageCount,
          wordCount,
        },
        status: "available",
        summary: `Word Document · ${pageCount} page${pageCount === 1 ? "" : "s"} · ${wordCount} words`,
        type: "document",
      };
    } catch {
      return {
        metadata: { pageCount: 1 },
        status: "available",
        summary: "Word Document",
        type: "document",
      };
    }
  }

  async generate(
    artifact: ArtifactFileTarget,
    buffer: Buffer,
    _options: PreviewOptions,
    context: PreviewContext
  ): Promise<DocumentPreview> {
    const targetPath = artifact.path || artifact.filename;
    const downloadUrl = `/v1/profiles/${encodeURIComponent(context.profileId)}/artifacts/content?path=${encodeURIComponent(targetPath)}`;

    try {
      const markdown = await convertDocxToMarkdown(buffer);
      const words = markdown.trim().split(/\s+/).filter(Boolean);
      const wordCount = words.length;
      const pageCount = Math.max(1, Math.ceil(wordCount / 350));
      const headings = extractHeadingsFromMarkdown(markdown);
      const title =
        headings[0]?.text || artifact.filename.replace(/\.[^.]+$/, "");

      return {
        artifactId: artifact.artifactId,
        downloadUrl,
        filename: artifact.filename,
        generatedAt: new Date().toISOString(),
        headings,
        markdown,
        metadata: {
          characterCount: markdown.length,
          pageCount,
          paragraphCount: markdown
            .split(/\n\s*\n/)
            .filter((p) => p.trim().length > 0).length,
          wordCount,
        },
        mimeType:
          artifact.mimeType ||
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        pageCount,
        previewVersion: PREVIEW_VERSION,
        revision: artifact.revision,
        sizeBytes: artifact.sizeBytes || buffer.length,
        status: "available",
        title,
        type: "document",
        wordCount,
      };
    } catch (err) {
      return {
        artifactId: artifact.artifactId,
        downloadUrl,
        error: err instanceof Error ? err.message : "Failed to parse document",
        filename: artifact.filename,
        generatedAt: new Date().toISOString(),
        mimeType: artifact.mimeType,
        previewVersion: PREVIEW_VERSION,
        sizeBytes: artifact.sizeBytes || buffer.length,
        status: "failed",
        type: "document",
      };
    }
  }
}

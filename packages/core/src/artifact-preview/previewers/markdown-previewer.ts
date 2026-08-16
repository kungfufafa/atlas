import type { ArtifactFileTarget, ArtifactPreviewer } from "../previewer";
import {
  type MarkdownPreview,
  PREVIEW_VERSION,
  type PreviewContext,
  type PreviewMetadata,
  type PreviewOptions,
} from "../types";
import { extractHeadingsFromMarkdown } from "./document-previewer";

export class MarkdownPreviewer implements ArtifactPreviewer {
  readonly type = "markdown" as const;

  supports(artifact: { filename: string; mimeType: string }): boolean {
    const lower = artifact.filename.toLowerCase();
    return (
      lower.endsWith(".md") ||
      lower.endsWith(".mdx") ||
      lower.endsWith(".markdown") ||
      artifact.mimeType === "text/markdown"
    );
  }

  async inspect(
    _artifact: ArtifactFileTarget,
    buffer: Buffer,
    _context: PreviewContext
  ): Promise<PreviewMetadata> {
    const text = buffer.toString("utf8");
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const headings = extractHeadingsFromMarkdown(text);
    const readingTimeMinutes = Math.max(1, Math.ceil(words / 200));

    return {
      metadata: {
        headingsCount: headings.length,
        readingTimeMinutes,
        wordCount: words,
      },
      status: "available",
      summary: `Markdown Document · ${words} words · ${readingTimeMinutes} min read`,
      type: "markdown",
    };
  }

  async generate(
    artifact: ArtifactFileTarget,
    buffer: Buffer,
    _options: PreviewOptions,
    context: PreviewContext
  ): Promise<MarkdownPreview> {
    const targetPath = artifact.path || artifact.filename;
    const downloadUrl = `/v1/profiles/${encodeURIComponent(context.profileId)}/artifacts/content?path=${encodeURIComponent(targetPath)}`;
    const content = buffer.toString("utf8");
    const words = content.trim().split(/\s+/).filter(Boolean).length;
    const headings = extractHeadingsFromMarkdown(content);
    const readingTimeMinutes = Math.max(1, Math.ceil(words / 200));

    return {
      artifactId: artifact.artifactId,
      content,
      downloadUrl,
      filename: artifact.filename,
      generatedAt: new Date().toISOString(),
      headings,
      metadata: {
        headingsCount: headings.length,
        readingTimeMinutes,
        wordCount: words,
      },
      mimeType: artifact.mimeType || "text/markdown",
      previewVersion: PREVIEW_VERSION,
      readingTimeMinutes,
      revision: artifact.revision,
      sizeBytes: artifact.sizeBytes || buffer.length,
      status: "available",
      type: "markdown",
      wordCount: words,
    };
  }
}

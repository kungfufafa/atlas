import type { ArtifactFileTarget, ArtifactPreviewer } from "../previewer";
import {
  PREVIEW_VERSION,
  type PreviewContext,
  type PreviewMetadata,
  type PreviewOptions,
  type TextPreview,
} from "../types";

export class TextPreviewer implements ArtifactPreviewer {
  readonly type = "text" as const;

  supports(artifact: { filename: string; mimeType: string }): boolean {
    const lower = artifact.filename.toLowerCase();
    return (
      lower.endsWith(".txt") ||
      lower.endsWith(".log") ||
      lower.endsWith(".text") ||
      artifact.mimeType === "text/plain" ||
      artifact.mimeType?.startsWith("text/") === true
    );
  }

  async inspect(
    _artifact: ArtifactFileTarget,
    buffer: Buffer,
    _context: PreviewContext
  ): Promise<PreviewMetadata> {
    const text = buffer.toString("utf8");
    const lineCount = text.split("\n").length;

    return {
      metadata: {
        characterCount: text.length,
        lineCount,
      },
      status: "available",
      summary: `Plain Text · ${lineCount} line${lineCount === 1 ? "" : "s"}`,
      type: "text",
    };
  }

  async generate(
    artifact: ArtifactFileTarget,
    buffer: Buffer,
    options: PreviewOptions,
    context: PreviewContext
  ): Promise<TextPreview> {
    const targetPath = artifact.path || artifact.filename;
    const downloadUrl = `/v1/profiles/${encodeURIComponent(context.profileId)}/artifacts/content?path=${encodeURIComponent(targetPath)}`;
    const text = buffer.toString("utf8");
    const lines = text.split("\n");
    const maxLines = options.maxLines ?? 5000;
    const truncated = lines.length > maxLines;
    const content = truncated ? lines.slice(0, maxLines).join("\n") : text;

    return {
      artifactId: artifact.artifactId,
      content,
      downloadUrl,
      filename: artifact.filename,
      generatedAt: new Date().toISOString(),
      lineCount: lines.length,
      metadata: {
        characterCount: text.length,
        lineCount: lines.length,
        truncated,
      },
      mimeType: artifact.mimeType || "text/plain",
      previewVersion: PREVIEW_VERSION,
      revision: artifact.revision,
      sizeBytes: artifact.sizeBytes || buffer.length,
      status: "available",
      truncated,
      type: "text",
    };
  }
}

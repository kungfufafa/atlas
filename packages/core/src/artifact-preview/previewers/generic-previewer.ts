import type { ArtifactFileTarget, ArtifactPreviewer } from "../previewer";
import {
  type GenericPreview,
  PREVIEW_VERSION,
  type PreviewContext,
  type PreviewMetadata,
  type PreviewOptions,
} from "../types";

export class GenericPreviewer implements ArtifactPreviewer {
  readonly type = "generic" as const;

  supports(_artifact: { filename: string; mimeType: string }): boolean {
    return true; // Fallback matches all
  }

  async inspect(
    artifact: ArtifactFileTarget,
    _buffer: Buffer,
    _context: PreviewContext
  ): Promise<PreviewMetadata> {
    const ext = artifact.filename.split(".").pop()?.toUpperCase() || "FILE";
    return {
      metadata: {
        extension: ext,
      },
      status: "unsupported",
      summary: `${ext} File`,
      type: "generic",
    };
  }

  async generate(
    artifact: ArtifactFileTarget,
    buffer: Buffer,
    _options: PreviewOptions,
    context: PreviewContext
  ): Promise<GenericPreview> {
    const targetPath = artifact.path || artifact.filename;
    const downloadUrl = `/v1/profiles/${encodeURIComponent(context.profileId)}/artifacts/content?path=${encodeURIComponent(targetPath)}`;

    return {
      artifactId: artifact.artifactId,
      downloadUrl,
      filename: artifact.filename,
      generatedAt: new Date().toISOString(),
      metadata: {},
      mimeType: artifact.mimeType || "application/octet-stream",
      previewVersion: PREVIEW_VERSION,
      revision: artifact.revision,
      sizeBytes: artifact.sizeBytes || buffer.length,
      status: "unsupported",
      type: "generic",
    };
  }
}

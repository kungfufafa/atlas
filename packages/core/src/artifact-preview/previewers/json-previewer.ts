import type { ArtifactFileTarget, ArtifactPreviewer } from "../previewer";
import {
  type JsonPreview,
  PREVIEW_VERSION,
  type PreviewContext,
  type PreviewMetadata,
  type PreviewOptions,
} from "../types";

export class JsonPreviewer implements ArtifactPreviewer {
  readonly type = "json" as const;

  supports(artifact: { filename: string; mimeType: string }): boolean {
    const lower = artifact.filename.toLowerCase();
    return lower.endsWith(".json") || artifact.mimeType === "application/json";
  }

  async inspect(
    _artifact: ArtifactFileTarget,
    buffer: Buffer,
    _context: PreviewContext
  ): Promise<PreviewMetadata> {
    try {
      const text = buffer.toString("utf8");
      const parsed = JSON.parse(text);
      const isArray = Array.isArray(parsed);
      const itemCount = isArray ? parsed.length : Object.keys(parsed).length;
      const topKeys = isArray ? undefined : Object.keys(parsed).slice(0, 10);

      return {
        metadata: {
          isArray,
          itemCount,
          topKeys,
        },
        status: "available",
        summary: isArray
          ? `JSON Array · ${itemCount} item${itemCount === 1 ? "" : "s"}`
          : `JSON Object · ${itemCount} key${itemCount === 1 ? "" : "s"}`,
        type: "json",
      };
    } catch {
      return {
        metadata: { isArray: false },
        status: "available",
        summary: "JSON Document",
        type: "json",
      };
    }
  }

  async generate(
    artifact: ArtifactFileTarget,
    buffer: Buffer,
    _options: PreviewOptions,
    context: PreviewContext
  ): Promise<JsonPreview> {
    const targetPath = artifact.path || artifact.filename;
    const downloadUrl = `/v1/profiles/${encodeURIComponent(context.profileId)}/artifacts/content?path=${encodeURIComponent(targetPath)}`;

    try {
      const text = buffer.toString("utf8");
      const parsed = JSON.parse(text);
      const formatted = JSON.stringify(parsed, null, 2);
      const isArray = Array.isArray(parsed);
      const itemCount = isArray ? parsed.length : Object.keys(parsed).length;
      const topKeys = isArray ? undefined : Object.keys(parsed).slice(0, 20);
      const lineCount = formatted.split("\n").length;

      return {
        artifactId: artifact.artifactId,
        data: parsed,
        downloadUrl,
        filename: artifact.filename,
        formatted,
        generatedAt: new Date().toISOString(),
        isArray,
        itemCount,
        lineCount,
        metadata: {
          isArray,
          itemCount,
          topKeys,
        },
        mimeType: artifact.mimeType || "application/json",
        previewVersion: PREVIEW_VERSION,
        revision: artifact.revision,
        sizeBytes: artifact.sizeBytes || buffer.length,
        status: "available",
        topKeys,
        type: "json",
      };
    } catch {
      const text = buffer.toString("utf8");
      return {
        artifactId: artifact.artifactId,
        downloadUrl,
        filename: artifact.filename,
        formatted: text,
        generatedAt: new Date().toISOString(),
        isArray: false,
        lineCount: text.split("\n").length,
        mimeType: artifact.mimeType || "application/json",
        previewVersion: PREVIEW_VERSION,
        revision: artifact.revision,
        sizeBytes: artifact.sizeBytes || buffer.length,
        status: "available",
        type: "json",
      };
    }
  }
}

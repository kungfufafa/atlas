import type { ArtifactFileTarget, ArtifactPreviewer } from "../previewer";
import {
  type PdfPreview,
  PREVIEW_VERSION,
  type PreviewContext,
  type PreviewMetadata,
  type PreviewOptions,
} from "../types";

export function extractPdfPageCount(buffer: Buffer): number {
  try {
    const text = buffer.toString("latin1");

    // Check for standard /Count in Pages tree
    const countMatches = [
      ...text.matchAll(/\/Type\s*\/Pages[\s\S]*?\/Count\s+(\d+)/g),
    ];
    if (countMatches.length > 0) {
      const maxCount = Math.max(
        ...countMatches.map((m) => Number.parseInt(m[1], 10) || 0)
      );
      if (maxCount > 0) {
        return maxCount;
      }
    }

    // Fallback: count /Type /Page objects (excluding /Pages)
    const pageMatches = text.match(/\/Type\s*\/Page\b(?!\s*s)/g);
    if (pageMatches && pageMatches.length > 0) {
      return pageMatches.length;
    }

    return 1;
  } catch {
    return 1;
  }
}

export function extractPdfTitle(buffer: Buffer): string | undefined {
  try {
    const text = buffer.toString("latin1");
    const titleMatch = text.match(/\/Title\s*\(([^)]+)\)/);
    if (titleMatch?.[1]) {
      return titleMatch[1].trim();
    }
  } catch {
    // Ignore extraction errors
  }
}

export class PdfPreviewer implements ArtifactPreviewer {
  readonly type = "pdf" as const;

  supports(
    artifact: { filename: string; mimeType: string },
    buffer?: Buffer
  ): boolean {
    const lowerName = artifact.filename.toLowerCase();
    if (lowerName.endsWith(".pdf") || artifact.mimeType === "application/pdf") {
      return true;
    }
    if (buffer && buffer.length >= 4) {
      const header = buffer.subarray(0, 5).toString("ascii");
      if (header.startsWith("%PDF-")) {
        return true;
      }
    }
    return false;
  }

  async inspect(
    _artifact: ArtifactFileTarget,
    buffer: Buffer,
    _context: PreviewContext
  ): Promise<PreviewMetadata> {
    const pageCount = extractPdfPageCount(buffer);
    const title = extractPdfTitle(buffer);

    return {
      metadata: {
        pageCount,
        title,
      },
      status: "available",
      summary: `${pageCount} page${pageCount === 1 ? "" : "s"}`,
      type: "pdf",
    };
  }

  async generate(
    artifact: ArtifactFileTarget,
    buffer: Buffer,
    _options: PreviewOptions,
    context: PreviewContext
  ): Promise<PdfPreview> {
    const pageCount = extractPdfPageCount(buffer);
    const title = extractPdfTitle(buffer);
    const targetPath = artifact.path || artifact.filename;
    const previewUrl = `/v1/profiles/${encodeURIComponent(context.profileId)}/artifacts/content?path=${encodeURIComponent(targetPath)}&inline=1`;
    const downloadUrl = `/v1/profiles/${encodeURIComponent(context.profileId)}/artifacts/content?path=${encodeURIComponent(targetPath)}`;

    return {
      artifactId: artifact.artifactId,
      downloadUrl,
      filename: artifact.filename,
      generatedAt: new Date().toISOString(),
      metadata: {
        title,
      },
      mimeType: artifact.mimeType || "application/pdf",
      pageCount,
      previewUrl,
      previewVersion: PREVIEW_VERSION,
      revision: artifact.revision,
      sizeBytes: artifact.sizeBytes || buffer.length,
      status: "available",
      type: "pdf",
    };
  }
}

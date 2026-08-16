import type { ArtifactFileTarget, ArtifactPreviewer } from "../previewer";
import {
  type ImagePreview,
  PREVIEW_VERSION,
  type PreviewContext,
  type PreviewMetadata,
  type PreviewOptions,
} from "../types";

export function extractImageDimensions(
  buffer: Buffer,
  format: string
): { height?: number; width?: number } {
  try {
    if (format === "png" && buffer.length >= 24) {
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      return { height, width };
    }

    if (format === "gif" && buffer.length >= 10) {
      const width = buffer.readUInt16LE(6);
      const height = buffer.readUInt16LE(8);
      return { height, width };
    }

    if ((format === "jpg" || format === "jpeg") && buffer.length >= 2) {
      let offset = 2;
      while (offset < buffer.length - 8) {
        if (buffer[offset] !== 0xff) {
          break;
        }
        const marker = buffer[offset + 1];
        if (marker === 0xc0 || marker === 0xc2) {
          const height = buffer.readUInt16BE(offset + 5);
          const width = buffer.readUInt16BE(offset + 7);
          return { height, width };
        }
        const length = buffer.readUInt16BE(offset + 2);
        offset += 2 + length;
      }
    }

    if (format === "svg") {
      const text = buffer.toString("utf8", 0, Math.min(buffer.length, 2000));
      const viewBoxMatch = text.match(
        /viewBox=["']\s*[\d.]+\s+[\d.]+\s+([\d.]+)\s+([\d.]+)\s*["']/i
      );
      if (viewBoxMatch) {
        return {
          height: Math.round(Number.parseFloat(viewBoxMatch[2])),
          width: Math.round(Number.parseFloat(viewBoxMatch[1])),
        };
      }
      const wMatch = text.match(/width=["']([\d.]+)p?x?["']/i);
      const hMatch = text.match(/height=["']([\d.]+)p?x?["']/i);
      if (wMatch && hMatch) {
        return {
          height: Math.round(Number.parseFloat(hMatch[1])),
          width: Math.round(Number.parseFloat(wMatch[1])),
        };
      }
    }
  } catch {
    // Dimension extraction failure is non-fatal
  }

  return {};
}

export function sanitizeSvg(svgContent: string): string {
  return svgContent
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(
      /<foreignObject\b[^<]*(?:(?!<\/foreignObject>)<[^<]*)*<\/foreignObject>/gi,
      ""
    )
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "")
    .replace(/<embed\b[^>]*>/gi, "")
    .replace(/<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi, "")
    .replace(/<base\b[^>]*>/gi, "")
    .replace(/<meta\b[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(
      /href\s*=\s*["']\s*(?:javascript:|data:text\/html)[^"']*["']/gi,
      'href="#"'
    )
    .replace(
      /xlink:href\s*=\s*["']\s*(?:javascript:|data:text\/html)[^"']*["']/gi,
      'xlink:href="#"'
    );
}

export class ImagePreviewer implements ArtifactPreviewer {
  readonly type = "image" as const;

  supports(artifact: { filename: string; mimeType: string }): boolean {
    const lower = artifact.filename.toLowerCase();
    return (
      lower.endsWith(".png") ||
      lower.endsWith(".jpg") ||
      lower.endsWith(".jpeg") ||
      lower.endsWith(".webp") ||
      lower.endsWith(".gif") ||
      lower.endsWith(".svg") ||
      artifact.mimeType?.startsWith("image/") === true
    );
  }

  async inspect(
    artifact: ArtifactFileTarget,
    buffer: Buffer,
    _context: PreviewContext
  ): Promise<PreviewMetadata> {
    const ext = artifact.filename.split(".").pop()?.toLowerCase() || "png";
    const { width, height } = extractImageDimensions(buffer, ext);
    const dimensions = width && height ? `${width} × ${height}` : undefined;

    return {
      metadata: {
        dimensions,
        format: ext.toUpperCase(),
        height,
        width,
      },
      status: "available",
      summary: dimensions
        ? `${ext.toUpperCase()} Image · ${dimensions}`
        : `${ext.toUpperCase()} Image`,
      type: "image",
    };
  }

  async generate(
    artifact: ArtifactFileTarget,
    buffer: Buffer,
    _options: PreviewOptions,
    context: PreviewContext
  ): Promise<ImagePreview> {
    const targetPath = artifact.path || artifact.filename;
    const url = `/v1/profiles/${encodeURIComponent(context.profileId)}/artifacts/content?path=${encodeURIComponent(targetPath)}&inline=1`;
    const downloadUrl = `/v1/profiles/${encodeURIComponent(context.profileId)}/artifacts/content?path=${encodeURIComponent(targetPath)}`;
    const ext = artifact.filename.split(".").pop()?.toLowerCase() || "png";
    const { width, height } = extractImageDimensions(buffer, ext);
    const dimensions = width && height ? `${width} × ${height}` : undefined;

    return {
      artifactId: artifact.artifactId,
      dimensions,
      downloadUrl,
      filename: artifact.filename,
      format: ext.toUpperCase(),
      generatedAt: new Date().toISOString(),
      height,
      metadata: {
        dimensions,
        format: ext.toUpperCase(),
      },
      mimeType: artifact.mimeType || `image/${ext === "jpg" ? "jpeg" : ext}`,
      previewVersion: PREVIEW_VERSION,
      revision: artifact.revision,
      sizeBytes: artifact.sizeBytes || buffer.length,
      status: "available",
      type: "image",
      url,
      width,
    };
  }
}

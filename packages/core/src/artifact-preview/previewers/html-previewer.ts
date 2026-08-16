import type { ArtifactFileTarget, ArtifactPreviewer } from "../previewer";
import {
  type HtmlPreview,
  PREVIEW_VERSION,
  type PreviewContext,
  type PreviewMetadata,
  type PreviewOptions,
} from "../types";

export function sanitizeAndSandboxedHtml(rawHtml: string): string {
  // Strip script tags, base tags, on* handlers, javascript hrefs
  let cleaned = rawHtml
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<base\b[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(
      /href\s*=\s*["']\s*(?:javascript:|data:text\/html)[^"']*["']/gi,
      'href="#"'
    );

  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: https: http: blob:; font-src data: https:; media-src data: https:;">`;

  if (cleaned.includes("<head>")) {
    cleaned = cleaned.replace("<head>", `<head>\n  ${cspMeta}`);
  } else if (cleaned.includes("<html>")) {
    cleaned = cleaned.replace(
      "<html>",
      `<html>\n<head>\n  ${cspMeta}\n</head>`
    );
  } else {
    cleaned = `<head>\n  ${cspMeta}\n</head>\n${cleaned}`;
  }

  return cleaned;
}

export class HtmlPreviewer implements ArtifactPreviewer {
  readonly type = "html" as const;

  supports(artifact: { filename: string; mimeType: string }): boolean {
    const lower = artifact.filename.toLowerCase();
    return (
      lower.endsWith(".html") ||
      lower.endsWith(".htm") ||
      artifact.mimeType === "text/html"
    );
  }

  async inspect(
    _artifact: ArtifactFileTarget,
    buffer: Buffer,
    _context: PreviewContext
  ): Promise<PreviewMetadata> {
    const text = buffer.toString("utf8");
    const titleMatch = text.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch?.[1]?.trim();

    return {
      metadata: {
        title,
      },
      status: "available",
      summary: title ? `HTML Document · ${title}` : "HTML Document",
      type: "html",
    };
  }

  async generate(
    artifact: ArtifactFileTarget,
    buffer: Buffer,
    _options: PreviewOptions,
    context: PreviewContext
  ): Promise<HtmlPreview> {
    const targetPath = artifact.path || artifact.filename;
    const downloadUrl = `/v1/profiles/${encodeURIComponent(context.profileId)}/artifacts/content?path=${encodeURIComponent(targetPath)}`;
    const rawHtml = buffer.toString("utf8");
    const safeHtml = sanitizeAndSandboxedHtml(rawHtml);
    const titleMatch = rawHtml.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch?.[1]?.trim() || artifact.filename;

    return {
      artifactId: artifact.artifactId,
      downloadUrl,
      filename: artifact.filename,
      generatedAt: new Date().toISOString(),
      metadata: {
        title,
      },
      mimeType: artifact.mimeType || "text/html",
      previewVersion: PREVIEW_VERSION,
      revision: artifact.revision,
      safeHtml,
      sandbox: "", // Strict sandbox: no scripts, no same-origin, no top-nav
      sizeBytes: artifact.sizeBytes || buffer.length,
      status: "available",
      title,
      type: "html",
    };
  }
}

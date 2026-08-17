import { sanitizeSvg } from "@atlas/core/sanitize-svg";
import { MAX_SVG_PREVIEW_CHARS } from "@/lib/artifact-preview-limits";

export type SvgPreviewResult =
  | { dataUrl: string; sanitized: string; status: "ok" }
  | { sizeChars: number; status: "too_large" }
  | { status: "invalid" };

export function prepareSvgPreview(raw: string): SvgPreviewResult {
  if (raw.length > MAX_SVG_PREVIEW_CHARS) {
    return { sizeChars: raw.length, status: "too_large" };
  }

  const trimmed = raw.trim();
  if (!/<svg[\s>]/i.test(trimmed)) {
    return { status: "invalid" };
  }

  const sanitized = sanitizeSvg(trimmed);
  if (!/<svg[\s>]/i.test(sanitized)) {
    return { status: "invalid" };
  }

  return {
    dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sanitized)}`,
    sanitized,
    status: "ok",
  };
}

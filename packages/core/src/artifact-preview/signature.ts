import {
  inferArtifactMimeType,
  isHtmlArtifactMimeType,
  normalizeMimeType,
} from "../artifact-mime";

export type InferredFormat =
  | "pdf"
  | "png"
  | "jpeg"
  | "gif"
  | "webp"
  | "svg"
  | "zip" // OOXML (.xlsx, .pptx, .docx) or raw zip
  | "executable"
  | "json"
  | "xml"
  | "text"
  | "binary";

export function detectFileSignature(buffer: Buffer): InferredFormat {
  if (!buffer || buffer.length === 0) {
    return "text";
  }

  // Executables
  if (buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a) {
    return "executable"; // Windows PE / MZ
  }
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x7f &&
    buffer[1] === 0x45 &&
    buffer[2] === 0x4c &&
    buffer[3] === 0x46
  ) {
    return "executable"; // ELF
  }
  if (
    buffer.length >= 4 &&
    ((buffer[0] === 0xfe &&
      buffer[1] === 0xed &&
      buffer[2] === 0xfa &&
      buffer[3] === 0xce) ||
      (buffer[0] === 0xfe &&
        buffer[1] === 0xed &&
        buffer[2] === 0xfa &&
        buffer[3] === 0xcf) ||
      (buffer[0] === 0xce &&
        buffer[1] === 0xfa &&
        buffer[2] === 0xed &&
        buffer[3] === 0xfe) ||
      (buffer[0] === 0xcf &&
        buffer[1] === 0xfa &&
        buffer[2] === 0xed &&
        buffer[3] === 0xfe) ||
      (buffer[0] === 0xca &&
        buffer[1] === 0xfe &&
        buffer[2] === 0xba &&
        buffer[3] === 0xbe))
  ) {
    return "executable"; // Mach-O
  }

  // PDF: %PDF-
  if (
    buffer.length >= 5 &&
    buffer[0] === 0x25 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x44 &&
    buffer[3] === 0x46 &&
    buffer[4] === 0x2d
  ) {
    return "pdf";
  }

  // PNG: \x89PNG\r\n\x1a\n
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "png";
  }

  // JPEG: 0xFF, 0xD8, 0xFF
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return "jpeg";
  }

  // GIF: GIF87a / GIF89a
  if (
    buffer.length >= 6 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) &&
    buffer[5] === 0x61
  ) {
    return "gif";
  }

  // WebP: RIFF....WEBP
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "webp";
  }

  // ZIP / OOXML: PK\x03\x04 or PK\x05\x06 or PK\x07\x08
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07) &&
    (buffer[3] === 0x04 || buffer[3] === 0x06 || buffer[3] === 0x08)
  ) {
    return "zip";
  }

  // Text / SVG / JSON / XML sniffing
  const sampleLen = Math.min(buffer.length, 1024);
  const sample = buffer.subarray(0, sampleLen).toString("utf8");
  const trimmed = sample.trim();

  if (trimmed.startsWith("<svg") || /<svg\b[^>]*>/i.test(sample)) {
    return "svg";
  }

  if (trimmed.startsWith("<?xml") && /<svg\b[^>]*>/i.test(sample)) {
    return "svg";
  }

  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      JSON.parse(buffer.toString("utf8"));
      return "json";
    } catch {
      // not valid json, fall through
    }
  }

  // Check for binary null bytes
  let nullBytes = 0;
  for (let i = 0; i < sampleLen; i++) {
    if (buffer[i] === 0) {
      nullBytes++;
    }
  }

  if (nullBytes > 0 && nullBytes / sampleLen > 0.05) {
    return "binary";
  }

  return "text";
}

export function isSignatureCompatible(
  declaredExt: string,
  declaredMime: string,
  buffer?: Buffer
): boolean {
  if (!buffer || buffer.length === 0) {
    return true;
  }

  const sig = detectFileSignature(buffer);
  const ext = declaredExt.toLowerCase().replace(/^\./, "");
  const mime = declaredMime.toLowerCase();

  // If executable, always reject specific previewers (force generic/unsupported)
  if (sig === "executable") {
    return false;
  }

  if (ext === "pdf" || mime === "application/pdf") {
    return sig === "pdf";
  }

  if (ext === "png" || mime === "image/png") {
    return sig === "png";
  }

  if (
    ext === "jpg" ||
    ext === "jpeg" ||
    mime === "image/jpeg" ||
    mime === "image/jpg"
  ) {
    return sig === "jpeg";
  }

  if (ext === "gif" || mime === "image/gif") {
    return sig === "gif";
  }

  if (ext === "webp" || mime === "image/webp") {
    return sig === "webp";
  }

  if (ext === "svg" || mime === "image/svg+xml") {
    return sig === "svg" || sig === "text";
  }

  if (
    ext === "xlsx" ||
    ext === "pptx" ||
    ext === "docx" ||
    mime.includes("officedocument")
  ) {
    // OOXML files must be valid ZIP archives or text fallback
    return sig === "zip" || sig === "text";
  }

  return true;
}

/**
 * Content-Type to serve for artifact bytes. Declared metadata/filename wins
 * unless the file signature contradicts a dangerous or binary type.
 * Never upgrades generic text to an executable browser type.
 */
export function resolveServedArtifactContentType(
  filename: string,
  declaredMime: string,
  buffer: Buffer
): string {
  const inferred = inferArtifactMimeType(filename);
  const declared = normalizeMimeType(declaredMime) || inferred;
  const sig = detectFileSignature(buffer);

  if (sig === "executable") {
    return "application/octet-stream";
  }

  if (declared === "application/pdf") {
    return sig === "pdf" ? declared : "application/octet-stream";
  }

  if (declared === "image/svg+xml" || filename.toLowerCase().endsWith(".svg")) {
    return sig === "svg" || sig === "text"
      ? "image/svg+xml"
      : "application/octet-stream";
  }

  if (isHtmlArtifactMimeType(declared)) {
    return sig === "text" || sig === "svg" || sig === "xml"
      ? declared
      : "application/octet-stream";
  }

  if (declared.startsWith("image/")) {
    if (declared === "image/png" && sig === "png") {
      return declared;
    }
    if (
      (declared === "image/jpeg" || declared === "image/jpg") &&
      sig === "jpeg"
    ) {
      return "image/jpeg";
    }
    if (declared === "image/gif" && sig === "gif") {
      return declared;
    }
    if (declared === "image/webp" && sig === "webp") {
      return declared;
    }
    if (sig === "png") {
      return "image/png";
    }
    if (sig === "jpeg") {
      return "image/jpeg";
    }
    if (sig === "gif") {
      return "image/gif";
    }
    if (sig === "webp") {
      return "image/webp";
    }
    return "application/octet-stream";
  }

  return declared;
}

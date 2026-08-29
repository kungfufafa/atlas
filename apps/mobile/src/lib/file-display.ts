import { resolveArtifactMimeType } from "@atlas/core/artifact-mime";
import { inferArtifactType } from "@atlas/core/artifact-types";

const KIND_BY_EXTENSION: Record<string, string> = {
  csv: "CSV",
  doc: "Document",
  docx: "Document",
  gif: "Image",
  htm: "HTML",
  html: "HTML",
  jpeg: "Image",
  jpg: "Image",
  js: "Code",
  json: "JSON",
  jsx: "Code",
  markdown: "Markdown",
  md: "Markdown",
  mermaid: "Diagram",
  mmd: "Diagram",
  pdf: "PDF",
  png: "Image",
  ppt: "Presentation",
  pptx: "Presentation",
  svg: "SVG",
  ts: "Code",
  tsv: "CSV",
  tsx: "Code",
  txt: "Text",
  webp: "Image",
  xls: "Spreadsheet",
  xlsx: "Spreadsheet",
};

const TEXT_EXTENSIONS = new Set([
  "cjs",
  "css",
  "csv",
  "env",
  "htm",
  "html",
  "js",
  "json",
  "jsx",
  "log",
  "markdown",
  "md",
  "mermaid",
  "mjs",
  "mmd",
  "py",
  "sh",
  "svg",
  "toml",
  "ts",
  "tsv",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
]);

const IMAGE_EXTENSIONS = new Set(["gif", "jpeg", "jpg", "png", "webp"]);
const EDITABLE_EXTENSIONS = new Set(["csv", "markdown", "md", "tsv"]);

export function fileExtension(filename: string): string {
  const basename = fileBasename(filename);
  const dot = basename.lastIndexOf(".");
  if (dot <= 0 || dot === basename.length - 1) {
    return "";
  }
  return basename.slice(dot + 1).toLowerCase();
}

export function fileBasename(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.at(-1) || path;
}

export function fileFolder(path: string): string | null {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length < 2) {
    return null;
  }
  return parts.slice(0, -1).join("/");
}

export function displayFileKind(filename: string, mimeType?: string): string {
  const extension = fileExtension(filename);
  const labeled = KIND_BY_EXTENSION[extension];
  if (labeled) {
    return labeled;
  }

  switch (inferArtifactType(filename, mimeType)) {
    case "image":
      return "Image";
    case "pdf":
      return "PDF";
    case "presentation":
      return "Presentation";
    case "spreadsheet":
      return "Spreadsheet";
    case "document":
      return "Document";
    default:
      return "File";
  }
}

export function isImagePreviewable(
  filename: string,
  mimeType?: string
): boolean {
  if (IMAGE_EXTENSIONS.has(fileExtension(filename))) {
    return true;
  }
  const mime = mimeType ? resolveArtifactMimeType(mimeType, filename) : "";
  return mime.startsWith("image/") && mime !== "image/svg+xml";
}

export function isTextPreviewable(
  filename: string,
  mimeType?: string
): boolean {
  if (TEXT_EXTENSIONS.has(fileExtension(filename))) {
    return true;
  }
  const mime = mimeType ? resolveArtifactMimeType(mimeType, filename) : "";
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/javascript" ||
    mime === "application/xml" ||
    mime === "image/svg+xml"
  );
}

export function isEditableFile(filename: string): boolean {
  return EDITABLE_EXTENSIONS.has(fileExtension(filename));
}

export function isMarkdownFile(filename: string): boolean {
  const extension = fileExtension(filename);
  return extension === "md" || extension === "markdown";
}

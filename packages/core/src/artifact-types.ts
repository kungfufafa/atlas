export type ArtifactType =
  | "document"
  | "spreadsheet"
  | "presentation"
  | "pdf"
  | "image"
  | "file";

export type ArtifactCompiler = "html" | "jsx";

export interface ArtifactFormatDetails {
  compiler?: ArtifactCompiler;
  language?: string;
  pageCount?: number;
  sheetCount?: number;
  slideCount?: number;
  thumbnailUrl?: string;
}

export interface Artifact {
  branchId?: string;
  createdAt: string;
  filename: string;
  formatDetails?: ArtifactFormatDetails;
  id: string;
  metadata?: Record<string, unknown>;
  mimeType: string;
  parentArtifactId?: string;
  path: string;
  projectId?: string;
  revision?: number;
  rootArtifactId?: string;
  sessionId?: string;
  size: number;
  type: ArtifactType;
  updatedAt?: string;
}

export interface ArtifactCandidate {
  artifact: Artifact;
  confidenceScore: number;
  hardFilterPassed: boolean;
  matchReasons: string[];
  relevanceExplanation?: string;
}

export interface DisambiguationOption {
  artifact: Artifact;
  description: string;
  id: string;
  label: string;
}

export interface DisambiguationResult {
  clarificationMessage?: string;
  disambiguationRequired: boolean;
  options?: DisambiguationOption[];
  resolvedArtifact?: Artifact;
  topConfidence: number;
}

export function inferArtifactType(
  filename: string,
  mimeType?: string
): ArtifactType {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf("."));

  if (
    ext === ".pptx" ||
    ext === ".ppt" ||
    mimeType ===
      "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  ) {
    return "presentation";
  }

  if (
    ext === ".xlsx" ||
    ext === ".csv" ||
    ext === ".xls" ||
    mimeType ===
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
    mimeType === "text/csv"
  ) {
    return "spreadsheet";
  }

  if (ext === ".pdf" || mimeType === "application/pdf") {
    return "pdf";
  }

  if (
    ext === ".docx" ||
    ext === ".doc" ||
    ext === ".md" ||
    ext === ".txt" ||
    mimeType === "text/plain" ||
    mimeType === "text/markdown" ||
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    return "document";
  }

  if (
    ext === ".png" ||
    ext === ".jpg" ||
    ext === ".jpeg" ||
    ext === ".svg" ||
    ext === ".webp" ||
    ext === ".gif" ||
    mimeType?.startsWith("image/")
  ) {
    return "image";
  }

  return "file";
}

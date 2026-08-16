export type PreviewType =
  | "pdf"
  | "spreadsheet"
  | "presentation"
  | "document"
  | "image"
  | "markdown"
  | "code"
  | "json"
  | "text"
  | "html"
  | "generic";

export type PreviewStatus =
  | "available"
  | "generating"
  | "failed"
  | "unsupported";

export type PreviewStrategy = "native" | "semantic" | "converted" | "generic";

export interface PreviewContext {
  orgId: string;
  profileId: string;
  userId?: string;
  userRole?: string;
}

export interface PreviewOptions {
  forceRegenerate?: boolean;
  maxBytes?: number;
  maxLines?: number;
  range?: string; // e.g. "A1:Z100"
  revision?: number;
  sheet?: string;
  sheetIndex?: number;
  strategy?: PreviewStrategy;
}

export interface PreviewMetadata {
  metadata: Record<string, unknown>;
  status: PreviewStatus;
  summary: string;
  type: PreviewType;
}

export interface BaseArtifactPreview {
  artifactId?: string;
  cached?: boolean;
  downloadUrl?: string;
  error?: string;
  filename: string;
  generatedAt: string;
  mimeType: string;
  previewVersion: number;
  revision?: number;
  sizeBytes: number;
  status: PreviewStatus;
  strategy?: PreviewStrategy;
  type: PreviewType;
}

export interface PdfPreview extends BaseArtifactPreview {
  metadata?: {
    author?: string;
    converterVersion?: string;
    creationDate?: string;
    durationMs?: number;
    originalFormat?: string;
    pageCount?: number;
    title?: string;
    [key: string]: unknown;
  };
  outline?: Array<{ pageNumber: number; title: string }>;
  pageCount: number;
  previewUrl?: string;
  thumbnailUrl?: string;
  type: "pdf";
}

export interface SpreadsheetCellFormat {
  align?: "left" | "center" | "right";
  bg?: string;
  bold?: boolean;
  color?: string;
  formatCode?: string;
  type?: "number" | "date" | "currency" | "percentage" | "text";
}

export interface SpreadsheetSheetData {
  cellFormats?: Record<string, SpreadsheetCellFormat>;
  columnCount: number;
  data: (string | number | boolean | null)[][];
  headers?: string[];
  mergedCells?: Array<{
    e: { c: number; r: number };
    s: { c: number; r: number };
  }>;
  name: string;
  rowCount: number;
}

export interface SpreadsheetPreview extends BaseArtifactPreview {
  activeSheet: SpreadsheetSheetData;
  activeSheetIndex: number;
  metadata?: {
    isCsv?: boolean;
    totalColumns?: number;
    totalRows?: number;
  };
  sheetNames: string[];
  sheetsSummary?: Array<{
    columnCount: number;
    name: string;
    rowCount: number;
  }>;
  totalSheets: number;
  type: "spreadsheet";
}

export interface PresentationSlidePreview {
  backgroundColor?: string;
  bulletPoints?: string[];
  layout?: "title" | "content" | "two_column" | "quote" | "blank";
  notes?: string;
  slideIndex: number;
  subtitle?: string;
  table?: {
    headers: string[];
    rows: string[][];
  };
  textBlocks?: string[];
  thumbnailSvg?: string;
  title?: string;
}

export interface PresentationPreview extends BaseArtifactPreview {
  aspectRatio?: "16:9" | "4:3";
  metadata?: {
    author?: string;
    company?: string;
    slideCount?: number;
  };
  slideCount: number;
  slides: PresentationSlidePreview[];
  themeColor?: string;
  title?: string;
  type: "presentation";
}

export interface DocumentHeading {
  id: string;
  level: number;
  text: string;
}

export interface DocumentPreview extends BaseArtifactPreview {
  headings?: DocumentHeading[];
  html?: string;
  markdown?: string;
  metadata?: {
    characterCount?: number;
    pageCount?: number;
    paragraphCount?: number;
    wordCount?: number;
  };
  pageCount?: number;
  title?: string;
  type: "document";
  wordCount?: number;
}

export interface ImagePreview extends BaseArtifactPreview {
  dimensions?: string;
  format: string;
  height?: number;
  metadata?: Record<string, unknown>;
  type: "image";
  url: string;
  width?: number;
}

export interface MarkdownPreview extends BaseArtifactPreview {
  content: string;
  headings?: DocumentHeading[];
  metadata?: Record<string, unknown>;
  readingTimeMinutes?: number;
  type: "markdown";
  wordCount: number;
}

export interface CodePreview extends BaseArtifactPreview {
  content: string;
  language: string;
  lineCount: number;
  metadata?: Record<string, unknown>;
  type: "code";
}

export interface JsonPreview extends BaseArtifactPreview {
  data?: unknown;
  formatted: string;
  isArray: boolean;
  itemCount?: number;
  lineCount: number;
  metadata?: Record<string, unknown>;
  topKeys?: string[];
  type: "json";
}

export interface TextPreview extends BaseArtifactPreview {
  content: string;
  lineCount: number;
  metadata?: Record<string, unknown>;
  truncated?: boolean;
  type: "text";
}

export interface HtmlPreview extends BaseArtifactPreview {
  metadata?: Record<string, unknown>;
  safeHtml: string;
  sandbox?: string;
  title?: string;
  type: "html";
}

export interface GenericPreview extends BaseArtifactPreview {
  metadata?: Record<string, unknown>;
  type: "generic";
}

export type ArtifactPreview =
  | PdfPreview
  | SpreadsheetPreview
  | PresentationPreview
  | DocumentPreview
  | ImagePreview
  | MarkdownPreview
  | CodePreview
  | JsonPreview
  | TextPreview
  | HtmlPreview
  | GenericPreview;

export interface PreviewAsset {
  height?: number;
  id: string;
  kind: "original" | "preview" | "thumbnail" | "page" | "slide" | "converted";
  mimeType: string;
  page?: number;
  slide?: number;
  url?: string;
  width?: number;
}

export interface PreviewManifest {
  artifactId: string;
  assets: PreviewAsset[];
  contentHash?: string;
  derivedFrom?: {
    assetId: string;
    mimeType: string;
  };
  error?: {
    code: string;
    message: string;
  };
  metadata: Record<string, unknown>;
  previewerVersion: string;
  renderer: PreviewType;
  revision: number;
  sourceMimeType: string;
  status: PreviewStatus;
  strategy: PreviewStrategy;
  type: PreviewType;
}

export interface PreviewJob {
  artifactId: string;
  completedAt?: string;
  createdAt: string;
  errorCode?: string;
  errorMessage?: string;
  id: string;
  previewerVersion: string;
  revision: number;
  startedAt?: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
}

export interface PreviewDescriptor {
  metadata?: Record<string, unknown>;
  previewUrl?: string;
  status: PreviewStatus;
  thumbnailUrl?: string;
  type: PreviewType;
}

export const PREVIEW_VERSION = 1;
export const PREVIEWER_VERSION = "v1.1";

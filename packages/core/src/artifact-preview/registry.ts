import type { ArtifactFileTarget, ArtifactPreviewer } from "./previewer";
import { CodePreviewer } from "./previewers/code-previewer";
import { DocumentPreviewer } from "./previewers/document-previewer";
import { GenericPreviewer } from "./previewers/generic-previewer";
import { HtmlPreviewer } from "./previewers/html-previewer";
import { ImagePreviewer } from "./previewers/image-previewer";
import { JsonPreviewer } from "./previewers/json-previewer";
import { MarkdownPreviewer } from "./previewers/markdown-previewer";
import { PdfPreviewer } from "./previewers/pdf-previewer";
import { PresentationPreviewer } from "./previewers/presentation-previewer";
import { SpreadsheetPreviewer } from "./previewers/spreadsheet-previewer";
import { TextPreviewer } from "./previewers/text-previewer";
import { isSignatureCompatible } from "./signature";
import type {
  ArtifactPreview,
  PreviewContext,
  PreviewMetadata,
  PreviewOptions,
  PreviewType,
} from "./types";

export class PreviewRegistry {
  private readonly previewers: ArtifactPreviewer[] = [];
  private readonly fallbackPreviewer = new GenericPreviewer();

  constructor() {
    this.registerDefaults();
  }

  private registerDefaults(): void {
    // Specific binary formats
    this.register(new PdfPreviewer());
    this.register(new SpreadsheetPreviewer());
    this.register(new PresentationPreviewer());
    this.register(new DocumentPreviewer());
    this.register(new ImagePreviewer());

    // Structured text & code formats
    this.register(new MarkdownPreviewer());
    this.register(new JsonPreviewer());
    this.register(new HtmlPreviewer());
    this.register(new CodePreviewer());
    this.register(new TextPreviewer());
  }

  register(previewer: ArtifactPreviewer): void {
    this.previewers.push(previewer);
  }

  findPreviewer(
    artifact: { filename: string; mimeType: string },
    buffer?: Buffer
  ): ArtifactPreviewer {
    const ext = artifact.filename.split(".").pop() || "";
    if (buffer && !isSignatureCompatible(ext, artifact.mimeType, buffer)) {
      return this.fallbackPreviewer;
    }

    for (const previewer of this.previewers) {
      if (previewer.supports(artifact, buffer)) {
        return previewer;
      }
    }
    return this.fallbackPreviewer;
  }

  detectPreviewType(
    artifact: { filename: string; mimeType: string },
    buffer?: Buffer
  ): PreviewType {
    return this.findPreviewer(artifact, buffer).type;
  }

  async inspect(
    artifact: ArtifactFileTarget,
    buffer: Buffer,
    context: PreviewContext
  ): Promise<PreviewMetadata> {
    const previewer = this.findPreviewer(artifact, buffer);
    return previewer.inspect(artifact, buffer, context);
  }

  async generate(
    artifact: ArtifactFileTarget,
    buffer: Buffer,
    options: PreviewOptions,
    context: PreviewContext
  ): Promise<ArtifactPreview> {
    const previewer = this.findPreviewer(artifact, buffer);
    return previewer.generate(artifact, buffer, options, context);
  }
}

export const defaultPreviewRegistry = new PreviewRegistry();

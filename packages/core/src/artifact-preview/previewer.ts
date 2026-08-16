import type {
  ArtifactPreview,
  PreviewContext,
  PreviewMetadata,
  PreviewOptions,
  PreviewType,
} from "./types";

export interface ArtifactFileTarget {
  artifactId?: string;
  filename: string;
  mimeType: string;
  path?: string;
  revision?: number;
  sizeBytes: number;
}

export interface ArtifactPreviewer {
  /**
   * Generate canonical derived preview representation.
   */
  generate(
    artifact: ArtifactFileTarget,
    buffer: Buffer,
    options: PreviewOptions,
    context: PreviewContext
  ): Promise<ArtifactPreview>;

  /**
   * Cheap inspection for metadata without heavy conversion (slides count, sheet names, dimensions, etc.).
   */
  inspect(
    artifact: ArtifactFileTarget,
    buffer: Buffer,
    context: PreviewContext
  ): Promise<PreviewMetadata>;

  /**
   * Check if this previewer can handle the given artifact by filename, mimeType or signature.
   */
  supports(
    artifact: { filename: string; mimeType: string },
    buffer?: Buffer
  ): boolean;
  readonly type: PreviewType;
}

import { createHash } from "node:crypto";
import { derivedAssetStore } from "./derived-asset-store";
import { OFFICE_CONVERTER_VERSION, officeConverter } from "./office-converter";
import type { ArtifactFileTarget } from "./previewer";
import { defaultPreviewRegistry, type PreviewRegistry } from "./registry";
import {
  type ArtifactPreview,
  type PdfPreview,
  PREVIEW_VERSION,
  PREVIEWER_VERSION,
  type PreviewAsset,
  type PreviewContext,
  type PreviewJob,
  type PreviewManifest,
  type PreviewMetadata,
  type PreviewOptions,
  type PreviewStrategy,
  type PreviewType,
} from "./types";

export const MAX_PREVIEW_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB
export const PREVIEW_GENERATION_TIMEOUT_MS = 25_000; // 25s

export function computeContentHash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 16);
}

export class PreviewService {
  private readonly registry: PreviewRegistry;
  private readonly cache = new Map<
    string,
    { expiresAt: number; preview: ArtifactPreview }
  >();
  private readonly inFlightJobs = new Map<string, Promise<ArtifactPreview>>();
  private readonly previewJobs = new Map<string, PreviewJob>();
  private readonly cacheTtlMs = 10 * 60 * 1000; // 10 minutes

  constructor(registry: PreviewRegistry = defaultPreviewRegistry) {
    this.registry = registry;
  }

  buildCacheKey(
    context: PreviewContext,
    artifact: ArtifactFileTarget,
    options: PreviewOptions,
    buffer?: Buffer
  ): string {
    const rev = options.revision ?? artifact.revision ?? 1;
    const targetId = artifact.artifactId || artifact.path || artifact.filename;
    const contentHash = buffer ? computeContentHash(buffer) : "nohash";
    const sheetKey =
      options.sheet ||
      (options.sheetIndex === undefined ? "" : `idx${options.sheetIndex}`);
    const rangeKey = options.range || "";
    const strategyKey = options.strategy || "auto";
    return `${context.orgId}:${context.profileId}:${targetId}:r${rev}:${contentHash}:${PREVIEWER_VERSION}:${OFFICE_CONVERTER_VERSION}:${strategyKey}:${sheetKey}:${rangeKey}`;
  }

  detectStrategy(
    artifact: { filename: string; mimeType: string },
    buffer?: Buffer
  ): PreviewType {
    return this.registry.detectPreviewType(artifact, buffer);
  }

  async inspect(
    artifact: ArtifactFileTarget,
    buffer: Buffer,
    context: PreviewContext
  ): Promise<PreviewMetadata> {
    if (buffer.length > MAX_PREVIEW_FILE_SIZE_BYTES) {
      return {
        metadata: { sizeBytes: buffer.length },
        status: "unsupported",
        summary: `File too large for preview (${Math.round(buffer.length / 1024 / 1024)}MB)`,
        type: "generic",
      };
    }

    return this.registry.inspect(artifact, buffer, context);
  }

  async generate(
    artifact: ArtifactFileTarget,
    buffer: Buffer,
    options: PreviewOptions,
    context: PreviewContext
  ): Promise<ArtifactPreview> {
    if (buffer.length > MAX_PREVIEW_FILE_SIZE_BYTES) {
      const targetPath = artifact.path || artifact.filename;
      return {
        artifactId: artifact.artifactId,
        downloadUrl: `/v1/profiles/${encodeURIComponent(context.profileId)}/artifacts/content?path=${encodeURIComponent(targetPath)}`,
        error: `File exceeds maximum preview limit (${Math.round(buffer.length / 1024 / 1024)} MB).`,
        filename: artifact.filename,
        generatedAt: new Date().toISOString(),
        metadata: { sizeBytes: buffer.length },
        mimeType: artifact.mimeType,
        previewVersion: PREVIEW_VERSION,
        revision: artifact.revision,
        sizeBytes: buffer.length,
        status: "failed",
        type: "generic",
      };
    }

    const cacheKey = this.buildCacheKey(context, artifact, options, buffer);
    if (!options.forceRegenerate) {
      const cached = this.cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return {
          ...cached.preview,
          cached: true,
        };
      }
    }

    // In-flight deduplication: if the exact same preview is currently being computed, await it
    const existingPromise = this.inFlightJobs.get(cacheKey);
    if (existingPromise) {
      return existingPromise;
    }

    const targetId = artifact.artifactId || artifact.path || artifact.filename;
    const rev = options.revision ?? artifact.revision ?? 1;
    const contentHash = computeContentHash(buffer);
    const jobId = `job_${createHash("md5").update(cacheKey).digest("hex").slice(0, 12)}`;
    const job: PreviewJob = {
      artifactId: targetId,
      createdAt: new Date().toISOString(),
      id: jobId,
      previewerVersion: PREVIEWER_VERSION,
      revision: rev,
      startedAt: new Date().toISOString(),
      status: "running",
    };
    this.previewJobs.set(jobId, job);

    // Run with timeout & in-flight deduplication
    const executionPromise = (async () => {
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error("Preview generation timed out.")),
            PREVIEW_GENERATION_TIMEOUT_MS
          );
        });

        const computeTask = async (): Promise<ArtifactPreview> => {
          const targetPath = artifact.path || artifact.filename;
          const downloadUrl = `/v1/profiles/${encodeURIComponent(context.profileId)}/artifacts/content?path=${encodeURIComponent(targetPath)}`;

          // 1. Office Fidelity Conversion Path for PPTX and DOCX
          const isOffice = officeConverter.isSupportedOfficeFormat(
            artifact.filename,
            artifact.mimeType
          );

          if (isOffice && options.strategy !== "semantic") {
            try {
              // Check cached derived asset
              const existingAsset = derivedAssetStore.getDerivedAsset(
                context.orgId,
                context.profileId,
                targetId,
                rev,
                contentHash,
                OFFICE_CONVERTER_VERSION
              );

              let pageCount = existingAsset?.pageCount;
              let converterVersion =
                existingAsset?.converterVersion || OFFICE_CONVERTER_VERSION;

              if (!existingAsset) {
                const conversionResult =
                  await officeConverter.convertOfficeToPdf({
                    buffer,
                    filename: artifact.filename,
                  });
                pageCount = conversionResult.pageCount;
                converterVersion = conversionResult.converterVersion;

                derivedAssetStore.storeDerivedAsset({
                  artifactId: targetId,
                  bytes: conversionResult.pdfBytes,
                  contentHash,
                  converterVersion,
                  mimeType: "application/pdf",
                  orgId: context.orgId,
                  pageCount,
                  profileId: context.profileId,
                  revision: rev,
                });
              }

              const previewUrl = `/v1/profiles/${encodeURIComponent(context.profileId)}/artifacts/derived-pdf?path=${encodeURIComponent(targetPath)}&revision=${rev}&hash=${contentHash}&inline=1`;

              const convertedPreview: PdfPreview = {
                artifactId: artifact.artifactId,
                downloadUrl,
                filename: artifact.filename,
                generatedAt: new Date().toISOString(),
                metadata: {
                  converterVersion,
                  originalFormat:
                    artifact.filename.split(".").pop() || "office",
                  pageCount: pageCount ?? 1,
                },
                mimeType: artifact.mimeType,
                pageCount: pageCount ?? 1,
                previewUrl,
                previewVersion: PREVIEW_VERSION,
                revision: rev,
                sizeBytes: buffer.length,
                status: "available",
                strategy: "converted",
                type: "pdf",
              };

              return convertedPreview;
            } catch {
              // Conversion failed or converter not available -> gracefully fallback to semantic preview
            }
          }

          // 2. Semantic Preview Pipeline
          const semanticPreview = await this.registry.generate(
            artifact,
            buffer,
            options,
            context
          );

          let defaultStrategy: PreviewStrategy = "native";
          if (
            semanticPreview.type === "presentation" ||
            semanticPreview.type === "document" ||
            semanticPreview.type === "spreadsheet"
          ) {
            defaultStrategy = "semantic";
          } else if (semanticPreview.type === "generic") {
            defaultStrategy = "generic";
          }

          return {
            ...semanticPreview,
            strategy: semanticPreview.strategy || defaultStrategy,
          };
        };

        const preview = await Promise.race([computeTask(), timeoutPromise]);

        this.cache.set(cacheKey, {
          expiresAt: Date.now() + this.cacheTtlMs,
          preview,
        });

        job.status = "completed";
        job.completedAt = new Date().toISOString();
        return preview;
      } catch (err) {
        job.status = "failed";
        job.errorMessage =
          err instanceof Error ? err.message : "Failed to generate preview";
        job.completedAt = new Date().toISOString();
        throw err;
      } finally {
        this.inFlightJobs.delete(cacheKey);
      }
    })();

    this.inFlightJobs.set(cacheKey, executionPromise);
    return executionPromise;
  }

  async generateManifest(
    artifact: ArtifactFileTarget,
    buffer: Buffer,
    options: PreviewOptions,
    context: PreviewContext
  ): Promise<PreviewManifest> {
    const preview = await this.generate(artifact, buffer, options, context);
    const contentHash = computeContentHash(buffer);
    const rev = options.revision ?? artifact.revision ?? 1;
    const targetId = artifact.artifactId || artifact.path || artifact.filename;

    const assets: PreviewAsset[] = [
      {
        id: `${targetId}-original`,
        kind: "original",
        mimeType: artifact.mimeType,
        url: preview.downloadUrl,
      },
    ];

    if (preview.type === "pdf") {
      assets.push({
        id: `${targetId}-preview-pdf`,
        kind: preview.strategy === "converted" ? "converted" : "preview",
        mimeType: "application/pdf",
        page: preview.pageCount,
        url: preview.previewUrl || preview.downloadUrl,
      });
    } else if (preview.type === "presentation" && preview.slides) {
      preview.slides.forEach((_slide, idx) => {
        assets.push({
          id: `${targetId}-slide-${idx + 1}`,
          kind: "slide",
          mimeType: "application/json",
          slide: idx + 1,
        });
      });
    } else if (preview.type === "image") {
      assets.push({
        height: preview.height,
        id: `${targetId}-image-preview`,
        kind: "preview",
        mimeType: preview.mimeType,
        url: preview.url || preview.downloadUrl,
        width: preview.width,
      });
    }

    const strategy: PreviewStrategy = preview.strategy || "native";

    const derivedFrom =
      preview.strategy === "converted"
        ? {
            assetId: `${targetId}-original`,
            mimeType: artifact.mimeType,
          }
        : undefined;

    return {
      artifactId: targetId,
      assets,
      contentHash,
      derivedFrom,
      metadata: (preview.metadata as Record<string, unknown>) || {},
      previewerVersion: PREVIEWER_VERSION,
      renderer: preview.type,
      revision: rev,
      sourceMimeType: artifact.mimeType || "application/octet-stream",
      status: preview.status,
      strategy,
      type: preview.type,
    };
  }

  async getOrGenerateDerivedPdf(
    artifact: ArtifactFileTarget,
    buffer: Buffer,
    options: PreviewOptions,
    context: PreviewContext
  ): Promise<{ bytes: Buffer; pageCount: number }> {
    const targetId = artifact.artifactId || artifact.path || artifact.filename;
    const rev = options.revision ?? artifact.revision ?? 1;
    const contentHash = computeContentHash(buffer);

    const existing = derivedAssetStore.getDerivedAsset(
      context.orgId,
      context.profileId,
      targetId,
      rev,
      contentHash,
      OFFICE_CONVERTER_VERSION
    );

    if (existing) {
      return { bytes: existing.bytes, pageCount: existing.pageCount };
    }

    const conversionResult = await officeConverter.convertOfficeToPdf({
      buffer,
      filename: artifact.filename,
    });

    derivedAssetStore.storeDerivedAsset({
      artifactId: targetId,
      bytes: conversionResult.pdfBytes,
      contentHash,
      converterVersion: conversionResult.converterVersion,
      mimeType: "application/pdf",
      orgId: context.orgId,
      pageCount: conversionResult.pageCount,
      profileId: context.profileId,
      revision: rev,
    });

    return {
      bytes: conversionResult.pdfBytes,
      pageCount: conversionResult.pageCount,
    };
  }

  getJob(jobId: string): PreviewJob | undefined {
    return this.previewJobs.get(jobId);
  }

  invalidate(orgId: string, profileId: string, pathPrefix?: string): void {
    const prefix = `${orgId}:${profileId}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix) && (!pathPrefix || key.includes(pathPrefix))) {
        this.cache.delete(key);
      }
    }
    derivedAssetStore.invalidate(orgId, profileId, pathPrefix);
  }

  clearCache(): void {
    this.cache.clear();
    this.inFlightJobs.clear();
    this.previewJobs.clear();
    derivedAssetStore.clear();
  }
}

export const previewService = new PreviewService();

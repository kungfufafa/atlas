import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  getProfileSoulDir,
  guardFilePath,
  nanoid,
  type ToolArtifact,
} from "@atlas/core";
import {
  type Artifact,
  type ArtifactType,
  inferArtifactType,
} from "@atlas/core/artifact-types";
import { inspectPptxBuffer } from "@atlas/core/presentation-engine";
import { inspectSpreadsheetBuffer } from "@atlas/core/tools/spreadsheet-inspect";

export interface StoredArtifactMetadata {
  createdAt: string;
  filename: string;
  id: string;
  metadata?: Record<string, unknown>;
  mimeType: string;
  profileId: string;
  relativePath: string;
  sessionId?: string;
  sizeBytes: number;
  type: ArtifactType;
}

export function detectArtifactMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".svg":
      return "image/svg+xml";
    case ".webp":
      return "image/webp";
    case ".csv":
      return "text/csv";
    case ".json":
      return "application/json";
    case ".html":
      return "text/html";
    case ".txt":
    case ".md":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

export class ArtifactService {
  /**
   * Save or create a newly generated artifact in the profile workspace.
   */
  async saveArtifact(
    orgId: string,
    profileId: string,
    filename: string,
    content: Buffer | string,
    options: {
      metadata?: Record<string, unknown>;
      mimeType?: string;
      sessionId?: string;
    } = {}
  ): Promise<ToolArtifact> {
    const soulDir = getProfileSoulDir(orgId, profileId);
    const artifactsDir = path.join(soulDir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });

    const safeFilename = path.basename(filename);
    const targetPath = path.join(artifactsDir, safeFilename);
    const guarded = await guardFilePath(targetPath, soulDir, undefined, {
      allowedDirs: [soulDir],
      cwd: soulDir,
    });

    if (typeof content === "string") {
      await writeFile(guarded.resolved, content, "utf8");
    } else {
      await writeFile(guarded.resolved, content);
    }

    const fileStat = await stat(guarded.resolved);
    const mimeType = options.mimeType ?? detectArtifactMimeType(safeFilename);
    const id = nanoid(12);

    return {
      createdAt: new Date().toISOString(),
      filename: safeFilename,
      id,
      mimeType,
      path: path.relative(soulDir, guarded.resolved),
      sessionId: options.sessionId,
      sizeBytes: fileStat.size,
    };
  }

  async createArtifact(
    orgId: string,
    profileId: string,
    filename: string,
    content: Buffer | string,
    options: {
      metadata?: Record<string, unknown>;
      mimeType?: string;
      sessionId?: string;
    } = {}
  ): Promise<ToolArtifact> {
    return this.saveArtifact(orgId, profileId, filename, content, options);
  }

  /**
   * List all artifacts generated within a profile workspace.
   */
  async listArtifacts(
    orgId: string,
    profileId: string,
    sessionId?: string
  ): Promise<Artifact[]> {
    const soulDir = getProfileSoulDir(orgId, profileId);
    const artifactsDir = path.join(soulDir, "artifacts");
    const results: Artifact[] = [];

    try {
      const entries = await readdir(artifactsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) {
          const filePath = path.join(artifactsDir, entry.name);
          const fileStat = await stat(filePath);
          const mimeType = detectArtifactMimeType(entry.name);
          const type = inferArtifactType(entry.name, mimeType);

          results.push({
            createdAt: fileStat.birthtime.toISOString(),
            filename: entry.name,
            id: entry.name,
            mimeType,
            path: path.relative(soulDir, filePath),
            sessionId,
            size: fileStat.size,
            type,
          });
        }
      }
    } catch {
      // Artifacts dir does not exist yet
    }

    return results;
  }

  /**
   * Read raw artifact file content.
   */
  async getArtifact(
    orgId: string,
    profileId: string,
    relativePath: string
  ): Promise<{
    content: Buffer;
    mimeType: string;
    sizeBytes: number;
    type: ArtifactType;
  }> {
    const soulDir = getProfileSoulDir(orgId, profileId);
    const guarded = await guardFilePath(relativePath, soulDir, undefined, {
      allowedDirs: [soulDir],
      cwd: soulDir,
    });

    const content = await readFile(guarded.resolved);
    const fileStat = await stat(guarded.resolved);
    const mimeType = detectArtifactMimeType(guarded.resolved);
    const type = inferArtifactType(path.basename(guarded.resolved), mimeType);

    return {
      content,
      mimeType,
      sizeBytes: fileStat.size,
      type,
    };
  }

  async retrieveArtifact(
    orgId: string,
    profileId: string,
    relativePath: string
  ) {
    return this.getArtifact(orgId, profileId, relativePath);
  }

  /**
   * Inspect rich artifact metadata (slides, sheets, headings, etc.).
   */
  async inspectArtifact(
    orgId: string,
    profileId: string,
    relativePath: string
  ): Promise<{
    filename: string;
    metadata: Record<string, unknown>;
    mimeType: string;
    sizeBytes: number;
    type: ArtifactType;
  }> {
    const { content, mimeType, sizeBytes, type } = await this.getArtifact(
      orgId,
      profileId,
      relativePath
    );

    const filename = path.basename(relativePath);
    const metadata: Record<string, unknown> = {};

    if (type === "presentation") {
      try {
        const pptxInfo = await inspectPptxBuffer(content);
        metadata.slideCount = pptxInfo.slideCount;
      } catch {
        metadata.slideCount = 0;
      }
    } else if (type === "spreadsheet" && filename.endsWith(".xlsx")) {
      try {
        const sheetInfo = await inspectSpreadsheetBuffer(content);
        metadata.sheetNames = sheetInfo.sheetNames;
        metadata.sheetCount = sheetInfo.sheetCount;
        metadata.rowCount = sheetInfo.rowCount;
        metadata.columnCount = sheetInfo.columnCount;
      } catch {
        metadata.sheetNames = [];
      }
    } else if (type === "document") {
      const text = content.toString("utf8");
      metadata.characterCount = text.length;
      metadata.lineCount = text.split("\n").length;
      metadata.wordCount = text.trim().split(/\s+/).filter(Boolean).length;
    }

    return {
      filename,
      metadata,
      mimeType,
      sizeBytes,
      type,
    };
  }

  /**
   * Delete an artifact from the profile workspace.
   */
  async deleteArtifact(
    orgId: string,
    profileId: string,
    relativePath: string
  ): Promise<boolean> {
    const soulDir = getProfileSoulDir(orgId, profileId);
    const guarded = await guardFilePath(relativePath, soulDir, undefined, {
      allowedDirs: [soulDir],
      cwd: soulDir,
    });

    await rm(guarded.resolved, { force: true });
    return true;
  }
}

export const artifactService = new ArtifactService();

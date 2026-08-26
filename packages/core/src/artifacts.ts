import { readdir, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AtlasApiError } from "./api-error";
import { classifyArtifactCategory } from "./artifact-category";
import {
  inferArtifactMimeType,
  isDocxFile,
  isLegacyDocFile,
} from "./artifact-mime";
import { resolveServedArtifactContentType } from "./artifact-preview/signature";
import { resolveProfileArtifactsRoot } from "./artifact-root";
import type {
  ArtifactFile,
  ArtifactFolderMetadata,
  DeleteArtifactResponse,
  ListArtifactsOptions,
  ListArtifactsResponse,
} from "./contract";
import { convertDocxToMarkdown } from "./docx-text";
import { pathExists } from "./fs";
import { getProfileArtifactsDir } from "./soul/resolve";
import { guardFilePath } from "./tools/paths";

const ARTIFACT_META_SUFFIX = ".atlas-meta.json";

const artifactMetaSchema = z.object({
  formatDetails: z.record(z.string(), z.unknown()).optional(),
  id: z.string().optional(),
  mimeType: z.string().trim().min(1),
  parentArtifactId: z.string().optional(),
  revision: z.number().int().positive().optional(),
  rootArtifactId: z.string().optional(),
  savedAt: z.string().trim().min(1),
  sizeBytes: z.number().int().nonnegative(),
});

type ArtifactMeta = z.infer<typeof artifactMetaSchema>;

function getArtifactMetaPath(filePath: string): string {
  return `${filePath}${ARTIFACT_META_SUFFIX}`;
}

function isArtifactMetaFile(filename: string): boolean {
  return (
    filename.endsWith(ARTIFACT_META_SUFFIX) ||
    filename.endsWith(".meta.json") ||
    filename.includes(".atlas-meta")
  );
}

export async function listArtifacts(
  orgId: string,
  profileId: string,
  options: ListArtifactsOptions = {}
): Promise<ListArtifactsResponse> {
  const directory = getProfileArtifactsDir(orgId, profileId);
  let resolvedDirectory: string;
  try {
    resolvedDirectory = await resolveProfileArtifactsRoot(orgId, profileId);
  } catch (error) {
    if (error instanceof AtlasApiError && error.status === 404) {
      return { artifacts: [], directory, folders: [], profileId, total: 0 };
    }
    throw error;
  }

  const allArtifacts = await walkArtifacts(
    resolvedDirectory,
    resolvedDirectory
  );
  allArtifacts.sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
  );
  const folder = normalizeArtifactFolder(options.folder);
  const folders = summarizeImmediateArtifactFolders(allArtifacts, folder);
  const artifacts =
    options.folder === undefined
      ? allArtifacts
      : allArtifacts.filter((artifact) =>
          isImmediateArtifactChild(artifact.filename, folder)
        );

  const total = artifacts.length;
  const offset = options.offset ?? 0;

  if (options.limit !== undefined) {
    return {
      artifacts: artifacts.slice(offset, offset + options.limit),
      directory: resolvedDirectory,
      folders,
      limit: options.limit,
      offset,
      profileId,
      total,
    };
  }

  return {
    artifacts,
    directory: resolvedDirectory,
    folders,
    profileId,
    total,
  };
}

function normalizeArtifactFolder(folder: string | undefined): string {
  if (folder === undefined || folder === "") {
    return "";
  }
  if (
    folder.includes("\\") ||
    path.isAbsolute(folder) ||
    folder
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new AtlasApiError("Artifact folder path is invalid.", 400);
  }
  return folder;
}

function isImmediateArtifactChild(filename: string, folder: string): boolean {
  const prefix = folder ? `${folder}/` : "";
  if (!filename.startsWith(prefix)) {
    return false;
  }
  const rest = filename.slice(prefix.length);
  return Boolean(rest) && !rest.includes("/");
}

function summarizeImmediateArtifactFolders(
  artifacts: ArtifactFile[],
  folder: string
): ArtifactFolderMetadata[] {
  const prefix = folder ? `${folder}/` : "";
  const folders = new Map<string, ArtifactFolderMetadata>();

  for (const artifact of artifacts) {
    if (!artifact.filename.startsWith(prefix)) {
      continue;
    }
    const rest = artifact.filename.slice(prefix.length);
    const separator = rest.indexOf("/");
    if (separator <= 0) {
      continue;
    }

    const name = rest.slice(0, separator);
    const childPrefix = folder ? `${folder}/${name}` : name;
    const category = classifyArtifactCategory(artifact);
    const existing = folders.get(childPrefix);
    if (!existing) {
      folders.set(childPrefix, {
        fileCount: 1,
        latestUpdatedAt: artifact.updatedAt,
        name,
        prefix: childPrefix,
        typeStats: {
          [category]: {
            fileCount: 1,
            latestUpdatedAt: artifact.updatedAt,
          },
        },
      });
      continue;
    }

    existing.fileCount += 1;
    if (artifact.updatedAt > existing.latestUpdatedAt) {
      existing.latestUpdatedAt = artifact.updatedAt;
    }
    const categoryStats = existing.typeStats[category];
    if (categoryStats) {
      categoryStats.fileCount += 1;
      if (artifact.updatedAt > categoryStats.latestUpdatedAt) {
        categoryStats.latestUpdatedAt = artifact.updatedAt;
      }
    } else {
      existing.typeStats[category] = {
        fileCount: 1,
        latestUpdatedAt: artifact.updatedAt,
      };
    }
  }

  return [...folders.values()].sort((left, right) =>
    left.name.localeCompare(right.name)
  );
}

async function walkArtifacts(
  rootDir: string,
  currentDir: string
): Promise<ArtifactFile[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: ArtifactFile[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await walkArtifacts(rootDir, absolutePath)));
      continue;
    }

    if (!entry.isFile() || isArtifactMetaFile(entry.name)) {
      continue;
    }

    const fileStat = await stat(absolutePath);
    const metadata = await readArtifactMeta(
      absolutePath,
      fileStat.size,
      fileStat.mtime.toISOString()
    );
    const relativePath = path
      .relative(rootDir, absolutePath)
      .split(path.sep)
      .join("/");
    files.push({
      filename: relativePath,
      formatDetails: metadata.formatDetails as
        | import("./artifact-types").ArtifactFormatDetails
        | undefined,
      mimeType: metadata.mimeType,
      parentArtifactId: metadata.parentArtifactId,
      path: relativePath,
      revision: metadata.revision,
      rootArtifactId: metadata.rootArtifactId,
      sizeBytes: metadata.sizeBytes,
      updatedAt: metadata.savedAt,
    });
  }

  return files;
}

async function readArtifactMeta(
  filePath: string,
  fallbackSizeBytes: number,
  fallbackSavedAt: string
): Promise<ArtifactMeta> {
  const metaPath = getArtifactMetaPath(filePath);
  const altMetaPath = `${filePath}.meta.json`;

  try {
    const targetPath = (await pathExists(metaPath))
      ? metaPath
      : (await pathExists(altMetaPath))
        ? altMetaPath
        : metaPath;
    const raw = await readFile(targetPath, "utf8");
    return artifactMetaSchema.parse(JSON.parse(raw));
  } catch {
    // Artifacts written straight to disk (no `save-artifact` sidecar) still need
    // an accurate type, otherwise the UI cannot preview them.
    return {
      mimeType: inferArtifactMimeType(path.basename(filePath)),
      savedAt: fallbackSavedAt,
      sizeBytes: fallbackSizeBytes,
    };
  }
}

/**
 * Map artifact read failures to HTTP-shaped outcomes without leaking server
 * filesystem paths in the message.
 */
export function mapArtifactReadError(
  error: unknown,
  filename: string
): { message: string; status: 400 | 404 | 500 } {
  const err = error as NodeJS.ErrnoException | undefined;
  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof AtlasApiError) {
    return {
      message: error.message,
      status: error.status === 400 || error.status === 404 ? error.status : 500,
    };
  }

  if (err?.code === "ENOENT" || message.includes("Artifact not found")) {
    return { message: `Artifact not found: ${filename}`, status: 404 };
  }
  if (message.includes("outside allowed directories")) {
    return { message, status: 400 };
  }
  return { message: "Failed to read artifact.", status: 500 };
}

export async function readArtifactFile(input: {
  orgId: string;
  profileId: string;
  filename: string;
  /**
   * Convert the artifact to Markdown for preview instead of serving raw bytes.
   * Downloads must stay byte-exact, so this is opt-in.
   */
  render?: "markdown";
}): Promise<{
  bytes: Buffer;
  contentType: string;
  filePath: string;
  /** Workspace-relative POSIX-style path, safe to expose in client URLs. */
  relativePath: string;
}> {
  const resolvedArtifactsDir = await resolveProfileArtifactsRoot(
    input.orgId,
    input.profileId
  );
  const guarded = await guardFilePath(input.filename, null, undefined, {
    allowedDirs: [resolvedArtifactsDir],
    cwd: resolvedArtifactsDir,
  });
  const filePath = guarded.resolved;
  const fileStat = await stat(filePath);

  if (!fileStat.isFile()) {
    throw new Error(`Artifact not found: ${input.filename}`);
  }

  const relativePath = path
    .relative(resolvedArtifactsDir, filePath)
    .split(path.sep)
    .join("/");

  const metadata = await readArtifactMeta(
    filePath,
    fileStat.size,
    fileStat.mtime.toISOString()
  );
  const bytes = await readFile(filePath);
  const filename = path.basename(filePath);

  const isWordLike =
    isDocxFile(filename, metadata.mimeType) ||
    isLegacyDocFile(filename, metadata.mimeType);

  if (input.render === "markdown" && isWordLike) {
    const markdown = await convertDocxToMarkdown(bytes);
    return {
      bytes: Buffer.from(markdown, "utf8"),
      contentType: "text/markdown",
      filePath,
      relativePath,
    };
  }

  return {
    bytes,
    contentType: resolveServedArtifactContentType(
      filename,
      metadata.mimeType,
      bytes
    ),
    filePath,
    relativePath,
  };
}

export async function deleteArtifactFile(input: {
  orgId: string;
  profileId: string;
  filename: string;
}): Promise<DeleteArtifactResponse> {
  const resolvedArtifactsDir = await resolveProfileArtifactsRoot(
    input.orgId,
    input.profileId
  );
  const guarded = await guardFilePath(input.filename, null, undefined, {
    allowedDirs: [resolvedArtifactsDir],
    cwd: resolvedArtifactsDir,
  });
  const filePath = guarded.resolved;
  const fileStat = await stat(filePath);

  if (!fileStat.isFile()) {
    throw new Error(`Artifact not found: ${input.filename}`);
  }

  await unlink(filePath);

  const metaPath = getArtifactMetaPath(filePath);
  if (await pathExists(metaPath)) {
    await unlink(metaPath);
  }

  return {
    deleted: true,
    filename: path.relative(resolvedArtifactsDir, filePath),
    profileId: input.profileId,
  };
}

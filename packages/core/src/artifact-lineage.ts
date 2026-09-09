import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { nanoid } from "nanoid";
import { inferArtifactMimeType } from "./artifact-mime";
import type { ArtifactFormatDetails } from "./artifact-types";
import { inferArtifactType } from "./artifact-types";
import { pathExists } from "./fs";

export const ARTIFACT_LINEAGE_META_SUFFIX = ".atlas-meta.json";

export interface ArtifactLineageMeta {
  formatDetails?: ArtifactFormatDetails;
  id: string;
  mimeType: string;
  parentArtifactId?: string;
  revision: number;
  rootArtifactId: string;
  savedAt: string;
  sizeBytes: number;
}

export function inferFormatDetails(
  filename: string,
  mimeType: string,
  extra: ArtifactFormatDetails = {}
): ArtifactFormatDetails {
  const type = inferArtifactType(filename, mimeType);
  const lower = filename.toLowerCase();
  const compiler: ArtifactFormatDetails["compiler"] =
    lower.endsWith(".jsx") || lower.endsWith(".tsx")
      ? "jsx"
      : lower.endsWith(".html") || lower.endsWith(".htm")
        ? "html"
        : undefined;

  return {
    ...(compiler ? { compiler } : {}),
    ...(type === "presentation" ? { slideCount: extra.slideCount } : {}),
    ...(type === "spreadsheet" ? { sheetCount: extra.sheetCount } : {}),
    ...(type === "pdf" || type === "document"
      ? { pageCount: extra.pageCount }
      : {}),
    ...extra,
  };
}

export function lineageMetaPath(filePath: string): string {
  return `${filePath}${ARTIFACT_LINEAGE_META_SUFFIX}`;
}

export async function readLineageMeta(
  filePath: string
): Promise<ArtifactLineageMeta | null> {
  const metaPath = lineageMetaPath(filePath);
  const altPath = `${filePath}.meta.json`;
  const target = (await pathExists(metaPath))
    ? metaPath
    : (await pathExists(altPath))
      ? altPath
      : null;
  if (!target) {
    return null;
  }

  try {
    const raw = JSON.parse(
      await readFile(target, "utf8")
    ) as Partial<ArtifactLineageMeta>;
    if (typeof raw.mimeType !== "string" || typeof raw.savedAt !== "string") {
      return null;
    }
    const id = typeof raw.id === "string" && raw.id ? raw.id : nanoid(12);
    return {
      formatDetails:
        raw.formatDetails && typeof raw.formatDetails === "object"
          ? raw.formatDetails
          : undefined,
      id,
      mimeType: raw.mimeType,
      parentArtifactId:
        typeof raw.parentArtifactId === "string"
          ? raw.parentArtifactId
          : undefined,
      revision:
        typeof raw.revision === "number" && raw.revision > 0 ? raw.revision : 1,
      rootArtifactId:
        typeof raw.rootArtifactId === "string" && raw.rootArtifactId
          ? raw.rootArtifactId
          : id,
      savedAt: raw.savedAt,
      sizeBytes:
        typeof raw.sizeBytes === "number" && raw.sizeBytes >= 0
          ? raw.sizeBytes
          : 0,
    };
  } catch {
    return null;
  }
}

async function sizeOnDisk(filePath: string): Promise<number | null> {
  try {
    const info = await stat(filePath);
    return info.isFile() ? info.size : null;
  } catch {
    return null;
  }
}

export async function stampArtifactLineage(input: {
  extraDetails?: ArtifactFormatDetails;
  parentFilePath?: string;
  sizeBytes: number;
  writtenPath: string;
}): Promise<ArtifactLineageMeta> {
  const filename = path.basename(input.writtenPath);
  const mimeType = inferArtifactMimeType(filename);
  const sizeBytes = (await sizeOnDisk(input.writtenPath)) ?? input.sizeBytes;
  const existing = await readLineageMeta(input.writtenPath);
  let parent = input.parentFilePath
    ? await readLineageMeta(input.parentFilePath)
    : null;
  if (
    input.parentFilePath &&
    !parent &&
    (await pathExists(input.parentFilePath))
  ) {
    const parentId = nanoid(12);
    parent = {
      formatDetails: inferFormatDetails(
        path.basename(input.parentFilePath),
        inferArtifactMimeType(path.basename(input.parentFilePath))
      ),
      id: parentId,
      mimeType: inferArtifactMimeType(path.basename(input.parentFilePath)),
      revision: 1,
      rootArtifactId: parentId,
      savedAt: new Date().toISOString(),
      sizeBytes: (await sizeOnDisk(input.parentFilePath)) ?? 0,
    };
    await writeFile(
      lineageMetaPath(input.parentFilePath),
      JSON.stringify(parent)
    );
  }

  const id = existing?.id ?? nanoid(12);
  const parentId = parent?.id;
  const rootId =
    parent?.rootArtifactId ?? parent?.id ?? existing?.rootArtifactId ?? id;
  const revision = parent
    ? (parent.revision ?? 1) + 1
    : (existing?.revision ?? 1);

  const meta: ArtifactLineageMeta = {
    formatDetails: inferFormatDetails(
      filename,
      mimeType,
      input.extraDetails ?? existing?.formatDetails ?? {}
    ),
    id,
    mimeType: existing?.mimeType ?? mimeType,
    parentArtifactId: parentId ?? existing?.parentArtifactId,
    revision,
    rootArtifactId: rootId,
    savedAt: new Date().toISOString(),
    sizeBytes,
  };

  const current = await readLineageMeta(input.writtenPath);
  const merged = current
    ? {
        ...meta,
        formatDetails: {
          ...meta.formatDetails,
          ...current.formatDetails,
        },
        mimeType: current.mimeType || meta.mimeType,
      }
    : meta;

  await writeFile(lineageMetaPath(input.writtenPath), JSON.stringify(merged), {
    encoding: "utf8",
    flag: "w",
  });

  return merged;
}

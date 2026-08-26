import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ensureDir, pathExists, writePrivateBytesFile } from "./fs";
import { getProfileArtifactsDir } from "./soul/resolve";

const MAX_INBOUND_FILENAME_ATTEMPTS = 1000;

export function sanitizeInboundDocumentFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop()?.trim() || "document";
  const sanitized = base.replace(/[^\w.\-() ]+/g, "_").trim();

  if (!sanitized || isReservedFilename(sanitized)) {
    return "document";
  }

  return sanitized;
}

export async function uniqueInboundDocumentFilename(
  directory: string,
  filename: string
): Promise<string> {
  const safeName = sanitizeInboundDocumentFilename(filename);
  const dot = safeName.lastIndexOf(".");
  const stem = dot > 0 ? safeName.slice(0, dot) : safeName;
  const ext = dot > 0 ? safeName.slice(dot) : "";
  let candidate = `${stem}${ext}`;
  let suffix = 2;

  for (let attempt = 0; attempt < MAX_INBOUND_FILENAME_ATTEMPTS; attempt++) {
    if (
      !(
        isReservedFilename(candidate) ||
        (await pathExists(join(directory, candidate)))
      )
    ) {
      return candidate;
    }

    candidate = `${stem}-${suffix}${ext}`;
    suffix += 1;
  }

  throw new Error("Could not allocate a unique inbound document filename.");
}

export async function saveInboundWorkspaceDocument(input: {
  bytes: Buffer;
  filename: string;
  orgId: string;
  profileId: string;
}): Promise<{ relativePath: string; sizeBytes: number }> {
  const artifactsDir = resolve(
    getProfileArtifactsDir(input.orgId, input.profileId)
  );
  await ensureDir(artifactsDir);
  const uniqueName = await uniqueInboundDocumentFilename(
    artifactsDir,
    input.filename
  );
  const destination = resolve(artifactsDir, uniqueName);
  if (!isPathInsideDirectory(destination, artifactsDir)) {
    throw new Error("Refusing to write inbound document outside artifacts.");
  }

  await writePrivateBytesFile(destination, input.bytes);

  return {
    relativePath: `artifacts/${uniqueName}`,
    sizeBytes: input.bytes.byteLength,
  };
}

function isReservedFilename(name: string): boolean {
  return name === "." || name === "..";
}

function isPathInsideDirectory(
  targetPath: string,
  directoryPath: string
): boolean {
  const rel = relative(directoryPath, targetPath);
  return (
    Boolean(rel) &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

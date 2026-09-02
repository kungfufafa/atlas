import { constants } from "node:fs";
import { lstat, open, readdir, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ensureDir, PRIVATE_FILE_MODE, pathExists } from "./fs";
import { withProfileSoulMutationLock } from "./soul/mutation-lock";
import { getProfileArtifactsDir } from "./soul/resolve";

const MAX_INBOUND_FILENAME_ATTEMPTS = 1000;
export const MAX_INBOUND_ARTIFACT_STORAGE_BYTES = 250 * 1024 * 1024;
const NO_FOLLOW_FLAG = constants.O_NOFOLLOW ?? 0;

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
  maxStoredBytes?: number;
  orgId: string;
  profileId: string;
}): Promise<{ relativePath: string; sizeBytes: number }> {
  return withProfileSoulMutationLock(input.orgId, input.profileId, async () => {
    const artifactsDir = resolve(
      getProfileArtifactsDir(input.orgId, input.profileId)
    );
    await ensureDir(artifactsDir);
    const artifactsStat = await lstat(artifactsDir);
    if (!artifactsStat.isDirectory() || artifactsStat.isSymbolicLink()) {
      throw new Error("Profile artifacts path must be a real directory.");
    }
    const maxStoredBytes =
      input.maxStoredBytes ?? MAX_INBOUND_ARTIFACT_STORAGE_BYTES;
    if (!(Number.isFinite(maxStoredBytes) && maxStoredBytes > 0)) {
      throw new Error("Inbound document storage limit must be positive.");
    }

    const storedBytes = await getDirectorySizeBytes(artifactsDir);
    if (storedBytes + input.bytes.byteLength > maxStoredBytes) {
      throw new Error("Inbound document storage quota exceeded.");
    }

    const uniqueName = await writeUniqueInboundDocument({
      bytes: input.bytes,
      directory: artifactsDir,
      filename: input.filename,
    });

    return {
      relativePath: `artifacts/${uniqueName}`,
      sizeBytes: input.bytes.byteLength,
    };
  });
}

async function writeUniqueInboundDocument(input: {
  bytes: Buffer;
  directory: string;
  filename: string;
}): Promise<string> {
  for (let attempt = 0; attempt < MAX_INBOUND_FILENAME_ATTEMPTS; attempt++) {
    const uniqueName = await uniqueInboundDocumentFilename(
      input.directory,
      input.filename
    );
    const destination = resolve(input.directory, uniqueName);
    if (!isPathInsideDirectory(destination, input.directory)) {
      throw new Error("Refusing to write inbound document outside artifacts.");
    }

    let handle;
    try {
      handle = await open(
        destination,
        // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags are bitmasks.
        constants.O_CREAT |
          constants.O_EXCL |
          NO_FOLLOW_FLAG |
          constants.O_WRONLY,
        PRIVATE_FILE_MODE
      );
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        continue;
      }
      throw error;
    }

    try {
      await handle.writeFile(input.bytes);
      await handle.chmod(PRIVATE_FILE_MODE);
      return uniqueName;
    } catch (error) {
      await unlink(destination).catch(() => undefined);
      throw error;
    } finally {
      await handle.close();
    }
  }

  throw new Error("Could not allocate a unique inbound document filename.");
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

async function getDirectorySizeBytes(directory: string): Promise<number> {
  let totalBytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      totalBytes += await getDirectorySizeBytes(path);
    } else if (entry.isFile()) {
      totalBytes += (await stat(path)).size;
    }
  }
  return totalBytes;
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

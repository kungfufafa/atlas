import { constants } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  ATLAS_API_VERSION,
  AtlasApiError,
  type DataExportManifest,
  type DataExportSkippedItem,
  type DataImportPreviewResponse,
  getUserConfigDir,
  type RestoreDataImportResponse,
} from "@atlas/core";
import { unzipSync, zipSync } from "fflate";
import { subscriptionRuntimeHome } from "../providers/subscription/env";

export const ATLAS_EXPORT_MANIFEST = "atlas-export.json";
export const ATLAS_EXPORT_FORMAT_VERSION = 1;
export const MAX_ATLAS_IMPORT_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_ATLAS_IMPORT_REQUEST_BYTES =
  Math.ceil(MAX_ATLAS_IMPORT_ARCHIVE_BYTES / 3) * 4 + 1024;

export interface CreateDataExportOptions {
  databasePath?: string | null;
  now?: Date;
  rootDir?: string;
}

export interface CreateDataExportResult {
  data: Buffer;
  filename: string;
  manifest: DataExportManifest;
}

export interface PreviewDataImportOptions {
  rootDir?: string;
}

export interface RestoreDataImportOptions {
  /** Runs after commit while the canonical-root restore lock is still held. */
  afterRestore?: () => Promise<void>;
  confirm: boolean;
  rootDir?: string;
}

interface ZipEntry {
  data: Buffer;
  name: string;
  uncompressedSize: number;
}

interface InventoryItem {
  absolutePath: string;
  relativePath: string;
  size: number;
}

const RESTORE_PREFIX = ".atlas-restore-";
const BACKUP_PREFIX = ".atlas-backup-";
const SUBSCRIPTION_CREDENTIAL_DIRECTORIES = new Set([
  ".claude",
  ".codex",
  "subscription-auth",
]);
const SUBSCRIPTION_CREDENTIAL_EXPORT_REASON =
  "Subscription authentication credentials are excluded from exports.";
const MAX_ATLAS_IMPORT_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_ATLAS_IMPORT_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_ATLAS_IMPORT_ENTRIES = 10_000;
const BASE64_ARCHIVE_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const restoreMutationLocks = new Map<string, Promise<unknown>>();

export async function createAtlasDataExport(
  options: CreateDataExportOptions = {}
): Promise<CreateDataExportResult> {
  const rootDir = resolve(options.rootDir ?? getUserConfigDir());
  const createdAt = (options.now ?? new Date()).toISOString();
  const { files, skipped } = await inventoryConfigRoot(rootDir);
  const topLevelPaths = Array.from(
    new Set(
      files.map((file) => file.relativePath.split("/")[0]).filter(Boolean)
    )
  ).sort();
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

  if (options.databasePath) {
    const databasePath = resolve(options.databasePath);
    const relativeDatabasePath = relative(rootDir, databasePath);
    if (
      relativeDatabasePath.startsWith("..") ||
      isAbsolute(relativeDatabasePath)
    ) {
      skipped.push({
        path: databasePath,
        reason: "Database path is outside the Atlas root.",
      });
    }
  }

  const manifest: DataExportManifest = {
    apiVersion: ATLAS_API_VERSION,
    createdAt,
    fileCount: files.length,
    kind: "atlas-export",
    skipped,
    sourceRootName: basename(rootDir) || ".atlas",
    topLevelPaths,
    totalBytes,
    version: ATLAS_EXPORT_FORMAT_VERSION,
  };

  const entries: Record<string, Uint8Array> = {
    [ATLAS_EXPORT_MANIFEST]: Buffer.from(
      JSON.stringify(manifest, null, 2),
      "utf8"
    ),
  };

  for (const file of files) {
    validateArchivePath(file.relativePath);
    entries[file.relativePath] = await readFile(file.absolutePath);
  }

  return {
    data: Buffer.from(zipSync(entries)),
    filename: `atlas-export-${createdAt.replace(/[:.]/g, "-")}.zip`,
    manifest,
  };
}

export async function previewAtlasDataImport(
  archive: Buffer | Uint8Array | ArrayBuffer,
  options: PreviewDataImportOptions = {}
): Promise<DataImportPreviewResponse> {
  const rootDir = resolve(options.rootDir ?? getUserConfigDir());
  const entries = readZip(
    toBuffer(archive),
    await subscriptionCredentialDirectories(rootDir)
  );
  const manifest = readManifest(entries);
  const restorableEntries = entries.filter(
    (entry) => entry.name !== ATLAS_EXPORT_MANIFEST
  );

  return {
    archiveFileCount: restorableEntries.length,
    archiveTotalBytes: restorableEntries.reduce(
      (sum, entry) => sum + entry.uncompressedSize,
      0
    ),
    manifest,
    topLevelPaths: Array.from(
      new Set(
        restorableEntries
          .map((entry) => entry.name.split("/")[0])
          .filter(Boolean)
      )
    ).sort(),
    willReplaceRoot: await pathExists(rootDir),
  };
}

export function decodeArchiveRequestData(data: string): Buffer {
  if (typeof data !== "string") {
    throw new AtlasApiError("Import archive data is required.", 400);
  }
  const trimmed = data.trim();
  if (!trimmed) {
    throw new AtlasApiError("Import archive data is required.", 400);
  }

  if (trimmed.length > MAX_ATLAS_IMPORT_REQUEST_BYTES) {
    throw new AtlasApiError("Import archive data is too large.", 413);
  }
  if (!BASE64_ARCHIVE_PATTERN.test(trimmed)) {
    throw new AtlasApiError(
      "Import archive data is invalid or too large.",
      400
    );
  }

  const archive = Buffer.from(trimmed, "base64");
  if (archive.length > MAX_ATLAS_IMPORT_ARCHIVE_BYTES) {
    throw new AtlasApiError(
      "Import archive exceeds the 64 MiB compressed limit.",
      413
    );
  }
  return archive;
}

export async function restoreAtlasDataImport(
  archive: Buffer | Uint8Array | ArrayBuffer,
  options: RestoreDataImportOptions
): Promise<RestoreDataImportResponse> {
  if (!options.confirm) {
    throw new AtlasApiError("Restore confirmation is required.", 400);
  }

  const rootDir = resolve(options.rootDir ?? getUserConfigDir());
  const canonicalRootDir = await canonicalizePotentialPath(rootDir);
  return runSerializedRestore(canonicalRootDir, async () => {
    const credentialDirectories = await subscriptionCredentialDirectories(
      rootDir,
      canonicalRootDir
    );
    const entries = readZip(toBuffer(archive), credentialDirectories);
    const manifest = readManifest(entries);

    // Stage and back up inside rootDir so Docker volume mounts (e.g. /atlas/data)
    // are never renamed — rename(2) on a mount point returns EBUSY.
    await mkdir(rootDir, { mode: 0o700, recursive: true });
    const stagingParent = await mkdtemp(join(rootDir, RESTORE_PREFIX));
    const stagedRoot = join(stagingParent, "root");
    const backupRoot = join(rootDir, `${BACKUP_PREFIX}${Date.now()}`);
    const backedUpEntries: string[] = [];
    let backupComplete = false;
    let restoreCommitted = false;

    try {
      await mkdir(stagedRoot, { mode: 0o700, recursive: true });
      let restoredFileCount = 0;

      for (const entry of entries) {
        if (entry.name === ATLAS_EXPORT_MANIFEST) {
          continue;
        }

        await writeRestoredEntry(stagedRoot, entry);
        restoredFileCount += 1;
      }

      const existingEntries = await listMovableTopLevelEntries(
        rootDir,
        credentialDirectories
      );
      if (existingEntries.length > 0) {
        await mkdir(backupRoot, { mode: 0o700, recursive: true });
        for (const name of existingEntries) {
          await movePath(join(rootDir, name), join(backupRoot, name));
          backedUpEntries.push(name);
        }
        backupComplete = true;
      } else {
        backupComplete = true;
      }

      for (const name of await readdir(stagedRoot)) {
        await movePath(join(stagedRoot, name), join(rootDir, name));
      }
      restoreCommitted = true;

      if (backedUpEntries.length > 0) {
        try {
          await rm(backupRoot, { force: true, recursive: true });
        } catch {
          // Restore already committed — leave an orphan backup rather than rolling back.
        }
      }

      const result = {
        manifest,
        restoredFileCount,
        restoredRoot: rootDir,
      };
      await options.afterRestore?.();
      return result;
    } catch (error) {
      if (
        !restoreCommitted &&
        backedUpEntries.length > 0 &&
        (await pathExists(backupRoot))
      ) {
        try {
          if (backupComplete) {
            for (const name of await listMovableTopLevelEntries(
              rootDir,
              credentialDirectories
            )) {
              await rm(join(rootDir, name), { force: true, recursive: true });
            }
            for (const name of backedUpEntries) {
              const from = join(backupRoot, name);
              if (await pathExists(from)) {
                await movePath(from, join(rootDir, name));
              }
            }
          } else {
            // Partial backup: only put back what we moved; never delete unbacked siblings.
            for (const name of backedUpEntries) {
              const live = join(rootDir, name);
              if (await pathExists(live)) {
                await rm(live, { force: true, recursive: true });
              }
              const from = join(backupRoot, name);
              if (await pathExists(from)) {
                await movePath(from, live);
              }
            }
          }
          await rm(backupRoot, { force: true, recursive: true });
        } catch {
          // Keep backupRoot for manual recovery if rollback itself fails.
        }
      }

      throw error;
    } finally {
      await rm(stagingParent, { force: true, recursive: true });
    }
  });
}

async function inventoryConfigRoot(rootDir: string): Promise<{
  files: InventoryItem[];
  skipped: DataExportSkippedItem[];
}> {
  const files: InventoryItem[] = [];
  const skipped: DataExportSkippedItem[] = [];
  const credentialDirectories =
    await subscriptionCredentialDirectories(rootDir);

  if (!(await pathExists(rootDir))) {
    return { files, skipped };
  }

  await walk(rootDir);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  skipped.sort((a, b) => a.path.localeCompare(b.path));
  return { files, skipped };

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = join(currentDir, entry.name);
      const relativePath = toZipPath(relative(rootDir, absolutePath));

      const skipReason = exportSkipReason(relativePath, credentialDirectories);
      if (skipReason) {
        skipped.push({
          path: relativePath,
          reason: skipReason,
        });
        continue;
      }

      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) {
        skipped.push({
          path: relativePath,
          reason: "Only regular files are exported.",
        });
        continue;
      }

      const stat = await lstat(absolutePath);
      files.push({ absolutePath, relativePath, size: stat.size });
    }
  }
}

async function writeRestoredEntry(
  rootDir: string,
  entry: ZipEntry
): Promise<void> {
  validateArchivePath(entry.name);
  const targetPath = resolve(rootDir, entry.name);
  const relativeTarget = relative(rootDir, targetPath);
  if (relativeTarget.startsWith("..") || isAbsolute(relativeTarget)) {
    throw new AtlasApiError(
      `Archive entry escapes restore root: ${entry.name}`,
      400
    );
  }

  await mkdir(dirname(targetPath), { mode: 0o700, recursive: true });
  await writeFile(targetPath, entry.data, { mode: 0o600 });
}

function readZip(
  buffer: Buffer,
  credentialDirectories: ReadonlySet<string>
): ZipEntry[] {
  if (buffer.length > MAX_ATLAS_IMPORT_ARCHIVE_BYTES) {
    throw new AtlasApiError(
      "Import archive exceeds the 64 MiB compressed limit.",
      413
    );
  }
  let entryCount = 0;
  let declaredExpandedBytes = 0;
  let actualExpandedBytes = 0;
  try {
    return Object.entries(
      unzipSync(buffer, {
        filter: (file) => {
          validateArchivePath(file.name, credentialDirectories);
          entryCount += 1;
          if (entryCount > MAX_ATLAS_IMPORT_ENTRIES) {
            throw new AtlasApiError(
              `Import archive exceeds the ${MAX_ATLAS_IMPORT_ENTRIES}-entry limit.`,
              413
            );
          }
          if (file.name.endsWith("/")) {
            return false;
          }
          if (file.originalSize > MAX_ATLAS_IMPORT_ENTRY_BYTES) {
            throw new AtlasApiError(
              `Import archive entry exceeds the 128 MiB limit: ${file.name}`,
              413
            );
          }
          declaredExpandedBytes += file.originalSize;
          if (declaredExpandedBytes > MAX_ATLAS_IMPORT_EXPANDED_BYTES) {
            throw new AtlasApiError(
              "Import archive exceeds the 256 MiB expanded limit.",
              413
            );
          }
          return true;
        },
      })
    )
      .filter(([name]) => !name.endsWith("/"))
      .map(([name, data]) => {
        validateArchivePath(name, credentialDirectories);
        actualExpandedBytes += data.byteLength;
        if (data.byteLength > MAX_ATLAS_IMPORT_ENTRY_BYTES) {
          throw new AtlasApiError(
            `Import archive entry exceeds the 128 MiB limit: ${name}`,
            413
          );
        }
        if (actualExpandedBytes > MAX_ATLAS_IMPORT_EXPANDED_BYTES) {
          throw new AtlasApiError(
            "Import archive exceeds the 256 MiB expanded limit.",
            413
          );
        }
        const entryData = Buffer.from(
          data.buffer,
          data.byteOffset,
          data.byteLength
        );
        return {
          data: entryData,
          name,
          uncompressedSize: entryData.length,
        };
      });
  } catch (error) {
    if (error instanceof AtlasApiError) {
      throw error;
    }
    throw new AtlasApiError("Invalid ZIP archive.", 400);
  }
}

function readManifest(entries: ZipEntry[]): DataExportManifest {
  const manifestEntry = entries.find(
    (entry) => entry.name === ATLAS_EXPORT_MANIFEST
  );
  if (!manifestEntry) {
    throw new AtlasApiError("Archive is missing Atlas export manifest.", 400);
  }

  let manifest: DataExportManifest;
  try {
    manifest = JSON.parse(
      manifestEntry.data.toString("utf8")
    ) as DataExportManifest;
  } catch {
    throw new AtlasApiError("Atlas export manifest is not valid JSON.", 400);
  }

  if (manifest.kind !== "atlas-export") {
    throw new AtlasApiError("Archive is not a Atlas export.", 400);
  }

  if (manifest.version !== ATLAS_EXPORT_FORMAT_VERSION) {
    throw new AtlasApiError(
      `Unsupported Atlas export version: ${manifest.version}`,
      400
    );
  }

  return manifest;
}

function validateArchivePath(
  path: string,
  credentialDirectories: ReadonlySet<string> = SUBSCRIPTION_CREDENTIAL_DIRECTORIES
): void {
  if (!path || path.includes("\0")) {
    throw new AtlasApiError("Archive entry path is empty or invalid.", 400);
  }

  if (path !== toZipPath(path)) {
    throw new AtlasApiError(
      `Archive entry must use POSIX separators: ${path}`,
      400
    );
  }

  if (isAbsolute(path) || /^[a-zA-Z]:/.test(path)) {
    throw new AtlasApiError(`Archive entry must be relative: ${path}`, 400);
  }

  const normalized = normalize(path).split(sep).join("/");
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new AtlasApiError(`Archive entry escapes restore root: ${path}`, 400);
  }

  const first = normalized.split("/")[0] ?? "";
  if (first.startsWith(RESTORE_PREFIX) || first.startsWith(BACKUP_PREFIX)) {
    throw new AtlasApiError(
      `Archive entry uses a reserved restore path: ${path}`,
      400
    );
  }
  if (isSubscriptionCredentialDirectory(first, credentialDirectories)) {
    throw new AtlasApiError(
      `Archive entry uses a protected subscription credential path: ${path}`,
      400
    );
  }
}

function toZipPath(path: string): string {
  return path.split(sep).join("/");
}

function exportSkipReason(
  path: string,
  credentialDirectories: ReadonlySet<string>
): string | null {
  const first = path.split("/")[0] ?? "";
  if (isSubscriptionCredentialDirectory(first, credentialDirectories)) {
    return SUBSCRIPTION_CREDENTIAL_EXPORT_REASON;
  }
  if (
    first === ATLAS_EXPORT_MANIFEST ||
    first.startsWith(RESTORE_PREFIX) ||
    first.startsWith(BACKUP_PREFIX)
  ) {
    return "Internal data-portability temporary path.";
  }
  return null;
}

function isSubscriptionCredentialDirectory(
  name: string,
  credentialDirectories: ReadonlySet<string> = SUBSCRIPTION_CREDENTIAL_DIRECTORIES
): boolean {
  return (
    credentialDirectories.has("*") ||
    credentialDirectories.has(name.toLowerCase())
  );
}

function toBuffer(value: Buffer | Uint8Array | ArrayBuffer): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return Buffer.from(value);
  }

  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function listMovableTopLevelEntries(
  rootDir: string,
  credentialDirectories: ReadonlySet<string>
): Promise<string[]> {
  const entries = await readdir(rootDir);
  return entries.filter(
    (name) =>
      !(
        name.startsWith(RESTORE_PREFIX) ||
        name.startsWith(BACKUP_PREFIX) ||
        isSubscriptionCredentialDirectory(name, credentialDirectories)
      )
  );
}

async function subscriptionCredentialDirectories(
  rootDir: string,
  canonicalRootDir?: string
): Promise<Set<string>> {
  const resolvedRootDir = resolve(rootDir);
  const resolvedCanonicalRootDir =
    canonicalRootDir ?? (await canonicalizePotentialPath(rootDir));
  const directories = new Set(SUBSCRIPTION_CREDENTIAL_DIRECTORIES);
  const canonicalCredentialHomes: string[] = [];
  for (const kind of ["chatgpt", "claude"] as const) {
    const configuredCredentialHome = resolve(subscriptionRuntimeHome(kind));
    const canonicalCredentialHome = await canonicalizePotentialPath(
      configuredCredentialHome
    );
    canonicalCredentialHomes.push(canonicalCredentialHome);
    addProtectedTopLevelDirectory(
      directories,
      resolvedRootDir,
      configuredCredentialHome
    );
    addProtectedTopLevelDirectory(
      directories,
      resolvedCanonicalRootDir,
      canonicalCredentialHome
    );
  }

  if (await pathExists(rootDir)) {
    const entries = await readdir(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!(entry.isDirectory() || entry.isSymbolicLink())) {
        continue;
      }
      const canonicalEntry = await canonicalizePotentialPath(
        join(rootDir, entry.name)
      );
      if (
        canonicalCredentialHomes.some(
          (credentialHome) =>
            isPathInside(canonicalEntry, credentialHome) ||
            isPathInside(credentialHome, canonicalEntry)
        )
      ) {
        directories.add(entry.name.toLowerCase());
      }
    }
  }
  return directories;
}

function addProtectedTopLevelDirectory(
  directories: Set<string>,
  rootDir: string,
  credentialHome: string
): void {
  const relativeHome = relative(rootDir, credentialHome);
  if (!relativeHome) {
    directories.add("*");
    return;
  }
  if (relativeHome.startsWith("..") || isAbsolute(relativeHome)) {
    return;
  }
  const first = toZipPath(relativeHome).split("/")[0];
  if (first) {
    directories.add(first.toLowerCase());
  }
}

function isPathInside(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return !(
    relativePath &&
    (relativePath.startsWith("..") || isAbsolute(relativePath))
  );
}

async function canonicalizePotentialPath(path: string): Promise<string> {
  let candidate = resolve(path);
  const missingSegments: string[] = [];

  while (true) {
    try {
      const canonicalParent = await realpath(candidate);
      return resolve(canonicalParent, ...missingSegments.reverse());
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
      const parent = dirname(candidate);
      if (parent === candidate) {
        return resolve(path);
      }
      missingSegments.push(basename(candidate));
      candidate = parent;
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  if (!(error && typeof error === "object" && "code" in error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function runSerializedRestore<T>(
  canonicalRootDir: string,
  restore: () => Promise<T>
): Promise<T> {
  const previous =
    restoreMutationLocks.get(canonicalRootDir) ?? Promise.resolve();
  const next = previous.then(restore, restore);
  const tail = next.then(
    () => undefined,
    () => undefined
  );
  restoreMutationLocks.set(canonicalRootDir, tail);
  void tail.then(() => {
    if (restoreMutationLocks.get(canonicalRootDir) === tail) {
      restoreMutationLocks.delete(canonicalRootDir);
    }
  });
  return next;
}

async function movePath(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if (!isRetryableMoveError(error)) {
      throw error;
    }

    await cp(from, to, { force: true, recursive: true });
    await rm(from, { force: true, recursive: true });
  }
}

function isRetryableMoveError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }

  const code = (error as { code?: unknown }).code;
  return code === "EBUSY" || code === "EXDEV" || code === "EPERM";
}

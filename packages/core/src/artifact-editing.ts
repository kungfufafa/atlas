import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { AtlasApiError } from "./api-error";
import {
  ARTIFACT_EDIT_MAX_CELL_BYTES,
  ARTIFACT_EDIT_MAX_COLUMNS,
  ARTIFACT_EDIT_MAX_FILE_BYTES,
  ARTIFACT_EDIT_MAX_ROWS,
} from "./artifact-editing-limits";
import { resolveProfileArtifactsRoot } from "./artifact-root";
import type {
  EditableArtifactKind,
  EditableArtifactResponse,
  UpdateEditableArtifactRequest,
} from "./contract";
import {
  DelimitedTextParseError,
  type ParsedDelimitedText,
  parseDelimitedText as parseBoundedDelimitedText,
} from "./delimited-text";
import { guardFilePath } from "./tools/paths";

export {
  ARTIFACT_EDIT_MAX_CELL_BYTES,
  ARTIFACT_EDIT_MAX_COLUMNS,
  ARTIFACT_EDIT_MAX_FILE_BYTES,
  ARTIFACT_EDIT_MAX_ROWS,
} from "./artifact-editing-limits";

const ARTIFACT_META_SUFFIX = ".atlas-meta.json";
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const HIGH_SURROGATE_START = 55_296;
const HIGH_SURROGATE_END = 56_319;
const LOW_SURROGATE_START = 56_320;
const LOW_SURROGATE_END = 57_343;
const LOCK_MAX_BYTES = 4096;
const LOCK_RETRY_MS = 25;
const LOCK_STALE_MS = 5 * 60 * 1000;
const LOCK_WAIT_MS = 5000;
const READ_CHUNK_BYTES = 64 * 1024;
const SUPPORTED_MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const SUPPORTED_DELIMITED_EXTENSIONS = new Set([".csv", ".tsv"]);

interface ArtifactSnapshot {
  bytes: Buffer;
  expectedHash: string;
  sizeBytes: number;
  truncated: boolean;
}

export interface ArtifactEditAtomicHooks {
  /** @internal Tests may pause after the last hash comparison. */
  afterCompare?: () => Promise<void>;
  /** @internal Tests may replace rename to prove rollback behavior. */
  renameFile?: typeof rename;
}

export async function readEditableArtifact(input: {
  filename: string;
  orgId: string;
  profileId: string;
}): Promise<EditableArtifactResponse> {
  const target = await resolveEditableArtifactTarget(input);
  const snapshot = await readArtifactSnapshot(target.filePath);
  const text = decodeUtf8(snapshot.bytes, snapshot.truncated);

  if (target.kind === "markdown") {
    return {
      content: text,
      editable: !snapshot.truncated,
      expectedHash: snapshot.expectedHash,
      filename: path.basename(target.filePath),
      kind: target.kind,
      path: target.relativePath,
      reason: snapshot.truncated
        ? `Files larger than ${formatByteLimit(ARTIFACT_EDIT_MAX_FILE_BYTES)} cannot be edited in the dashboard.`
        : undefined,
      sizeBytes: snapshot.sizeBytes,
      truncated: snapshot.truncated,
    };
  }

  const parsed = parseDelimitedText(text, target.extension, {
    allowIncompleteFinalRecord: snapshot.truncated,
  });
  const truncated = snapshot.truncated || parsed.truncated;

  return {
    columnCount: parsed.columnCount,
    delimiter: parsed.delimiter,
    editable: !truncated,
    expectedHash: snapshot.expectedHash,
    filename: path.basename(target.filePath),
    kind: target.kind,
    path: target.relativePath,
    reason: editableArtifactLimitReason(snapshot, parsed),
    rowCount: parsed.rowCount,
    rows: parsed.rows,
    sizeBytes: snapshot.sizeBytes,
    truncated,
  };
}

export async function writeEditableArtifact(
  input: {
    filename: string;
    orgId: string;
    profileId: string;
    request: UpdateEditableArtifactRequest;
  },
  hooks: ArtifactEditAtomicHooks = {}
): Promise<EditableArtifactResponse> {
  const target = await resolveEditableArtifactTarget(input);

  return withArtifactFilesystemLock(target.filePath, async (lock) => {
    await assertArtifactFilesystemLockOwned(lock);
    const current = await readArtifactSnapshot(target.filePath);
    assertExpectedHash(input.request.expectedHash, current.expectedHash);

    if (current.truncated) {
      throw new AtlasApiError(
        `Files larger than ${formatByteLimit(ARTIFACT_EDIT_MAX_FILE_BYTES)} cannot be edited in the dashboard.`,
        413
      );
    }

    const currentText = decodeUtf8(current.bytes, false);
    const nextBytes = buildUpdatedArtifactBytes({
      currentText,
      extension: target.extension,
      kind: target.kind,
      request: input.request,
    });

    await atomicReplaceArtifact({
      afterCompare: hooks.afterCompare,
      current,
      filePath: target.filePath,
      lock,
      nextBytes,
      renameFile: hooks.renameFile ?? rename,
    });

    return readEditableArtifact(input);
  });
}

function editableArtifactLimitReason(
  snapshot: ArtifactSnapshot,
  parsed: ParsedDelimitedText
): string | undefined {
  if (snapshot.truncated) {
    return `Files larger than ${formatByteLimit(ARTIFACT_EDIT_MAX_FILE_BYTES)} cannot be edited in the dashboard.`;
  }
  if (parsed.rowCount > ARTIFACT_EDIT_MAX_ROWS) {
    return `Tables with more than ${ARTIFACT_EDIT_MAX_ROWS} rows cannot be edited in the dashboard.`;
  }
  if (parsed.columnCount > ARTIFACT_EDIT_MAX_COLUMNS) {
    return `Tables with more than ${ARTIFACT_EDIT_MAX_COLUMNS} columns cannot be edited in the dashboard.`;
  }
}

function formatByteLimit(bytes: number): string {
  return `${bytes / (1024 * 1024)} MB`;
}

async function resolveEditableArtifactTarget(input: {
  filename: string;
  orgId: string;
  profileId: string;
}): Promise<{
  extension: ".csv" | ".markdown" | ".md" | ".tsv";
  filePath: string;
  kind: EditableArtifactKind;
  relativePath: string;
}> {
  const filename = input.filename;
  if (
    !filename.trim() ||
    path.isAbsolute(filename) ||
    filename.includes("\\")
  ) {
    throw new AtlasApiError("Artifact path must stay inside artifacts/.", 400);
  }

  const extension = path.extname(filename).toLowerCase();
  const isMarkdown = SUPPORTED_MARKDOWN_EXTENSIONS.has(extension);
  const isDelimited = SUPPORTED_DELIMITED_EXTENSIONS.has(extension);
  if (!(isMarkdown || isDelimited)) {
    throw new AtlasApiError(
      "Only Markdown, CSV, and TSV artifacts can be edited in the dashboard.",
      400
    );
  }

  let resolvedArtifactsDir: string;
  try {
    resolvedArtifactsDir = await resolveProfileArtifactsRoot(
      input.orgId,
      input.profileId
    );
  } catch (error) {
    if (error instanceof AtlasApiError && error.status === 400) {
      throw error;
    }
    throw new AtlasApiError(`Artifact not found: ${filename}`, 404);
  }

  const lexicalPath = path.resolve(resolvedArtifactsDir, filename);
  const relativePath = path.relative(resolvedArtifactsDir, lexicalPath);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new AtlasApiError("Artifact path must stay inside artifacts/.", 400);
  }

  try {
    const guarded = await guardFilePath(filename, null, undefined, {
      allowedDirs: [resolvedArtifactsDir],
      cwd: resolvedArtifactsDir,
    });
    if (guarded.resolved !== lexicalPath) {
      throw new AtlasApiError("Symbolic-link artifacts cannot be edited.", 400);
    }

    await assertNoSymlinkComponents(resolvedArtifactsDir, relativePath);
    const fileStat = await lstat(lexicalPath);
    if (!fileStat.isFile()) {
      throw new AtlasApiError(`Artifact not found: ${filename}`, 404);
    }
  } catch (error) {
    if (error instanceof AtlasApiError) {
      throw error;
    }
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      throw new AtlasApiError(`Artifact not found: ${filename}`, 404);
    }
    throw new AtlasApiError("Artifact path must stay inside artifacts/.", 400);
  }

  return {
    extension: extension as ".csv" | ".markdown" | ".md" | ".tsv",
    filePath: lexicalPath,
    kind: isMarkdown ? "markdown" : "delimited",
    relativePath: relativePath.split(path.sep).join("/"),
  };
}

async function assertNoSymlinkComponents(
  root: string,
  relativePath: string
): Promise<void> {
  let current = root;
  for (const segment of relativePath.split(path.sep)) {
    current = path.join(current, segment);
    const currentStat = await lstat(current);
    if (currentStat.isSymbolicLink()) {
      throw new AtlasApiError("Symbolic-link artifacts cannot be edited.", 400);
    }
  }
}

async function readArtifactSnapshot(
  filePath: string
): Promise<ArtifactSnapshot> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // O_NOFOLLOW is intentionally combined with the read flag so a final-path
    // symlink swap cannot race the earlier lstat checks.
    const readWithoutFollowing =
      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags are bitmasks.
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    handle = await open(filePath, readWithoutFollowing);
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new AtlasApiError("Artifact is not a regular file.", 400);
    }
    await assertOpenHandleMatchesPath(filePath, before);

    const hash = createHash("sha256");
    const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
    const chunks: Buffer[] = [];
    let capturedBytes = 0;
    let position = 0;
    let invalidUtf8 = false;

    while (true) {
      const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position
      );
      if (bytesRead === 0) {
        break;
      }

      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (!invalidUtf8) {
        try {
          utf8Decoder.decode(chunk, { stream: true });
        } catch {
          invalidUtf8 = true;
        }
      }

      const remaining = ARTIFACT_EDIT_MAX_FILE_BYTES - capturedBytes;
      if (remaining > 0) {
        const captured = chunk.subarray(0, Math.min(remaining, chunk.length));
        chunks.push(Buffer.from(captured));
        capturedBytes += captured.length;
      }
      position += bytesRead;
    }

    if (!invalidUtf8) {
      try {
        utf8Decoder.decode();
      } catch {
        invalidUtf8 = true;
      }
    }
    if (invalidUtf8) {
      throw new AtlasApiError(
        "Artifact is not valid UTF-8 text and cannot be edited.",
        422
      );
    }

    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      position !== after.size
    ) {
      throw new AtlasApiError(
        "Artifact changed while it was being read. Reload and try again.",
        409
      );
    }
    await assertOpenHandleMatchesPath(filePath, after);

    return {
      bytes: Buffer.concat(chunks),
      expectedHash: hash.digest("hex"),
      sizeBytes: after.size,
      truncated: after.size > ARTIFACT_EDIT_MAX_FILE_BYTES,
    };
  } catch (error) {
    if (error instanceof AtlasApiError) {
      throw error;
    }
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      throw new AtlasApiError("Artifact not found.", 404);
    }
    if (code === "ELOOP") {
      throw new AtlasApiError("Symbolic-link artifacts cannot be edited.", 400);
    }
    throw new AtlasApiError("Failed to read editable artifact.", 500);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertOpenHandleMatchesPath(
  filePath: string,
  openedStat: Stats
): Promise<void> {
  const [resolvedPath, currentStat] = await Promise.all([
    realpath(filePath),
    lstat(filePath),
  ]);
  if (
    resolvedPath !== filePath ||
    currentStat.isSymbolicLink() ||
    !currentStat.isFile() ||
    currentStat.dev !== openedStat.dev ||
    currentStat.ino !== openedStat.ino
  ) {
    throw new AtlasApiError(
      "Artifact changed while it was being read. Reload and try again.",
      409
    );
  }
}

function decodeUtf8(bytes: Buffer, truncated: boolean): string {
  if (!truncated) {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }

  for (let trim = 0; trim <= 3 && trim <= bytes.length; trim += 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        trim === 0 ? bytes : bytes.subarray(0, -trim)
      );
    } catch {
      // A multibyte code point may cross the bounded preview boundary.
    }
  }
  throw new AtlasApiError(
    "Artifact is not valid UTF-8 text and cannot be edited.",
    422
  );
}

function parseDelimitedText(
  text: string,
  extension: string,
  options: { allowIncompleteFinalRecord: boolean }
): ParsedDelimitedText {
  try {
    return parseBoundedDelimitedText(text, {
      allowIncompleteFinalRecord: options.allowIncompleteFinalRecord,
      delimiter: extension === ".tsv" ? "\t" : undefined,
      maxCellBytes: ARTIFACT_EDIT_MAX_CELL_BYTES,
      maxColumns: ARTIFACT_EDIT_MAX_COLUMNS,
      maxRows: ARTIFACT_EDIT_MAX_ROWS,
    });
  } catch (error) {
    if (error instanceof DelimitedTextParseError) {
      throw new AtlasApiError(
        "Artifact contains malformed delimited text and cannot be edited.",
        422
      );
    }
    throw error;
  }
}

function buildUpdatedArtifactBytes(input: {
  currentText: string;
  extension: string;
  kind: EditableArtifactKind;
  request: UpdateEditableArtifactRequest;
}): Buffer {
  if (input.kind === "markdown") {
    if (typeof input.request.content !== "string" || input.request.rows) {
      throw new AtlasApiError("Markdown edits require content.", 400);
    }
    assertWellFormedText(input.request.content);
    return assertEditableSize(Buffer.from(input.request.content, "utf8"));
  }

  if (
    !Array.isArray(input.request.rows) ||
    input.request.content !== undefined
  ) {
    throw new AtlasApiError("CSV and TSV edits require rows.", 400);
  }
  const parsed = parseDelimitedText(input.currentText, input.extension, {
    allowIncompleteFinalRecord: false,
  });
  if (parsed.truncated) {
    throw new AtlasApiError(
      "This table exceeds the dashboard editing limits.",
      413
    );
  }
  const rows = validateAndNeutralizeRows(input.request.rows, parsed.rows);
  const serialized = serializeDelimitedRows(rows, parsed);
  return assertEditableSize(Buffer.from(serialized, "utf8"));
}

function assertWellFormedText(content: string): void {
  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index);
    if (code >= HIGH_SURROGATE_START && code <= HIGH_SURROGATE_END) {
      const next = content.charCodeAt(index + 1);
      if (next < LOW_SURROGATE_START || next > LOW_SURROGATE_END) {
        throw new AtlasApiError("Content must be valid Unicode text.", 422);
      }
      index += 1;
    } else if (code >= LOW_SURROGATE_START && code <= LOW_SURROGATE_END) {
      throw new AtlasApiError("Content must be valid Unicode text.", 422);
    }
  }
}

function assertEditableSize(bytes: Buffer): Buffer {
  if (bytes.length > ARTIFACT_EDIT_MAX_FILE_BYTES) {
    throw new AtlasApiError(
      `Edited content exceeds the ${formatByteLimit(ARTIFACT_EDIT_MAX_FILE_BYTES)} limit.`,
      413
    );
  }
  return bytes;
}

function validateAndNeutralizeRows(
  rows: unknown[][],
  originalRows: string[][]
): string[][] {
  if (rows.length > ARTIFACT_EDIT_MAX_ROWS) {
    throw new AtlasApiError(
      `Tables are limited to ${ARTIFACT_EDIT_MAX_ROWS} rows.`,
      413
    );
  }

  return rows.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length > ARTIFACT_EDIT_MAX_COLUMNS) {
      throw new AtlasApiError(
        `Tables are limited to ${ARTIFACT_EDIT_MAX_COLUMNS} columns.`,
        413
      );
    }
    return row.map((cell, columnIndex) => {
      if (typeof cell !== "string") {
        throw new AtlasApiError("Every table cell must be text.", 400);
      }
      assertWellFormedText(cell);
      if (Buffer.byteLength(cell, "utf8") > ARTIFACT_EDIT_MAX_CELL_BYTES) {
        throw new AtlasApiError(
          `Each table cell is limited to ${formatByteLimit(ARTIFACT_EDIT_MAX_CELL_BYTES)}.`,
          413
        );
      }
      return cell === originalRows[rowIndex]?.[columnIndex]
        ? cell
        : neutralizeSpreadsheetFormula(cell);
    });
  });
}

export function neutralizeSpreadsheetFormula(value: string): string {
  return /^[\u0000-\u0020\u00a0\ufeff]*[=+\-@]/.test(value)
    ? `'${value}`
    : value;
}

function serializeDelimitedRows(
  rows: string[][],
  source: Pick<
    ParsedDelimitedText,
    "delimiter" | "lineEnding" | "trailingNewline"
  >
): string {
  const serialized = rows
    .map((row) =>
      row
        .map((cell) => quoteDelimitedCell(cell, source.delimiter))
        .join(source.delimiter)
    )
    .join(source.lineEnding);
  return source.trailingNewline && rows.length > 0
    ? `${serialized}${source.lineEnding}`
    : serialized;
}

function quoteDelimitedCell(cell: string, delimiter: string): string {
  if (
    cell.includes('"') ||
    cell.includes(delimiter) ||
    cell.includes("\n") ||
    cell.includes("\r") ||
    cell.trim() !== cell
  ) {
    return `"${cell.replaceAll('"', '""')}"`;
  }
  return cell;
}

function assertExpectedHash(expectedHash: string, actualHash: string): void {
  if (!(HASH_PATTERN.test(expectedHash) && expectedHash === actualHash)) {
    throw new AtlasApiError(
      "Artifact changed since editing began. Reload it before saving.",
      409
    );
  }
}

async function atomicReplaceArtifact(input: {
  afterCompare?: () => Promise<void>;
  current: ArtifactSnapshot;
  filePath: string;
  lock: ArtifactFilesystemLock;
  nextBytes: Buffer;
  renameFile: typeof rename;
}): Promise<void> {
  const directory = path.dirname(input.filePath);
  const basename = path.basename(input.filePath);
  const nonce = randomUUID();
  const nextPath = path.join(directory, `.${basename}.atlas-edit-${nonce}.tmp`);
  const rollbackPath = path.join(
    directory,
    `.${basename}.atlas-edit-${nonce}.rollback`
  );
  const metadataPath = `${input.filePath}${ARTIFACT_META_SUFFIX}`;
  const metadataTempPath = `${metadataPath}.atlas-edit-${nonce}.tmp`;
  let hasMetadataTemp = false;

  try {
    await assertSafeAtomicDirectory(directory);
    await writePrivateFile(nextPath, input.nextBytes);
    await writePrivateFile(rollbackPath, input.current.bytes);
    hasMetadataTemp = await prepareMetadataUpdate(
      metadataPath,
      metadataTempPath,
      input.nextBytes.length
    );

    const latest = await readArtifactSnapshot(input.filePath);
    assertExpectedHash(input.current.expectedHash, latest.expectedHash);
    await input.afterCompare?.();
    await assertArtifactFilesystemLockOwned(input.lock);
    await assertSafeAtomicDirectory(directory);

    await input.renameFile(nextPath, input.filePath);
    if (hasMetadataTemp) {
      try {
        await input.renameFile(metadataTempPath, metadataPath);
      } catch (error) {
        await rename(rollbackPath, input.filePath).catch(() => {
          throw new AtlasApiError(
            "Artifact metadata failed to save and the content rollback also failed.",
            500
          );
        });
        throw error;
      }
    }

    await syncDirectory(directory);
  } catch (error) {
    if (error instanceof AtlasApiError) {
      throw error;
    }
    throw new AtlasApiError("Failed to save artifact.", 500);
  } finally {
    await Promise.all([
      unlink(nextPath).catch(() => undefined),
      unlink(metadataTempPath).catch(() => undefined),
      unlink(rollbackPath).catch(() => undefined),
    ]);
  }
}

async function assertSafeAtomicDirectory(directory: string): Promise<void> {
  const [resolvedDirectory, directoryStat] = await Promise.all([
    realpath(directory),
    lstat(directory),
  ]);
  if (
    resolvedDirectory !== directory ||
    directoryStat.isSymbolicLink() ||
    !directoryStat.isDirectory()
  ) {
    throw new AtlasApiError(
      "Symbolic-link artifact directories cannot be edited.",
      400
    );
  }
}

async function writePrivateFile(
  filePath: string,
  bytes: Buffer
): Promise<void> {
  const handle = await open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function prepareMetadataUpdate(
  metadataPath: string,
  tempPath: string,
  sizeBytes: number
): Promise<boolean> {
  try {
    const metadataStat = await lstat(metadataPath);
    if (metadataStat.isSymbolicLink() || !metadataStat.isFile()) {
      throw new AtlasApiError("Artifact metadata is not a regular file.", 400);
    }
    if (metadataStat.size > ARTIFACT_EDIT_MAX_FILE_BYTES) {
      throw new AtlasApiError("Artifact metadata is too large to update.", 400);
    }

    const readWithoutFollowing =
      // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags are bitmasks.
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
    const metadataHandle = await open(metadataPath, readWithoutFollowing);
    let raw: string;
    try {
      raw = await metadataHandle.readFile("utf8");
    } finally {
      await metadataHandle.close();
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!(parsed && typeof parsed === "object" && !Array.isArray(parsed))) {
      throw new AtlasApiError("Artifact metadata is invalid.", 400);
    }
    const updated = {
      ...(parsed as Record<string, unknown>),
      savedAt: new Date().toISOString(),
      sizeBytes,
    };
    await writePrivateFile(
      tempPath,
      Buffer.from(`${JSON.stringify(updated, null, 2)}\n`, "utf8")
    );
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return false;
    }
    if (error instanceof AtlasApiError) {
      throw error;
    }
    throw new AtlasApiError("Artifact metadata is invalid.", 400);
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY).catch(() => null);
  if (!handle) {
    return;
  }
  try {
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function withArtifactFilesystemLock<T>(
  filePath: string,
  operation: (lock: ArtifactFilesystemLock) => Promise<T>
): Promise<T> {
  const lock = await acquireArtifactFilesystemLock(filePath);

  try {
    return await operation(lock);
  } finally {
    await releaseArtifactFilesystemLock(lock);
  }
}

interface ArtifactFilesystemLock {
  fileHandle: Awaited<ReturnType<typeof open>>;
  fileStat: Stats;
  path: string;
}

async function acquireArtifactFilesystemLock(
  filePath: string
): Promise<ArtifactFilesystemLock> {
  const basename = path.basename(filePath);
  await assertSafeAtomicDirectory(path.dirname(filePath));
  const lockPath = path.join(
    path.dirname(filePath),
    `.${basename}.atlas-meta-edit.lock`
  );
  const deadline = Date.now() + LOCK_WAIT_MS;

  while (true) {
    let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      fileHandle = await open(lockPath, "wx", 0o600);
      await fileHandle.writeFile(
        `${JSON.stringify({ createdAt: new Date().toISOString(), pid: process.pid })}\n`,
        "utf8"
      );
      await fileHandle.sync();
      return {
        fileHandle,
        fileStat: await fileHandle.stat(),
        path: lockPath,
      };
    } catch (error) {
      await fileHandle?.close().catch(() => undefined);
      if ((error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST") {
        if (fileHandle) {
          await unlink(lockPath).catch(() => undefined);
        }
        throw new AtlasApiError("Failed to lock artifact for saving.", 500);
      }

      if (await reclaimStaleArtifactLock(lockPath)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new AtlasApiError(
          "Artifact is currently being saved. Try again shortly.",
          409
        );
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, LOCK_RETRY_MS);
      });
    }
  }
}

async function reclaimStaleArtifactLock(lockPath: string): Promise<boolean> {
  let initial: Stats;
  try {
    initial = await lstat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return true;
    }
    throw new AtlasApiError("Failed to inspect artifact save lock.", 500);
  }

  if (initial.isSymbolicLink() || !initial.isFile()) {
    throw new AtlasApiError("Artifact save lock is not a regular file.", 400);
  }

  const ageMs = Date.now() - initial.mtimeMs;
  let ownerState: "alive" | "dead" | "unknown" = "unknown";
  if (initial.size <= LOCK_MAX_BYTES) {
    try {
      const readWithoutFollowing =
        // biome-ignore lint/suspicious/noBitwiseOperators: POSIX open flags are bitmasks.
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
      const handle = await open(lockPath, readWithoutFollowing);
      try {
        const parsed = JSON.parse(await handle.readFile("utf8")) as {
          pid?: unknown;
        };
        if (
          typeof parsed.pid === "number" &&
          Number.isInteger(parsed.pid) &&
          parsed.pid > 0
        ) {
          ownerState = isProcessAlive(parsed.pid) ? "alive" : "dead";
        }
      } finally {
        await handle.close();
      }
    } catch {
      // A newly created lock can briefly be empty; age still handles abandoned locks.
    }
  }

  if (
    ownerState === "alive" ||
    (ownerState === "unknown" && ageMs < LOCK_STALE_MS)
  ) {
    return false;
  }

  const current = await lstat(lockPath).catch(() => null);
  if (!(current && sameStats(initial, current))) {
    return true;
  }
  await unlink(lockPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
      throw error;
    }
  });
  return true;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code !== "ESRCH";
  }
}

function sameStats(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs
  );
}

async function assertArtifactFilesystemLockOwned(
  lock: ArtifactFilesystemLock
): Promise<void> {
  const [handleStat, pathStat] = await Promise.all([
    lock.fileHandle.stat(),
    lstat(lock.path).catch(() => null),
  ]);
  if (
    !(
      pathStat &&
      sameStats(lock.fileStat, handleStat) &&
      sameStats(lock.fileStat, pathStat)
    )
  ) {
    throw new AtlasApiError(
      "Artifact save lock changed. Reload and try again.",
      409
    );
  }
}

async function releaseArtifactFilesystemLock(
  lock: ArtifactFilesystemLock
): Promise<void> {
  const current = await lstat(lock.path).catch(() => null);
  await lock.fileHandle.close().catch(() => undefined);
  if (current && sameStats(lock.fileStat, current)) {
    await unlink(lock.path).catch(() => undefined);
  }
}

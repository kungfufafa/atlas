import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { readOfficeZipParts } from "../office-document/archive";

export const MAX_SPREADSHEET_BYTES = 25 * 1024 * 1024;
export const MAX_SPREADSHEET_ROWS = 100_000;
export const MAX_SPREADSHEET_COLUMNS = 256;
export const MAX_SPREADSHEET_CELLS = 500_000;
export const MAX_SPREADSHEET_CELL_BYTES = 32_767;
export const MAX_SPREADSHEET_RESPONSE_BYTES = 256 * 1024;
export const MAX_SPREADSHEET_READ_CELLS = 10_000;

export type SpreadsheetFormat = ".csv" | ".json" | ".xlsx";

export function spreadsheetFormat(filePath: string): SpreadsheetFormat {
  const extension = path.extname(filePath).toLowerCase();
  if (extension !== ".xlsx" && extension !== ".csv" && extension !== ".json") {
    throw new Error(
      "Spreadsheet files must use .xlsx, .csv, or .json. Convert other formats before editing."
    );
  }
  return extension;
}

export function spreadsheetRevision(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function readSpreadsheetBytes(filePath: string): Promise<Buffer> {
  const info = await stat(filePath);
  if (!info.isFile() || info.size > MAX_SPREADSHEET_BYTES) {
    throw new Error(
      "Spreadsheet must be a regular file no larger than 25 MiB."
    );
  }
  const bytes = await readFile(filePath);
  if (bytes.length > MAX_SPREADSHEET_BYTES) {
    throw new Error("Spreadsheet exceeds the 25 MiB limit.");
  }
  return bytes;
}

export function inspectSpreadsheetArchive(
  bytes: Uint8Array
): Record<string, Uint8Array> {
  if (bytes.byteLength > MAX_SPREADSHEET_BYTES) {
    throw new Error("Spreadsheet exceeds the 25 MiB limit.");
  }
  // Validate actual inflated sizes and checksums before ExcelJS/JSZip receives
  // the archive. Central-directory sizes alone can be forged.
  const parts = readOfficeZipParts(bytes);
  if (!parts["xl/workbook.xml"]) {
    throw new Error("The file is not a valid XLSX workbook.");
  }
  return parts;
}

const writes = new Map<string, Promise<unknown>>();

export async function withSpreadsheetWrite<T>(
  filePath: string,
  operation: () => Promise<T>
): Promise<T> {
  const previous = writes.get(filePath) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  writes.set(filePath, current);
  try {
    return await current;
  } finally {
    if (writes.get(filePath) === current) {
      writes.delete(filePath);
    }
  }
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export async function spreadsheetExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (isCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

/** Publish complete bytes, retaining the old file unless a revision was supplied. */
export async function publishSpreadsheet(input: {
  bytes: Buffer;
  expectedRevision?: string;
  path: string;
  signal?: AbortSignal;
  writeMode: "inplace" | "versioned";
}): Promise<{ path: string; revision: string }> {
  const suppliedBytes = input.bytes;
  if (suppliedBytes.byteLength > MAX_SPREADSHEET_BYTES) {
    throw new Error("Generated spreadsheet exceeds the 25 MiB limit.");
  }
  const bytes = Buffer.from(suppliedBytes);
  const directory = path.dirname(input.path);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(
    directory,
    `.atlas-sheet-${crypto.randomUUID()}.tmp`
  );
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    input.signal?.throwIfAborted();
    if (input.writeMode === "inplace") {
      if (!input.expectedRevision) {
        throw new Error(
          "In-place editing requires expectedRevision from inspect or read_range."
        );
      }
      const current = await readSpreadsheetBytes(input.path);
      if (spreadsheetRevision(current) !== input.expectedRevision) {
        throw new Error(
          "Spreadsheet changed since it was read. Inspect it again before editing."
        );
      }
      input.signal?.throwIfAborted();
      await rename(temporary, input.path);
      return { path: input.path, revision: spreadsheetRevision(bytes) };
    }
    const parsed = path.parse(input.path);
    for (let version = 1; version <= 10_000; version += 1) {
      const destination =
        version === 1
          ? input.path
          : path.join(parsed.dir, `${parsed.name}-v${version}${parsed.ext}`);
      input.signal?.throwIfAborted();
      try {
        // link is exclusive: concurrent writers cannot replace an existing file.
        await link(temporary, destination);
        return {
          path: destination,
          revision: spreadsheetRevision(bytes),
        };
      } catch (error) {
        if (!isCode(error, "EEXIST")) {
          throw error;
        }
      }
    }
    throw new Error("Too many spreadsheet versions. Choose a new output path.");
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export function boundedSpreadsheetResponse<T>(value: T): T {
  if (
    Buffer.byteLength(JSON.stringify(value)) > MAX_SPREADSHEET_RESPONSE_BYTES
  ) {
    throw new Error(
      "Spreadsheet result exceeds 256 KiB. Request a smaller explicit range."
    );
  }
  return value;
}

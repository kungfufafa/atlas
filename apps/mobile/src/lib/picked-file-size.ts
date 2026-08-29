import { MAX_DOCUMENT_BYTES } from "@atlas/core/message-content-limits";
import { getInfoAsync } from "expo-file-system/legacy";

/** Matches the server's compressed Atlas data-import archive limit. */
export const MAX_DATA_IMPORT_ARCHIVE_BYTES = 64 * 1024 * 1024;

type PickedFile = {
  file?: { size?: number };
  size?: number;
  uri: string;
};

function isByteSize(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertSizeAtMost(size: number, limit: number, message: string): void {
  if (size > limit) {
    throw new Error(message);
  }
}

async function resolvePickedFileSize(asset: PickedFile): Promise<number> {
  if (isByteSize(asset.size)) {
    return asset.size;
  }
  if (isByteSize(asset.file?.size)) {
    return asset.file.size;
  }

  try {
    const info = await getInfoAsync(asset.uri);
    if (info.exists && isByteSize(info.size)) {
      return info.size;
    }
  } catch {
    // Picker implementations do not always report size. Fall through to fail closed.
  }

  throw new Error("Could not determine the selected file size.");
}

export async function assertPickedDocumentSize(
  asset: PickedFile
): Promise<void> {
  const size = await resolvePickedFileSize(asset);
  assertSizeAtMost(size, MAX_DOCUMENT_BYTES, "Files must be at most 5 MB.");
}

export async function assertPickedDataImportArchiveSize(
  asset: PickedFile
): Promise<void> {
  const size = await resolvePickedFileSize(asset);
  assertSizeAtMost(
    size,
    MAX_DATA_IMPORT_ARCHIVE_BYTES,
    "Import archives must be at most 64 MiB."
  );
}

export function assertDataImportArchiveSize(size: number): void {
  assertSizeAtMost(
    size,
    MAX_DATA_IMPORT_ARCHIVE_BYTES,
    "Import archives must be at most 64 MiB."
  );
}

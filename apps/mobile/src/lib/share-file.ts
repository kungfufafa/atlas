import { inferArtifactMimeType } from "@atlas/core/artifact-mime";
import {
  cacheDirectory,
  EncodingType,
  writeAsStringAsync,
} from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";

function arrayBufferToBase64(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export async function writeCacheFile(
  filename: string,
  data: ArrayBuffer
): Promise<string> {
  const root = cacheDirectory;
  if (!root) {
    throw new Error("No cache directory on this device.");
  }
  const safe = filename.replace(/[^\w.-]+/g, "_") || "file";
  const path = `${root}${Date.now()}-${safe}`;
  await writeAsStringAsync(path, arrayBufferToBase64(data), {
    encoding: EncodingType.Base64,
  });
  return path;
}

export async function shareBinaryFile(
  filename: string,
  data: ArrayBuffer,
  mimeType?: string
): Promise<void> {
  const path = await writeCacheFile(filename, data);
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error("Sharing is not available on this device.");
  }
  await Sharing.shareAsync(path, {
    mimeType: mimeType || inferArtifactMimeType(filename),
  });
}

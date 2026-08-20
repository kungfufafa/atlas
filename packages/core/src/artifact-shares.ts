import crypto from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./fs";
import { getArtifactSharesDir } from "./soul/resolve";

export function generateArtifactShareToken(): string {
  // No underscores: plain-text markdown strippers treat `_word_` as italic and can
  // corrupt share URLs in channel footers (Telegram sendPlain path).
  return `nkshare${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
}

export function buildArtifactSharePath(token: string): string {
  return `/s/${token}`;
}

export function sanitizeArtifactShareFilename(filename: string): string {
  return path.basename(filename).replace(/[^\w.\-()+ ]+/g, "_") || "artifact";
}

export async function writeArtifactShareSnapshot(input: {
  orgId: string;
  shareId: string;
  filename: string;
  bytes: Buffer;
}): Promise<string> {
  const sharesDir = getArtifactSharesDir(input.orgId);
  const shareDir = path.join(sharesDir, input.shareId);
  await mkdir(shareDir, { recursive: true });

  const safeName = sanitizeArtifactShareFilename(input.filename);
  const storagePath = path.join(shareDir, safeName);
  await writeFile(storagePath, input.bytes);
  return storagePath;
}

export async function readArtifactShareSnapshot(
  storagePath: string
): Promise<Buffer> {
  if (!(await pathExists(storagePath))) {
    throw new Error("Artifact share snapshot not found");
  }

  return readFile(storagePath);
}

export async function deleteArtifactShareSnapshot(
  storagePath: string
): Promise<void> {
  try {
    await unlink(storagePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

import { randomUUID } from "node:crypto";
import { link, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";

/** Caller must guard the destination first. Only complete, exclusive files are published. */
export async function writeNewArtifactVersion(
  destination: string,
  bytes: string | Uint8Array,
  signal?: AbortSignal
): Promise<string> {
  const capturedBytes =
    typeof bytes === "string" ? bytes : new Uint8Array(bytes);
  signal?.throwIfAborted();
  const directory = path.dirname(destination);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, `.atlas-publish-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(capturedBytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const parsed = path.parse(destination);
    const date = new Date().toISOString().slice(0, 10);
    for (let attempt = 0; attempt <= 100; attempt++) {
      signal?.throwIfAborted();
      const suffix = attempt === 1 ? date : `${date}-${attempt}`;
      const candidate =
        attempt === 0
          ? destination
          : path.join(directory, `${parsed.name}-${suffix}${parsed.ext}`);
      try {
        await link(temporary, candidate);
        return candidate;
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "EEXIST"
        ) {
          continue;
        }
        throw error;
      }
    }
    throw new Error(
      `Unable to find available artifact filename for ${destination}`
    );
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

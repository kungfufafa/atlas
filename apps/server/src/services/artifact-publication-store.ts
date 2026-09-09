import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } from "@atlas/core/fs";
import { MAX_PUBLICATION_BYTES } from "@atlas/db";

const SNAPSHOT_ID = /^snapshot_[a-f0-9-]{36}$/;
const digest = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
function contains(root: string, path: string): boolean {
  const part = relative(root, path);
  return (
    part === "" ||
    !(part === ".." || part.startsWith("../") || isAbsolute(part))
  );
}

/** Write-once through this API. Unrestricted host code remains trusted. */
export class ArtifactPublicationStore {
  private constructor(private readonly directory: string) {}

  static async create(
    configDirectory: string
  ): Promise<ArtifactPublicationStore> {
    const config = await realpath(configDirectory);
    const directory = join(config, "artifact-publications");
    await mkdir(directory, { mode: PRIVATE_DIR_MODE, recursive: true });
    if (
      (await lstat(directory)).isSymbolicLink() ||
      (await realpath(directory)) !== directory
    ) {
      throw new Error(
        "Publication storage must be a private canonical directory."
      );
    }
    return new ArtifactPublicationStore(directory);
  }

  /** Caller must supply every admitted tool read/write root, including runtime/temp roots. */
  async assertOutsideToolRoots(roots: readonly string[]): Promise<void> {
    if (!roots.length) {
      throw new Error("Admitted tool roots must be declared.");
    }
    for (const root of roots) {
      const canonical = await realpath(root);
      if (
        contains(canonical, this.directory) ||
        contains(this.directory, canonical)
      ) {
        throw new Error("Publication storage overlaps an admitted tool root.");
      }
    }
  }

  async stage(
    bytes: Uint8Array
  ): Promise<{ snapshotId: string; sha256: string; sizeBytes: number }> {
    // Copy before any await: later mutations of the producer's buffer cannot alter this snapshot.
    if (bytes.byteLength > MAX_PUBLICATION_BYTES) {
      throw new Error("Publication output exceeds the byte limit.");
    }
    const captured = Buffer.from(bytes);
    const snapshotId = `snapshot_${randomUUID()}`;
    const path = this.path(snapshotId);
    const handle = await open(path, "wx", PRIVATE_FILE_MODE);
    try {
      try {
        await handle.writeFile(captured);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.syncDirectory();
      return {
        sha256: digest(captured),
        sizeBytes: captured.byteLength,
        snapshotId,
      };
    } catch (error) {
      await unlink(path).catch(() => undefined);
      throw error;
    }
  }

  async read(snapshot: {
    snapshotId: string;
    sha256: string;
    sizeBytes: number;
  }): Promise<Buffer> {
    if (
      !Number.isSafeInteger(snapshot.sizeBytes) ||
      snapshot.sizeBytes < 0 ||
      snapshot.sizeBytes > MAX_PUBLICATION_BYTES
    ) {
      throw new Error("Invalid publication byte count.");
    }
    const handle = await open(
      this.path(snapshot.snapshotId),
      // biome-ignore lint/suspicious/noBitwiseOperators: Refuse final-component symlinks.
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size !== snapshot.sizeBytes
      ) {
        throw new Error("Publication snapshot is unavailable or changed.");
      }
      const bytes = Buffer.alloc(snapshot.sizeBytes + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await handle.read(
          bytes,
          offset,
          bytes.length - offset,
          null
        );
        if (!result.bytesRead) {
          break;
        }
        offset += result.bytesRead;
      }
      const captured = bytes.subarray(0, offset);
      if (
        offset !== snapshot.sizeBytes ||
        digest(captured) !== snapshot.sha256
      ) {
        throw new Error("Publication snapshot digest changed.");
      }
      return captured;
    } finally {
      await handle.close();
    }
  }

  /** Server-only cleanup must first establish that no DB record references this object. */
  async removeUnreferenced(
    snapshotId: string,
    isReferenced: () => Promise<boolean>
  ): Promise<void> {
    if (await isReferenced()) {
      return;
    }
    await unlink(this.path(snapshotId)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    });
    await this.syncDirectory();
  }
  private path(id: string): string {
    if (!SNAPSHOT_ID.test(id)) {
      throw new Error("Invalid snapshot ID.");
    }
    return join(this.directory, id);
  }
  private async syncDirectory(): Promise<void> {
    const handle = await open(this.directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

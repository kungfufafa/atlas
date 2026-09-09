import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { inferArtifactMimeType } from "../artifact-mime";
import { stageToolArtifact } from "../artifact-publication";
import type { ToolArtifact, ToolContext } from "../contract";
import { buildToolExecutionContext } from "../tools/context";
import { guardFilePath } from "../tools/paths";

export const MAX_FILE_ASSET_BYTES = 25 * 1024 * 1024;

export function fileAssetRevision(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function fileAssetWorkspace(context: ToolContext): string {
  const root = buildToolExecutionContext(context).workspaceRoot;
  if (!root) {
    throw new Error("A profile workspace is required for file operations.");
  }
  return root;
}

export async function loadFileAsset(
  reference: string,
  context: ToolContext,
  options: { allowedExtensions?: readonly string[]; maxBytes: number }
): Promise<{
  bytes: Buffer;
  filename: string;
  mediaType: string;
  sourcePath?: string;
}> {
  context.signal?.throwIfAborted();
  let asset: {
    bytes: Buffer;
    filename: string;
    mediaType: string;
    sourcePath?: string;
  };
  if (reference.startsWith("att_")) {
    const loaded = await context.loadAttachment?.(reference);
    if (!loaded) {
      throw new Error(
        `Attachment is unavailable in this session: ${reference}`
      );
    }
    asset = { ...loaded, filename: loaded.filename ?? reference };
  } else {
    const root = fileAssetWorkspace(context);
    const guarded = await guardFilePath(reference, null, undefined, {
      allowedDirs: context.fileAssetAllowedDirs ?? [root],
      cwd: root,
    });
    const handle = await open(
      guarded.resolved,
      // biome-ignore lint/suspicious/noBitwiseOperators: Combine POSIX open flags to refuse symlinks.
      constants.O_RDONLY | constants.O_NOFOLLOW
    );
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        throw new Error("The source must be a regular file.");
      }
      if (info.size > options.maxBytes) {
        throw new Error(`File exceeds the ${options.maxBytes} byte limit.`);
      }
      asset = {
        bytes: await handle.readFile(),
        filename: path.basename(guarded.resolved),
        mediaType: inferArtifactMimeType(guarded.resolved),
        sourcePath: guarded.resolved,
      };
    } finally {
      await handle.close();
    }
  }
  if (asset.bytes.length > options.maxBytes) {
    throw new Error(`File exceeds the ${options.maxBytes} byte limit.`);
  }
  const extension = path.extname(asset.filename).toLowerCase();
  if (
    options.allowedExtensions &&
    !options.allowedExtensions.includes(extension)
  ) {
    throw new Error(
      `Unsupported file format ${extension || "(unknown)"}; expected ${options.allowedExtensions.join(", ")}.`
    );
  }
  context.signal?.throwIfAborted();
  return asset;
}

/** Publish a complete file without overwriting an existing artifact or its source. */
export async function saveFileArtifact(input: {
  bytes: Uint8Array;
  context: ToolContext;
  deliverable?: boolean;
  filename: string;
  sourcePath?: string;
}): Promise<{
  artifacts: ToolArtifact[];
  bytesWritten: number;
  path: string;
  revision: string;
}> {
  const suppliedBytes = input.bytes;
  if (suppliedBytes.byteLength > MAX_FILE_ASSET_BYTES) {
    throw new Error(`Output exceeds the ${MAX_FILE_ASSET_BYTES} byte limit.`);
  }
  const bytes = new Uint8Array(suppliedBytes);
  input.context.signal?.throwIfAborted();
  const root = fileAssetWorkspace(input.context);
  // Materialized input is a working source, not a new deliverable for channels.
  const outputDirectory =
    input.deliverable === false ? ".sources" : "artifacts";
  const filename = input.filename.trim();
  if (
    !filename ||
    filename !== path.basename(filename) ||
    /[\\/\x00-\x1f]/.test(filename) ||
    filename === "." ||
    filename === ".." ||
    filename.length > 180
  ) {
    throw new Error(
      "outputFilename must be a filename without directories (maximum 180 characters)."
    );
  }
  const directory = await guardFilePath(outputDirectory, null, undefined, {
    allowedDirs: [root],
    cwd: root,
  });
  await mkdir(directory.resolved, { mode: 0o700, recursive: true });
  const { resolved: verifiedDirectory } = await guardFilePath(
    outputDirectory,
    null,
    undefined,
    { allowedDirs: [root], cwd: root }
  );
  const temporary = path.join(verifiedDirectory, `.atlas-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const parsed = path.parse(filename);
    for (let version = 0; version < 1000; version++) {
      input.context.signal?.throwIfAborted();
      const candidate =
        version === 0 ? filename : `${parsed.name}-${version + 1}${parsed.ext}`;
      const destination = path.join(verifiedDirectory, candidate);
      try {
        // link is atomic and fails on any existing destination, including symlinks.
        await link(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          continue;
        }
        throw error;
      }
      if (input.deliverable !== false) {
        await stageToolArtifact(input.context.artifactPublisher, {
          bytes,
          sourcePath: `${outputDirectory}/${candidate}`,
        });
      }
      return {
        artifacts:
          input.deliverable === false
            ? []
            : [
                {
                  createdAt: new Date().toISOString(),
                  filename: candidate,
                  id: randomUUID(),
                  mimeType: inferArtifactMimeType(candidate),
                  path: `${outputDirectory}/${candidate}`,
                  sessionId: input.context.sessionId,
                  sizeBytes: bytes.length,
                },
              ],
        bytesWritten: bytes.length,
        path: `${outputDirectory}/${candidate}`,
        revision: fileAssetRevision(bytes),
      };
    }
    throw new Error(
      "Too many artifact versions; choose another output filename."
    );
  } finally {
    await unlink(temporary);
  }
}

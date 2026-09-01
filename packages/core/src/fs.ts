import { randomUUID } from "node:crypto";
import type { Dirent, Mode } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(
  path: string,
  mode: Mode = PRIVATE_DIR_MODE
): Promise<void> {
  await mkdir(path, { mode, recursive: true });
}

export async function readText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function readTextIfExists(
  path: string
): Promise<string | undefined> {
  if (!(await pathExists(path))) {
    return;
  }

  const content = (await readFile(path, "utf8")).trim();
  return content || undefined;
}

export async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readText(path);
  } catch {
    return null;
  }
}

export async function readBytes(path: string): Promise<Buffer> {
  return readFile(path);
}

export async function writeTextFile(
  path: string,
  content: string,
  options: {
    mode?: Mode;
    ensureDir?: string;
    ensureDirMode?: Mode;
    chmod?: boolean;
  } = {}
): Promise<void> {
  const mode = options.mode ?? PRIVATE_FILE_MODE;
  const directory = options.ensureDir ?? dirname(path);
  await ensureDir(directory, options.ensureDirMode ?? PRIVATE_DIR_MODE);

  let preservedMode: number | undefined;
  if (options.chmod === false && (await pathExists(path))) {
    // biome-ignore lint/suspicious/noBitwiseOperators: permission bits are stored in st_mode.
    preservedMode = (await stat(path)).mode & 0o777;
  }

  // A same-directory temporary file makes rename atomic. A unique name also
  // keeps simultaneous writers from sharing and corrupting one temp file.
  const tempPath = `${path}.atlas-tmp-${process.pid}-${randomUUID()}`;
  let renamed = false;
  try {
    await writeFile(tempPath, content, {
      encoding: "utf8",
      mode: preservedMode ?? mode,
    });

    const handle = await open(tempPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(tempPath, path);
    renamed = true;

    if (options.chmod ?? true) {
      await chmod(path, mode);
    } else if (preservedMode !== undefined) {
      await chmod(path, preservedMode);
    }
  } finally {
    if (!renamed) {
      await unlink(tempPath).catch(() => undefined);
    }
  }
}

export async function writePrivateTextFile(
  path: string,
  content: string,
  options: { ensureDir?: string } = {}
): Promise<void> {
  await writeTextFile(path, content, options);
}

export async function writePrivateTextFileIfMissing(
  path: string,
  content: string
): Promise<boolean> {
  if (await pathExists(path)) {
    return false;
  }

  await writePrivateTextFile(path, content);
  return true;
}

export async function writePrivateBytesFile(
  path: string,
  content: Buffer
): Promise<void> {
  await ensureDir(dirname(path));
  const tempPath = `${path}.${randomUUID()}.atlas-tmp`;
  let renamed = false;

  try {
    await writeFile(tempPath, content, { mode: PRIVATE_FILE_MODE });
    const handle = await open(tempPath, "r+");

    try {
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(tempPath, path);
    renamed = true;
    await chmod(path, PRIVATE_FILE_MODE);
  } finally {
    if (!renamed) {
      await unlink(tempPath).catch(() => undefined);
    }
  }
}

export async function readDirectoryEntries(path: string): Promise<Dirent[]> {
  return readdir(path, { withFileTypes: true });
}

export async function readDirectory(path: string): Promise<string[]> {
  return readdir(path);
}

export async function readDirectoryOrEmpty(path: string): Promise<string[]> {
  try {
    return await readDirectory(path);
  } catch {
    return [];
  }
}

export async function removeFile(path: string): Promise<void> {
  await unlink(path);
}

export function parseIni(raw: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";")) {
      continue;
    }

    const separator = trimmed.indexOf("=");

    if (separator <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    values[key] = value;
  }

  return values;
}

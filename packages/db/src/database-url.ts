import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { getUserConfigDir, PRIVATE_DIR_MODE } from "@atlas/core";

export interface ResolveDatabasePathOptions {
  /** Anchor relative file: paths (defaults to ~/.atlas). */
  baseDir?: string;
}

export function resolveDatabasePath(
  databaseUrl: string,
  options: ResolveDatabasePathOptions = {}
): string {
  const trimmed = databaseUrl.trim();

  if (trimmed === ":memory:" || trimmed === "memory:") {
    return ":memory:";
  }

  const withoutScheme = trimmed.startsWith("file:")
    ? trimmed.slice("file:".length)
    : trimmed;

  if (isAbsolute(withoutScheme)) {
    return withoutScheme;
  }

  const baseDir = options.baseDir?.trim() || getUserConfigDir();

  return resolve(baseDir, withoutScheme);
}

export function ensureDatabaseDirectory(databasePath: string): void {
  if (databasePath === ":memory:") {
    return;
  }

  const directory = dirname(databasePath);
  const directoryAlreadyExisted = existsSync(directory);
  mkdirSync(directory, { mode: PRIVATE_DIR_MODE, recursive: true });

  // A new directory belongs to Atlas. Existing directories are only ours when
  // they live under ATLAS_CONFIG_DIR; a custom SQLite path may intentionally
  // share its parent with other applications, so never chmod that parent.
  if (
    !directoryAlreadyExisted ||
    isPathWithinDirectory(directory, getUserConfigDir())
  ) {
    // mkdir masks a new directory's mode with the umask and leaves an existing
    // one alone, so re-tighten directories Atlas owns.
    chmodSync(directory, PRIVATE_DIR_MODE);
  }
}

function isPathWithinDirectory(candidate: string, parent: string): boolean {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return (
    relativePath === "" ||
    !(relativePath.startsWith("..") || isAbsolute(relativePath))
  );
}

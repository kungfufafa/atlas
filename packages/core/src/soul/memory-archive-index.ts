import { join, resolve, sep } from "node:path";
import { pathExists, readDirectoryOrEmpty, readTextIfExists } from "../fs";
import {
  type ContinuityMemoryFact,
  parseContinuityMemoryFacts,
} from "./continuity-memory";
import { MEMORY_ARCHIVE_RELATIVE_DIR } from "./memory-paths";
import { getProfileSoulDir } from "./resolve";

const ARCHIVE_YEAR_MONTH_FILE = /^\d{4}-(?:0[1-9]|1[0-2])\.md$/;

export interface LoadMemoryArchiveFactsOptions {
  source?: ContinuityMemoryFact["source"];
}

function isInsideDirectory(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(`${resolvedRoot}${sep}`)
  );
}

export function parseMemoryArchiveFacts(
  content: string,
  fileId: string,
  options: LoadMemoryArchiveFactsOptions = {}
): ContinuityMemoryFact[] {
  return parseContinuityMemoryFacts(content, options.source ?? "archive", {
    idPrefix: `archive:${fileId}`,
  });
}

/**
 * Load parsed archive bullets from a profile `memory-archive/` directory.
 * Only `YYYY-MM.md` files are read. Missing directories yield an empty list.
 */
export async function loadMemoryArchiveFacts(
  archiveDir: string,
  options: LoadMemoryArchiveFactsOptions = {}
): Promise<ContinuityMemoryFact[]> {
  if (!(await pathExists(archiveDir))) {
    return [];
  }
  const names = (await readDirectoryOrEmpty(archiveDir)).filter((name) =>
    ARCHIVE_YEAR_MONTH_FILE.test(name)
  );
  names.sort((left, right) => left.localeCompare(right));
  const facts: ContinuityMemoryFact[] = [];
  for (const name of names) {
    const filePath = join(archiveDir, name);
    if (!isInsideDirectory(archiveDir, filePath)) {
      continue;
    }
    const content = await readTextIfExists(filePath);
    if (!content) {
      continue;
    }
    facts.push(...parseMemoryArchiveFacts(content, name, options));
  }
  return facts;
}

function profileArchiveDirs(orgId: string, profileId: string): string[] {
  const soulDir = getProfileSoulDir(orgId, profileId);
  return [
    join(soulDir, MEMORY_ARCHIVE_RELATIVE_DIR),
    join(soulDir, "data", MEMORY_ARCHIVE_RELATIVE_DIR),
  ];
}

/**
 * Profile-scoped archive loader used by production `memory_search`.
 * Prefers top-level `memory-archive/`; falls back to legacy `data/memory-archive/`.
 */
export async function loadProfileMemoryArchiveFacts(
  orgId: string,
  profileId: string,
  options: LoadMemoryArchiveFactsOptions = {}
): Promise<ContinuityMemoryFact[]> {
  if (!(orgId.trim() && profileId.trim())) {
    return [];
  }
  for (const directory of profileArchiveDirs(orgId, profileId)) {
    const facts = await loadMemoryArchiveFacts(directory, options);
    if (facts.length > 0 || (await pathExists(directory))) {
      return facts;
    }
  }
  return [];
}

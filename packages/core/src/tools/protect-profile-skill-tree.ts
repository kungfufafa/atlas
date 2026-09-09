import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { ToolContext } from "../contract";
import { withProfileSoulMutationLock } from "../soul/mutation-lock";

export const PROFILE_SKILL_SHELL_WRITE_MESSAGE =
  "Use skill_manage to create, patch, edit, delete, or manage supporting files for profile skills; writing skills/ via python_execute or bash is not allowed when skill_manage is available.";

/**
 * Run a workspace mutation, then revert any change under `skills/` when
 * `forbidProfileSkillMarkdownWrites` is set (python_execute / bash bypass).
 */
export async function withProtectedProfileSkillTree<T>(
  context: ToolContext,
  workspaceRoot: string,
  run: () => Promise<T>
): Promise<T> {
  if (!context.forbidProfileSkillMarkdownWrites) {
    return run();
  }

  const protectedRun = () => runWithSkillSnapshot(workspaceRoot, run);
  // Keep a concurrent skill_manage/file mutation from being mistaken for the
  // shell's changes and overwritten during restoration.
  if (context.orgId && context.profileId) {
    return withProfileSoulMutationLock(
      context.orgId,
      context.profileId,
      protectedRun
    );
  }
  return protectedRun();
}

async function runWithSkillSnapshot<T>(
  workspaceRoot: string,
  run: () => Promise<T>
): Promise<T> {
  const skillsRoot = path.join(workspaceRoot, "skills");
  const before = await snapshotSkillTree(skillsRoot);
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await run() };
  } catch (error) {
    outcome = { error, ok: false };
  }
  let changed = true;
  try {
    changed = !skillTreesEqual(before, await snapshotSkillTree(skillsRoot));
  } catch {
    // An unreadable tree after execution must also restore the known snapshot.
  }
  if (changed) {
    await restoreSkillTree(skillsRoot, before);
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  if (changed) {
    throw new Error(PROFILE_SKILL_SHELL_WRITE_MESSAGE);
  }
  return outcome.value;
}

type SkillTreeEntry =
  | { kind: "directory"; mode: number }
  | { kind: "file"; mode: number; bytes: Buffer }
  | { kind: "symlink"; target: string };

type SkillTreeSnapshot = Map<string, SkillTreeEntry>;

async function snapshotSkillTree(
  skillsRoot: string
): Promise<SkillTreeSnapshot> {
  const snapshot: SkillTreeSnapshot = new Map();
  try {
    await lstat(skillsRoot);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return snapshot;
    }
    throw error;
  }
  await walkSkillTree(skillsRoot, "", snapshot);
  return snapshot;
}

async function walkSkillTree(
  skillsRoot: string,
  relative: string,
  snapshot: SkillTreeSnapshot
): Promise<void> {
  const full = path.join(skillsRoot, relative);
  const info = await lstat(full);
  // Links, including a linked skills root, are snapshot data. Never traverse
  // their targets: those may be dangling or outside the protected tree.
  if (info.isSymbolicLink()) {
    snapshot.set(relative, { kind: "symlink", target: await readlink(full) });
    return;
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: Retain Unix permission bits, excluding file type.
  const mode = info.mode & 0o777;
  if (info.isFile()) {
    snapshot.set(relative, { bytes: await readFile(full), kind: "file", mode });
    return;
  }
  if (!info.isDirectory()) {
    throw new Error(
      "Cannot snapshot a special file in the protected skills tree."
    );
  }
  snapshot.set(relative, { kind: "directory", mode });
  for (const name of await readdir(full)) {
    await walkSkillTree(skillsRoot, path.join(relative, name), snapshot);
  }
}

function skillTreesEqual(
  left: SkillTreeSnapshot,
  right: SkillTreeSnapshot
): boolean {
  if (left.size !== right.size) {
    return false;
  }

  for (const [rel, entry] of left) {
    const other = right.get(rel);
    if (!other || entry.kind !== other.kind) {
      return false;
    }
    if (entry.kind === "symlink" && other.kind === "symlink") {
      if (entry.target !== other.target) {
        return false;
      }
    } else if (entry.kind === "file" && other.kind === "file") {
      if (entry.mode !== other.mode || !entry.bytes.equals(other.bytes)) {
        return false;
      }
    } else if (
      entry.kind === "directory" &&
      other.kind === "directory" &&
      entry.mode !== other.mode
    ) {
      return false;
    }
  }

  return true;
}

async function restoreSkillTree(
  skillsRoot: string,
  snapshot: SkillTreeSnapshot
): Promise<void> {
  await rm(skillsRoot, { force: true, recursive: true });

  for (const [rel, entry] of snapshot) {
    const dest = path.join(skillsRoot, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    if (entry.kind === "directory") {
      // Restore children before reapplying possibly read-only directory modes.
      await mkdir(dest, { mode: 0o700 });
    } else if (entry.kind === "symlink") {
      await symlink(entry.target, dest);
    } else {
      await writeFile(dest, entry.bytes, { mode: entry.mode });
      await chmod(dest, entry.mode);
    }
  }
  for (const [rel, entry] of [...snapshot].reverse()) {
    if (entry.kind === "directory") {
      await chmod(path.join(skillsRoot, rel), entry.mode);
    }
  }
}

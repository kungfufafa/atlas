import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ToolContext } from "../contract";
import { pathExists } from "../fs";

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

  const skillsRoot = path.join(workspaceRoot, "skills");
  const before = await snapshotSkillTree(skillsRoot);
  const result = await run();
  const after = await snapshotSkillTree(skillsRoot);

  if (skillTreesEqual(before, after)) {
    return result;
  }

  await restoreSkillTree(skillsRoot, before);
  throw new Error(PROFILE_SKILL_SHELL_WRITE_MESSAGE);
}

async function snapshotSkillTree(
  skillsRoot: string
): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  if (!(await pathExists(skillsRoot))) {
    return files;
  }

  await walkSkillFiles(skillsRoot, skillsRoot, files);
  return files;
}

async function walkSkillFiles(
  skillsRoot: string,
  dir: string,
  files: Map<string, Buffer>
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkSkillFiles(skillsRoot, full, files);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const rel = path.relative(skillsRoot, full).split(path.sep).join("/");
    files.set(rel, await readFile(full));
  }
}

function skillTreesEqual(
  left: Map<string, Buffer>,
  right: Map<string, Buffer>
): boolean {
  if (left.size !== right.size) {
    return false;
  }

  for (const [rel, bytes] of left) {
    const other = right.get(rel);
    if (!(other && bytes.equals(other))) {
      return false;
    }
  }

  return true;
}

async function restoreSkillTree(
  skillsRoot: string,
  snapshot: Map<string, Buffer>
): Promise<void> {
  await rm(skillsRoot, { force: true, recursive: true });

  for (const [rel, bytes] of snapshot) {
    const dest = path.join(skillsRoot, ...rel.split("/"));
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, bytes);
  }
}

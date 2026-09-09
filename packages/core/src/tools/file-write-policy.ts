import type { ToolContext } from "../contract";

/**
 * When skill_manage is available, refuse mutating any file under
 * `skills/<name>/` via file tools so creates/edits/sidecars go through
 * skill_manage (and write approval when gated).
 *
 * Call after path guard succeeds. Matches any descendant under
 * `.../skills/<name>/` on the resolved path (including nested paths and
 * realpath'd absolute paths under the workspace).
 */
export function refuseProfileSkillMarkdownWrite(
  context: ToolContext,
  resolvedPath: string
): void {
  if (!context.forbidProfileSkillMarkdownWrites) {
    return;
  }

  const normalized = resolvedPath.replace(/\\/g, "/");
  const match = normalized.match(/(?:^|\/)skills\/([^/]+)\/(.+)$/i);
  if (!match) {
    return;
  }

  const skillName = match[1];
  const rest = match[2];
  if (!skillName || skillName === "." || skillName === ".." || !rest) {
    return;
  }

  throw new Error(
    `Use skill_manage to create, patch, edit, delete, or manage supporting files for profile skills; writing skills/${skillName}/${rest} via file tools is not allowed when skill_manage is available.`
  );
}

/**
 * Always refuse agent writes of skill-local executables under skills/<name>/.
 * Those modules are loaded via dynamic import and must stay admin-authored in Phase 1.
 */
export function refuseSkillLocalToolFileWrite(resolvedPath: string): void {
  const normalized = resolvedPath.replace(/\\/g, "/");
  const match = normalized.match(/(?:^|\/)skills\/([^/]+)\/([^/]+)$/i);
  if (!match) {
    return;
  }

  const skillName = match[1];
  const fileName = match[2];
  if (!skillName || skillName === "." || skillName === ".." || !fileName) {
    return;
  }

  const lower = fileName.toLowerCase();
  if (lower !== "tool.ts" && lower !== "tool.js") {
    return;
  }

  throw new Error(
    `Skill-local tools (${fileName}) under skills/${skillName}/ cannot be written by agents in Phase 1.`
  );
}

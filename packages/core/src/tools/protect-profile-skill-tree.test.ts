import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withProtectedProfileSkillTree } from "./protect-profile-skill-tree";

describe("withProtectedProfileSkillTree", () => {
  test("allows skill writes when the forbid flag is off", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "atlas-skill-guard-"));
    try {
      const skillDir = path.join(root, "skills", "notes");
      await mkdir(skillDir, { recursive: true });
      const skillPath = path.join(skillDir, "SKILL.md");
      await writeFile(skillPath, "original");

      const result = await withProtectedProfileSkillTree(
        { orgId: "org", profileId: "profile" },
        root,
        async () => {
          await writeFile(skillPath, "changed");
          return "ok";
        }
      );

      expect(result).toBe("ok");
      expect(await readFile(skillPath, "utf8")).toBe("changed");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("reverts skill writes and throws when the forbid flag is on", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "atlas-skill-guard-"));
    try {
      const skillDir = path.join(root, "skills", "notes");
      await mkdir(skillDir, { recursive: true });
      const skillPath = path.join(skillDir, "SKILL.md");
      await writeFile(skillPath, "original");

      await expect(
        withProtectedProfileSkillTree(
          {
            forbidProfileSkillMarkdownWrites: true,
            orgId: "org",
            profileId: "profile",
          },
          root,
          async () => {
            await writeFile(skillPath, "hijacked");
            return "ok";
          }
        )
      ).rejects.toThrow("Use skill_manage");

      expect(await readFile(skillPath, "utf8")).toBe("original");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

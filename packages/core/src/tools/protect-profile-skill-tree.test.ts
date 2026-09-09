import { describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { withProfileSoulMutationLock } from "../soul/mutation-lock";
import { withProtectedProfileSkillTree } from "./protect-profile-skill-tree";

describe("withProtectedProfileSkillTree", () => {
  test.each(["add", "replace", "remove", "add_dangling"] as const)(
    "restores %s symlink changes without modifying their targets",
    async (mutation) => {
      const root = await mkdtemp(path.join(tmpdir(), "atlas-skill-links-"));
      const skills = path.join(root, "skills");
      const existing = path.join(skills, "external");
      const dangling = path.join(skills, "dangling");
      const added = path.join(skills, "added");
      const target = path.join(root, "outside", "SKILL.md");
      try {
        await mkdir(skills);
        await mkdir(path.dirname(target));
        await writeFile(target, "unchanged target");
        await symlink("../outside", existing);
        await symlink("../missing", dangling);
        await expect(
          withProtectedProfileSkillTree(
            {
              forbidProfileSkillMarkdownWrites: true,
              orgId: "org",
              profileId: "profile",
            },
            root,
            async () => {
              if (mutation === "add" || mutation === "add_dangling") {
                await symlink(
                  mutation === "add" ? "../outside" : "../also-missing",
                  added
                );
              } else {
                await rm(existing);
                if (mutation === "replace") {
                  await symlink("../different-target", existing);
                }
              }
              return "finished";
            }
          )
        ).rejects.toThrow();
        expect((await lstat(existing)).isSymbolicLink()).toBe(true);
        expect(await readlink(existing)).toBe("../outside");
        expect(await readlink(dangling)).toBe("../missing");
        expect(
          await lstat(added).then(
            () => true,
            () => false
          )
        ).toBe(false);
        expect(await readFile(target, "utf8")).toBe("unchanged target");
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    }
  );

  test("keeps original links and executable file mode when restoring other file changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "atlas-skill-links-"));
    const skills = path.join(root, "skills");
    const supportingFile = path.join(skills, "helper.sh");
    try {
      await mkdir(skills);
      await mkdir(path.join(skills, "empty"));
      await writeFile(supportingFile, "original");
      await chmod(supportingFile, 0o750);
      await symlink("missing-target", path.join(skills, "original-link"));
      await expect(
        withProtectedProfileSkillTree(
          {
            forbidProfileSkillMarkdownWrites: true,
            orgId: "org",
            profileId: "profile",
          },
          root,
          async () => {
            await writeFile(supportingFile, "changed");
            await chmod(supportingFile, 0o600);
          }
        )
      ).rejects.toThrow();
      expect(await readFile(supportingFile, "utf8")).toBe("original");
      // biome-ignore lint/suspicious/noBitwiseOperators: Compare Unix permission bits independently of file type.
      expect((await lstat(supportingFile)).mode & 0o777).toBe(0o750);
      expect(await readlink(path.join(skills, "original-link"))).toBe(
        "missing-target"
      );
      expect((await lstat(path.join(skills, "empty"))).isDirectory()).toBe(
        true
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test.each(["outside", "missing-target"])(
    "restores a linked skills root targeting %s without walking that target",
    async (linkTarget) => {
      const root = await mkdtemp(path.join(tmpdir(), "atlas-skill-links-"));
      const skills = path.join(root, "skills");
      const targetFile = path.join(root, "outside", "SKILL.md");
      try {
        await mkdir(path.dirname(targetFile));
        await writeFile(targetFile, "outside content");
        await symlink(linkTarget, skills);
        const failure = new Error("cancelled after replacing root link");
        await expect(
          withProtectedProfileSkillTree(
            {
              forbidProfileSkillMarkdownWrites: true,
              orgId: "org",
              profileId: "profile",
            },
            root,
            async () => {
              await rm(skills);
              await mkdir(skills);
              await writeFile(path.join(skills, "new.md"), "injected");
              throw failure;
            }
          )
        ).rejects.toBe(failure);
        expect((await lstat(skills)).isSymbolicLink()).toBe(true);
        expect(await readlink(skills)).toBe(linkTarget);
        expect(await readFile(targetFile, "utf8")).toBe("outside content");
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    }
  );

  test("leaves unchanged dangling links intact", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "atlas-skill-links-"));
    const skills = path.join(root, "skills");
    try {
      await mkdir(skills);
      await symlink("missing-target", path.join(skills, "link"));
      expect(
        await withProtectedProfileSkillTree(
          {
            forbidProfileSkillMarkdownWrites: true,
            orgId: "org",
            profileId: "profile",
          },
          root,
          async () => "finished"
        )
      ).toBe("finished");
      expect(await readlink(path.join(skills, "link"))).toBe("missing-target");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("restores changed skills after a rejected run and preserves the original error", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "atlas-skill-guard-"));
    try {
      const skillPath = path.join(root, "skills", "notes", "SKILL.md");
      await mkdir(path.dirname(skillPath), { recursive: true });
      await writeFile(skillPath, "original");
      const failure = new Error("synthetic cancellation");
      const operation = withProtectedProfileSkillTree(
        {
          forbidProfileSkillMarkdownWrites: true,
          orgId: "org",
          profileId: "profile",
        },
        root,
        async () => {
          await writeFile(skillPath, "changed");
          throw failure;
        }
      );
      await expect(operation).rejects.toBe(failure);
      expect(await readFile(skillPath, "utf8")).toBe("original");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("does not roll back a concurrent approved skill mutation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "atlas-skill-guard-"));
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      const skillPath = path.join(root, "skills", "notes", "SKILL.md");
      await mkdir(path.dirname(skillPath), { recursive: true });
      await writeFile(skillPath, "original");
      const shell = withProtectedProfileSkillTree(
        {
          forbidProfileSkillMarkdownWrites: true,
          orgId: "org",
          profileId: "profile",
        },
        root,
        async () => {
          started.resolve();
          await release.promise;
          return "finished";
        }
      );
      await started.promise;
      let approvedWriterEntered = false;
      const approved = withProfileSoulMutationLock(
        "org",
        "profile",
        async () => {
          approvedWriterEntered = true;
          await writeFile(skillPath, "approved revision");
        }
      );
      await Promise.resolve();
      expect(approvedWriterEntered).toBe(false);
      release.resolve();
      expect(await shell).toBe("finished");
      await approved;
      expect(await readFile(skillPath, "utf8")).toBe("approved revision");
    } finally {
      release.resolve();
      await rm(root, { force: true, recursive: true });
    }
  });

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

import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileTool, writeFileTool } from "./builtin";
import { executeProtectedTool } from "./execution";
import { guardFilePath } from "./paths";

async function withAliasedWorkspace(
  run: (paths: {
    physical: string;
    root: string;
    workspaceRoot: string;
  }) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "atlas-path-parent-"));
  try {
    const physical = path.join(await realpath(root), "physical");
    const alias = path.join(root, "alias");
    await mkdir(physical);
    await symlink(physical, alias);
    await run({
      physical,
      root,
      workspaceRoot: path.join(alias, "org", "profile"),
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("protected first write and dependent read work before an aliased profile directory exists", async () => {
  await withAliasedWorkspace(async ({ physical, workspaceRoot }) => {
    const context = {
      orgId: "path_test_org",
      orgRole: "member" as const,
      profileId: "path_test_profile",
      userId: "path_test_user",
      workspaceRoot,
    };
    const content = "atlas-first-file";
    const written = await executeProtectedTool(
      writeFileTool,
      { content, path: "artifacts/first.txt" },
      context
    );
    expect(written.success).toBe(true);
    expect(written.data?.path).toBe(
      path.join(physical, "org", "profile", "artifacts", "first.txt")
    );
    const read = await executeProtectedTool(
      readFileTool,
      { offset: 1, path: written.data?.path ?? "missing" },
      context
    );
    expect(read.success).toBe(true);
    expect(read.data?.content).toBe(content);
    expect(read.data?.truncated).toBe(false);
    expect(await readFile(written.data!.path, "utf8")).toBe(content);
  });
});

test("an explicit absent allowed directory resolves through the same real parent as its target", async () => {
  await withAliasedWorkspace(async ({ physical, workspaceRoot }) => {
    const guarded = await guardFilePath("nested/file.txt", null, 1, {
      allowedDirs: [workspaceRoot],
    });
    expect(guarded.resolved).toBe(
      path.join(physical, "org", "profile", "nested", "file.txt")
    );
  });
});

test("canonicalizing an absent workspace still rejects sibling traversal", async () => {
  await withAliasedWorkspace(async ({ physical, workspaceRoot }) => {
    for (const target of [
      "../sibling/private.txt",
      path.join(physical, "org", "sibling", "private.txt"),
    ]) {
      await expect(
        guardFilePath(target, null, 1, { cwd: workspaceRoot })
      ).rejects.toMatchObject({ code: "TRAVERSAL" });
    }
  });
});

test("an existing link inside an aliased workspace cannot expose another directory", async () => {
  await withAliasedWorkspace(async ({ root, workspaceRoot }) => {
    const outside = path.join(root, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "private.txt"), "unchanged");
    await mkdir(workspaceRoot, { recursive: true });
    await symlink(outside, path.join(workspaceRoot, "escape"));
    await expect(
      guardFilePath("escape/private.txt", null, 1, { cwd: workspaceRoot })
    ).rejects.toMatchObject({ code: "TRAVERSAL" });
    await expect(
      guardFilePath("escape/new.txt", null, 1, { cwd: workspaceRoot })
    ).rejects.toMatchObject({ code: "TRAVERSAL" });
    expect(await readFile(path.join(outside, "private.txt"), "utf8")).toBe(
      "unchanged"
    );
  });
});

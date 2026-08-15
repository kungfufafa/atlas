import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolContext } from "../contract";
import {
  copyFileTool,
  createDirectoryTool,
  fileStatTool,
  listDirectoryTool,
  moveFileTool,
  runCopyFile,
  runCreateDirectory,
  runFileStat,
  runListDirectory,
  runMoveFile,
} from "./filesystem";

describe("filesystem tools", () => {
  async function withTempWorkspace<T>(
    fn: (workspaceRoot: string, context: ToolContext) => Promise<T>
  ): Promise<T> {
    const dir = await mkdtemp(path.join(tmpdir(), "atlas-fs-test-"));
    const context: ToolContext = {
      orgId: "org_test",
      profileId: "profile_test",
      workspaceRoot: dir,
    };
    try {
      return await fn(dir, context);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  }

  test("create_directory creates nested directories", async () => {
    await withTempWorkspace(async (workspaceRoot, context) => {
      const res = await runCreateDirectory(
        { path: "nested/sub/folder" },
        context,
        { workspaceRoot }
      );
      expect(res.created).toBe(true);
      expect(res.path).toBe("nested/sub/folder");

      const statRes = await runFileStat(
        { path: "nested/sub/folder" },
        context,
        { workspaceRoot }
      );
      expect(statRes.exists).toBe(true);
      expect(statRes.isDirectory).toBe(true);
      expect(statRes.isFile).toBe(false);
    });
  });

  test("list_directory lists files and directories with metadata", async () => {
    await withTempWorkspace(async (workspaceRoot, context) => {
      await writeFile(path.join(workspaceRoot, "hello.txt"), "hello world");
      await writeFile(path.join(workspaceRoot, "notes.md"), "# Notes");
      await runCreateDirectory({ path: "docs" }, context, { workspaceRoot });
      await writeFile(
        path.join(workspaceRoot, "docs", "guide.txt"),
        "guidance"
      );

      const res = await runListDirectory({ path: "." }, context, {
        workspaceRoot,
      });
      expect(res.entries.length).toBe(3);
      const names = res.entries.map((e) => e.name);
      expect(names).toContain("hello.txt");
      expect(names).toContain("notes.md");
      expect(names).toContain("docs");

      const helloEntry = res.entries.find((e) => e.name === "hello.txt");
      expect(helloEntry?.isFile).toBe(true);
      expect(helloEntry?.size).toBe(11);

      // Test recursive
      const recRes = await runListDirectory(
        { path: ".", recursive: true },
        context,
        { workspaceRoot }
      );
      const recPaths = recRes.entries.map((e) => e.path);
      expect(recPaths).toContain(path.join("docs", "guide.txt"));
    });
  });

  test("file_stat returns detailed metadata for existing and non-existing paths", async () => {
    await withTempWorkspace(async (workspaceRoot, context) => {
      await writeFile(path.join(workspaceRoot, "sample.txt"), "12345");

      const existsRes = await runFileStat({ path: "sample.txt" }, context, {
        workspaceRoot,
      });
      expect(existsRes.exists).toBe(true);
      expect(existsRes.isFile).toBe(true);
      expect(existsRes.isDirectory).toBe(false);
      expect(existsRes.size).toBe(5);
      expect(existsRes.name).toBe("sample.txt");

      const missingRes = await runFileStat(
        { path: "does-not-exist.txt" },
        context,
        {
          workspaceRoot,
        }
      );
      expect(missingRes.exists).toBe(false);
      expect(missingRes.size).toBe(0);
    });
  });

  test("copy_file copies a file and respects overwrite setting", async () => {
    await withTempWorkspace(async (workspaceRoot, context) => {
      await writeFile(path.join(workspaceRoot, "source.txt"), "copy content");

      const copyRes = await runCopyFile(
        { destinationPath: "copied/target.txt", sourcePath: "source.txt" },
        context,
        { workspaceRoot }
      );
      expect(copyRes.bytesCopied).toBe(12);

      const targetStat = await runFileStat(
        { path: "copied/target.txt" },
        context,
        { workspaceRoot }
      );
      expect(targetStat.exists).toBe(true);
      expect(targetStat.size).toBe(12);

      // Overwrite without flag fails
      await expect(
        runCopyFile(
          { destinationPath: "copied/target.txt", sourcePath: "source.txt" },
          context,
          { workspaceRoot }
        )
      ).rejects.toThrow("already exists");

      // Overwrite with flag succeeds
      await writeFile(path.join(workspaceRoot, "source.txt"), "new copy");
      await runCopyFile(
        {
          destinationPath: "copied/target.txt",
          overwrite: true,
          sourcePath: "source.txt",
        },
        context,
        { workspaceRoot }
      );
      const updatedStat = await runFileStat(
        { path: "copied/target.txt" },
        context,
        { workspaceRoot }
      );
      expect(updatedStat.size).toBe(8);
    });
  });

  test("move_file moves/renames a file", async () => {
    await withTempWorkspace(async (workspaceRoot, context) => {
      await writeFile(path.join(workspaceRoot, "old-name.txt"), "move content");

      const moveRes = await runMoveFile(
        { destinationPath: "new-name.txt", sourcePath: "old-name.txt" },
        context,
        { workspaceRoot }
      );
      expect(moveRes.moved).toBe(true);

      const oldStat = await runFileStat({ path: "old-name.txt" }, context, {
        workspaceRoot,
      });
      expect(oldStat.exists).toBe(false);

      const newStat = await runFileStat({ path: "new-name.txt" }, context, {
        workspaceRoot,
      });
      expect(newStat.exists).toBe(true);
      expect(newStat.size).toBe(12);
    });
  });

  test("rejects path traversal attacks", async () => {
    await withTempWorkspace(async (workspaceRoot, context) => {
      await expect(
        runCreateDirectory({ path: "../outside-dir" }, context, {
          workspaceRoot,
        })
      ).rejects.toThrow();

      await expect(
        runFileStat({ path: "../../etc/passwd" }, context, { workspaceRoot })
      ).rejects.toThrow();

      await expect(
        runListDirectory({ path: "/etc" }, context, { workspaceRoot })
      ).rejects.toThrow();

      await expect(
        runCopyFile(
          { destinationPath: "file.txt", sourcePath: "/etc/passwd" },
          context,
          { workspaceRoot }
        )
      ).rejects.toThrow();
    });
  });

  test("tool definitions match interface", () => {
    expect(listDirectoryTool.name).toBe("list_directory");
    expect(listDirectoryTool.parallelSafe).toBe(true);
    expect(fileStatTool.name).toBe("file_stat");
    expect(fileStatTool.parallelSafe).toBe(true);
    expect(copyFileTool.name).toBe("copy_file");
    expect(moveFileTool.name).toBe("move_file");
    expect(createDirectoryTool.name).toBe("create_directory");
  });
});

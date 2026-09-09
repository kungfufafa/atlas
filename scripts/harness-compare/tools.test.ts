import { expect, test } from "bun:test";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  calculate,
  executeSharedTool,
  initializeFiles,
  snapshotFiles,
} from "./tools";

async function workspace() {
  const parent = await mkdtemp(join(tmpdir(), "comparison-tools-test-"));
  const root = join(parent, "workspace");
  await initializeFiles(root, { "nested/input.txt": "source\n" });
  return { parent, root };
}

test("shared file tools preserve UTF-8 bytes, allow empty writes, and list relative paths", async () => {
  const { root } = await workspace();
  const content = "  α🙂\n\n";
  const written = await executeSharedTool(root, {}, "write_file", {
    content,
    path: "artifacts/result.txt",
  });
  expect(written.isError).not.toBe(true);
  expect(written.result).toEqual({
    bytes: Buffer.byteLength(content),
    path: "artifacts/result.txt",
  });
  expect(
    (
      await executeSharedTool(root, {}, "read_file", {
        path: "artifacts/result.txt",
      })
    ).result
  ).toEqual({ content, path: "artifacts/result.txt" });
  expect((await executeSharedTool(root, {}, "list_files", {})).result).toEqual({
    files: ["artifacts/result.txt", "nested/input.txt"],
  });
  expect(
    (await executeSharedTool(root, {}, "list_files", { path: "nested" })).result
  ).toEqual({ files: ["nested/input.txt"] });
  expect(
    (
      await executeSharedTool(root, {}, "write_file", {
        content: "",
        path: "artifacts/result.txt",
      })
    ).result
  ).toEqual({ bytes: 0, path: "artifacts/result.txt" });
  expect(await snapshotFiles(root)).toEqual({
    "artifacts/result.txt": "",
    "nested/input.txt": "source\n",
  });
});

test("read, write and list reject absolute paths, traversal and null bytes without changing outside files", async () => {
  const { parent, root } = await workspace();
  const outside = join(parent, "outside.txt");
  await writeFile(outside, "outside sentinel");
  for (const name of ["read_file", "write_file", "list_files"]) {
    for (const path of [
      "../outside.txt",
      outside,
      "nested/../../outside.txt",
      "bad\0path",
    ]) {
      const result = await executeSharedTool(root, {}, name, {
        ...(name === "write_file" ? { content: "changed" } : {}),
        path,
      });
      expect(result.isError).toBe(true);
      expect(result.result).toMatchObject({ success: false });
    }
  }
  expect(await readFile(outside, "utf8")).toBe("outside sentinel");
  expect(await snapshotFiles(root)).toEqual({ "nested/input.txt": "source\n" });
});

test("shared file tools reject symlink paths that lead outside the synthetic workspace", async () => {
  const { parent, root } = await workspace();
  const outside = join(parent, "outside.txt");
  await writeFile(outside, "outside sentinel");
  await symlink(outside, join(root, "escape.txt"));
  expect(
    (await executeSharedTool(root, {}, "read_file", { path: "escape.txt" }))
      .isError
  ).toBe(true);
  expect(
    (
      await executeSharedTool(root, {}, "write_file", {
        content: "changed",
        path: "escape.txt",
      })
    ).isError
  ).toBe(true);
  expect(await readFile(outside, "utf8")).toBe("outside sentinel");
  await expect(snapshotFiles(root)).rejects.toThrow();
});

test("file initialization cannot write outside the synthetic workspace", async () => {
  const { root } = await workspace();
  await expect(
    initializeFiles(root, { "../outside.txt": "forbidden" })
  ).rejects.toThrow();
  expect(await snapshotFiles(root)).toEqual({ "nested/input.txt": "source\n" });
});

test("missing files, unknown tools, extra arguments and oversized output return structured failures", async () => {
  const { root } = await workspace();
  for (const [name, args] of [
    ["read_file", { path: "missing.txt" }],
    ["not_a_tool", {}],
    ["read_file", { extra: true, path: "nested/input.txt" }],
    ["read_file", { path: "nested/input.txt", toString: "unexpected" }],
    ["read_file", { path: 3 }],
    ["write_file", { content: "x".repeat(1_000_001), path: "large.txt" }],
  ] as const) {
    const event = await executeSharedTool(root, {}, name, args);
    expect(event.isError).toBe(true);
    expect(event.result).toMatchObject({ success: false });
    expect(JSON.stringify(event.result)).not.toContain(root);
  }
  expect(await snapshotFiles(root)).toEqual({ "nested/input.txt": "source\n" });
});

test("arithmetic supports precedence, unary signs and finite decimals without executable syntax", () => {
  expect(calculate("1 + 2 * 3")).toBe(7);
  expect(calculate("(1 + 2) * -3")).toBe(-9);
  expect(calculate("1e3 / 4 + .5 - 11 % 3")).toBe(248.5);
  for (const expression of [
    "1 / 0",
    "0 / 0",
    "1e400",
    "2 ** 3",
    "Math.random()",
    "globalThis.process.exit()",
    "({}).constructor",
    "1; 2",
    "(".repeat(60) + "1" + ")".repeat(60),
    "1".repeat(2001),
  ]) {
    expect(() => calculate(expression)).toThrow();
  }
});

test("document fetch returns only the exact registered source and refuses unknown identifiers", async () => {
  const { root } = await workspace();
  const document = {
    content: "Authoritative source\n",
    title: "Synthetic source",
    url: "https://source.invalid/document",
  };
  const task = { documents: { known: document } };
  expect(
    (await executeSharedTool(root, task, "fetch_document", { id: "known" }))
      .result
  ).toEqual({ id: "known", ...document });
  expect(
    (await executeSharedTool(root, task, "fetch_document", { id: "unknown" }))
      .isError
  ).toBe(true);
  expect(
    (await executeSharedTool(root, task, "fetch_document", { id: "toString" }))
      .isError
  ).toBe(true);
});

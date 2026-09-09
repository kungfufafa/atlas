import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cases from "./file-delivery-cases.json";
import { verifyMarkdownDependency } from "./file-markdown-dependency";
import dependency from "./file-markdown-dependency.json";
import { selectFileDelivery } from "./file-run";

const workspaceRoot = "/private/tmp/general-delivery/workspace";
for (const item of cases.cases) {
  test(`Markdown delivery: ${item.name}`, () => {
    const selected = selectFileDelivery(
      { finalText: item.text, workspaceRoot },
      "document"
    );
    expect(selected.candidates).toEqual(item.expected);
    expect(selected.path).toBe(
      item.selection === null || item.invalid ? null : item.expected[0]!
    );
    expect(selected.invalidCandidates.length > 0).toBe(item.invalid === true);
  });
}

test("strong, list and reference-link syntax preserve one visible path", () => {
  const selected = selectFileDelivery(
    {
      finalText:
        "- **artifacts/report.txt**\n- [Result][download]\n\n[download]: artifacts/report.txt",
      workspaceRoot,
    },
    "document"
  );
  expect(selected.candidates).toEqual(["artifacts/report.txt"]);
  expect(selected.path).toBe("artifacts/report.txt");
});

test("pinned existing parser bytes are checked before source capture", async () => {
  await verifyMarkdownDependency();
  const directory = await mkdtemp(
    join(tmpdir(), "delivery-parser-dependency-")
  );
  for (const name of Object.keys(dependency.files)) {
    await writeFile(
      join(directory, name),
      await readFile(join(import.meta.dir, name))
    );
  }
  await verifyMarkdownDependency(directory);
  await writeFile(
    join(directory, "file-markdown-vendor.mjs"),
    "export const altered = true;"
  );
  await expect(verifyMarkdownDependency(directory)).rejects.toThrow();
});

test("visible bare-path text joins formatting and escaped punctuation without inventing candidates", () => {
  for (const finalText of [
    "artifacts/my**report**.txt",
    "artifacts/my\\[draft\\].txt",
  ]) {
    const selected = selectFileDelivery(
      { finalText, workspaceRoot },
      "document"
    );
    expect(selected.path).toBe(
      finalText.includes("draft")
        ? "artifacts/my[draft].txt"
        : "artifacts/myreport.txt"
    );
    expect(selected.candidates.length).toBe(1);
  }
});

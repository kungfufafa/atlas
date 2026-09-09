import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PDFDocument, PDFName } from "pdf-lib";
import type { ToolContext } from "../contract";
import {
  fileAssetRevision,
  loadFileAsset,
  saveFileArtifact,
} from "../files/assets";
import { fileAssetTool } from "./file-asset";
import { pdfDocumentTool } from "./pdf-document";

let root: string;
let context: ToolContext;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "atlas-pdf-test-"));
  context = { workspaceRoot: root };
});
afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

interface PdfResult {
  artifacts: { path: string; pageCount: number }[];
  complete: boolean;
  coveredPages: number[];
  form: {
    complete: boolean;
    nextStart: number | null;
    totalFields: number;
    fields: Array<{
      name: string;
      value: unknown;
      type: string;
      truncated: boolean;
    }>;
  };
  formFieldsExcluded: boolean;
  nextPage: number | null;
  pageCount: number;
  pages: { text: string; page: number; truncated: boolean }[];
  path: string;
}

async function run(input: unknown): Promise<PdfResult> {
  return (await pdfDocumentTool.run(input, context)) as PdfResult;
}

test("create, merge, split and extract real PDFs preserve ordered content and originals", async () => {
  const first = await run({
    operation: "create",
    outputFilename: "first.pdf",
    textPages: ["Jakarta alpha", "Bandung beta"],
  });
  const second = await run({
    operation: "create",
    outputFilename: "second.pdf",
    textPages: ["Surabaya gamma"],
  });
  const original = await readFile(path.join(root, first.path));
  const merged = await run({
    operation: "merge",
    sources: [first.path, second.path],
  });
  expect(merged.pageCount).toBe(3);
  const split = await run({
    documentRef: merged.path,
    groups: [[3, 1], [2]],
    operation: "split",
  });
  expect(
    split.artifacts.map((artifact: { pageCount: number }) => artifact.pageCount)
  ).toEqual([2, 1]);
  const extracted = await run({
    documentRef: split.artifacts[0].path,
    operation: "extract",
  });
  expect(extracted.pages[0].text).toContain("Surabaya gamma");
  expect(extracted.pages[1].text).toContain("Jakarta alpha");
  expect(extracted.complete).toBe(true);
  expect(await readFile(path.join(root, first.path))).toEqual(original);
});

test("filled PDF form values are read separately from ordinary page text", async () => {
  const document = await PDFDocument.create();
  const page = document.addPage();
  page.drawText("Customer:", { x: 40, y: 700 });
  const field = document.getForm().createTextField("customer");
  field.setText("Ada Example");
  field.addToPage(page, { height: 30, width: 250, x: 40, y: 650 });
  const original = Buffer.from(await document.save());
  await writeFile(path.join(root, "form.pdf"), original);

  const extracted = await run({
    documentRef: "form.pdf",
    operation: "extract",
  });
  expect(extracted.pages[0].text).toContain("Customer:");
  expect(extracted.coveredPages).toEqual([1]);
  expect(extracted.formFieldsExcluded).toBe(false);
  expect(extracted.form.fields).toMatchObject([
    { name: "customer", type: "text", value: "Ada Example" },
  ]);
  expect(extracted.complete).toBe(true);
  expect(await readFile(path.join(root, "form.pdf"))).toEqual(original);
  expect(await readdir(root)).not.toContain("artifacts");
});

test("PDF form pagination and bounded values never overstate coverage", async () => {
  const document = await PDFDocument.create();
  const page = document.addPage();
  const form = document.getForm();
  form.createTextField("customer").setText("Ada Example");
  const approved = form.createCheckBox("approved");
  approved.addToPage(page, { height: 15, width: 15, x: 20, y: 700 });
  approved.check();
  const choices = form.createDropdown("choice");
  choices.addOptions(["One", "Two"]);
  choices.select("Two");
  form.createTextField("large").setText("x".repeat(5000));
  await writeFile(path.join(root, "fields.pdf"), await document.save());
  const first = await run({
    documentRef: "fields.pdf",
    fieldLimit: 2,
    operation: "inspect",
  });
  expect(first.form.complete).toBe(false);
  expect(first.form.nextStart).toBe(3);
  expect(first.form.fields.map((field) => field.value)).toEqual([
    "Ada Example",
    true,
  ]);
  const second = await run({
    documentRef: "fields.pdf",
    fieldStart: 3,
    operation: "inspect",
  });
  expect(second.form.fields[0]!.value).toEqual(["Two"]);
  expect(second.form.fields[1]!.truncated).toBe(true);
  expect(
    Buffer.byteLength(String(second.form.fields[1]!.value))
  ).toBeLessThanOrEqual(4000);
  expect(second.form.complete).toBe(false);
});

test("attachments materialize exact bytes and concurrent outputs never overwrite", async () => {
  const original = Buffer.from("id,value\n00123,9007199254740993\n");
  context.loadAttachment = async (id) =>
    id === "att_source"
      ? { bytes: original, filename: "data.csv", mediaType: "text/csv" }
      : null;
  const results = (await Promise.all(
    Array.from({ length: 4 }, () =>
      fileAssetTool.run(
        { documentRef: "att_source", operation: "materialize" },
        context
      )
    )
  )) as { path: string; revision: string }[];
  expect(new Set(results.map((result) => result.path)).size).toBe(4);
  for (const result of results) {
    expect(await readFile(path.join(root, result.path))).toEqual(original);
    expect(result.revision).toBe(fileAssetRevision(original));
  }
  expect(
    (await readdir(path.join(root, ".sources"))).some((name) =>
      name.endsWith(".tmp")
    )
  ).toBe(false);
  await expect(
    fileAssetTool.run(
      { documentRef: "att_other", operation: "inspect" },
      context
    )
  ).rejects.toThrow();
});

test("bounds, invalid page selection and form copying fail before publishing output", async () => {
  const created = await run({ operation: "create", textPages: ["Alpha"] });
  await expect(
    run({ documentRef: created.path, groups: [[1], [2]], operation: "split" })
  ).rejects.toThrow();
  expect(await readdir(path.join(root, "artifacts"))).toEqual(["document.pdf"]);
  const form = await PDFDocument.create();
  const page = form.addPage();
  form.getForm().createTextField("Customer").addToPage(page);
  await writeFile(path.join(root, "form.pdf"), await form.save());
  await expect(
    run({ operation: "merge", sources: [created.path, "form.pdf"] })
  ).rejects.toThrow();
  expect(await readdir(path.join(root, "artifacts"))).toEqual(["document.pdf"]);
});

test("split refuses independent PDF navigation and attachments before losing them", async () => {
  const original = await readFile(
    new URL("../testing/fixtures/pdf-navigation-pypdf.pdf", import.meta.url)
  );
  await writeFile(path.join(root, "navigable.pdf"), original);
  await expect(
    run({
      documentRef: "navigable.pdf",
      groups: [[1], [2]],
      operation: "split",
    })
  ).rejects.toThrow();
  expect(await readFile(path.join(root, "navigable.pdf"))).toEqual(original);
  expect(await readdir(root)).not.toContain("artifacts");
  const navigationOnly = await PDFDocument.load(original);
  navigationOnly.catalog.delete(PDFName.of("Outlines"));
  navigationOnly.catalog.delete(PDFName.of("Names"));
  await writeFile(
    path.join(root, "internal-link.pdf"),
    await navigationOnly.save()
  );
  await expect(
    run({ documentRef: "internal-link.pdf", groups: [[1]], operation: "split" })
  ).rejects.toThrow();
  expect(await readdir(root)).not.toContain("artifacts");
});

test("file asset guards reject traversal, external symlinks, oversized sources and cancelled writes", async () => {
  await symlink("/etc/hosts", path.join(root, "outside.txt"));
  await expect(
    loadFileAsset("outside.txt", context, { maxBytes: 1000 })
  ).rejects.toThrow();
  await expect(
    loadFileAsset("../outside.txt", context, { maxBytes: 1000 })
  ).rejects.toThrow();
  await writeFile(path.join(root, "large.txt"), "123456");
  await expect(
    loadFileAsset("large.txt", context, { maxBytes: 5 })
  ).rejects.toThrow();
  await expect(
    saveFileArtifact({
      bytes: Buffer.from("x"),
      context,
      filename: "../escape.pdf",
    })
  ).rejects.toThrow();
  await expect(
    saveFileArtifact({
      bytes: Buffer.from("x"),
      context: { ...context, signal: AbortSignal.abort() },
      filename: "cancelled.pdf",
    })
  ).rejects.toThrow();
  expect(await readdir(root)).not.toContain("artifacts");
});

test("PDF creation paginates long text and partial extraction states page coverage", async () => {
  const output = await run({
    operation: "create",
    textPages: [
      Array.from(
        { length: 120 },
        (_, index) => `Line ${index + 1}: laporan harian`
      ).join("\n"),
    ],
  });
  expect(output.pageCount).toBe(3);
  const extracted = await run({
    documentRef: output.path,
    operation: "extract",
    pages: [2],
  });
  expect(extracted.coveredPages).toEqual([2]);
  expect(extracted.complete).toBe(false);
  expect(extracted.nextPage).toBe(1);
  expect(extracted.pages[0].text).toContain("laporan harian");
});

test("PDF page bound applies across text sections before an artifact is published", async () => {
  await expect(
    run({
      operation: "create",
      textPages: ["\n".repeat(47 * 500 - 1), "Overflow section"],
    })
  ).rejects.toThrow();
  expect(await readdir(root)).not.toContain("artifacts");
});

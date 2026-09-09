import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runPdfRuntime } from "../../packages/core/src/files/pdf-runtime";
import { pdfDocumentTool } from "../../packages/core/src/tools/pdf-document";

// Explicit dependency gate: missing Python libraries, fonts or OCR binaries fail.
const python = process.env.ATLAS_PYTHON_PATH || "python3";
const fontPath = process.argv[2];
if (!fontPath) {
  throw new Error(
    "Pass an absolute TrueType font path covering Latin and Arabic. Pass --cjk if it also covers CJK."
  );
}
const text = `Révision approuvée — تمت المراجعة${process.argv.includes("--cjk") ? " — 東京" : ""}`;
const root = await mkdtemp(path.join(tmpdir(), "atlas-pdf-check-"));
const context = { workspaceRoot: root };
const fixture = (name: string) =>
  path.join(import.meta.dir, "../../packages/core/src/testing/fixtures", name);
async function run(input: unknown) {
  return (await pdfDocumentTool.run(input, context)) as {
    path: string;
    complete: boolean;
    pages: {
      page: number;
      text: string;
      method?: string;
      ocrConfidence?: number;
    }[];
  };
}
try {
  await copyFile(
    fixture("pdf-navigation-pypdf.pdf"),
    path.join(root, "navigation.pdf")
  );
  await copyFile(
    fixture("pdf-scanned-reportlab.pdf"),
    path.join(root, "scan.pdf")
  );
  await copyFile(fontPath, path.join(root, "covering.ttf"));
  const original = await readFile(path.join(root, "navigation.pdf"));
  const merged = await run({
    operation: "merge",
    sources: ["navigation.pdf", "navigation.pdf"],
  });
  const scanned = await run({ documentRef: "scan.pdf", operation: "extract" });
  assert.equal(scanned.pages[0]?.text, "SCAN REVIEW 8642");
  assert.equal(scanned.pages[0]?.method, "ocr");
  assert.ok((scanned.pages[0]?.ocrConfidence ?? 0) > 70);
  assert.equal(scanned.complete, true);
  const textOnly = await run({
    documentRef: "scan.pdf",
    ocr: "off",
    operation: "extract",
  });
  assert.equal(textOnly.complete, false);
  assert.equal(textOnly.pages[0]?.text, "");
  const generated = await run({
    fontRef: "covering.ttf",
    operation: "create",
    textPages: [text],
  });
  const oracle = Bun.spawn(
    [
      python,
      "-I",
      "-c",
      `
import json, sys
from pypdf import PdfReader
merged = PdfReader(sys.argv[1])
assert len(merged.pages) == 4
assert len(merged.outline) == 4
attachments = list(merged.attachment_list)
assert len(attachments) == 2
assert all(a.name == 'supporting.txt' and a.content == b'Keep this exact attachment.' for a in attachments)
for page, target in [(0,1),(2,3)]:
    dest = merged.pages[page]['/Annots'][0].get_object()['/Dest']
    assert merged.get_page_number(dest[0].get_object()) == target
created = PdfReader(sys.argv[2])
assert created.pages[0].extract_text() == sys.argv[3]
print(json.dumps({'navigationTargets':[1,3],'outlines':4,'attachments':2,'text':sys.argv[3]}))
`,
      path.join(root, merged.path),
      path.join(root, generated.path),
      text,
    ],
    { stderr: "pipe", stdout: "pipe" }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(oracle.stdout).text(),
    new Response(oracle.stderr).text(),
    oracle.exited,
  ]);
  assert.equal(code, 0, stderr);
  assert.deepEqual(await readFile(path.join(root, "navigation.pdf")), original);
  await assert.rejects(
    runPdfRuntime(
      { operation: "merge" },
      [original, original],
      AbortSignal.abort()
    )
  );
  await writeFile(path.join(root, "broken.ttf"), "not a font");
  await assert.rejects(
    run({ fontRef: "broken.ttf", operation: "create", textPages: [text] })
  );
  console.log(
    JSON.stringify({
      evidenceClass:
        "actual local PDF/OCR processes and independent pypdf oracle",
      fontBytes: (await readFile(fontPath)).length,
      ocr: scanned.pages,
      preservation: JSON.parse(stdout),
      sourceUnchanged: true,
      status: "passed",
    })
  );
} finally {
  await rm(root, { force: true, recursive: true });
}

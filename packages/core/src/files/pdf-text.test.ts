import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PDFDocument } from "pdf-lib";
import { extractPdfPageText } from "./pdf-text";

const fixture = (name: string) =>
  readFile(new URL(`../testing/fixtures/${name}`, import.meta.url));

test("real LibreOffice text PDF is readable and a real scanned page is explicitly incomplete", async () => {
  const text = await extractPdfPageText(
    await fixture("pdf-libreoffice-report.pdf"),
    [1]
  );
  expect(text[0]!.text).toContain("Total units: 18");
  expect(text[0]!.needsOcr).toBe(false);
  const scan = await extractPdfPageText(
    await fixture("pdf-scanned-reportlab.pdf"),
    [1]
  );
  expect(scan).toEqual([
    { needsOcr: true, page: 1, text: "", truncated: false },
  ]);
});

test("PDF text worker bounds Unicode output and terminates on timeout and cancellation", async () => {
  const document = await PDFDocument.create();
  const page = document.addPage();
  for (let index = 0; index < 200; index += 1) {
    page.drawText("Café ".repeat(20), { x: 20, y: 800 - index });
  }
  const bytes = await document.save();
  const result = await extractPdfPageText(bytes, [1]);
  expect(result[0]!.truncated).toBe(true);
  expect(Buffer.byteLength(result[0]!.text)).toBeLessThanOrEqual(8000);
  expect(result[0]!.text).not.toContain("�");
  await expect(
    extractPdfPageText(bytes, [1], { timeoutMs: 1 })
  ).rejects.toThrow();
  const controller = new AbortController();
  const pending = extractPdfPageText(bytes, [1], { signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 30);
  try {
    await expect(pending).rejects.toThrow();
  } finally {
    clearTimeout(timer);
  }
  // Worker capacity is released only after exit/cleanup, so cancellation must
  // not leave a ghost operation occupying the bounded parser pool.
  const next = await extractPdfPageText(
    await fixture("pdf-libreoffice-report.pdf"),
    [1]
  );
  expect(next[0]!.text).toContain("Total units: 18");
});

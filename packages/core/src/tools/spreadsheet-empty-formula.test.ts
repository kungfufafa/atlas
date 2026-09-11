import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { unzipSync } from "fflate";
import { spreadsheetTool } from "./spreadsheet";
import { restoreEmptyFormulaResults } from "./spreadsheet-ooxml";
import { recalculateSpreadsheet } from "./spreadsheet-recalculation";

async function formulaFixture() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Results");
  sheet.getCell("A1").value = { formula: 'IF(1=1,"","x")', result: "" };
  sheet.getCell("B1").value = { formula: "1-1", result: 0 };
  sheet.getCell("C1").value = { formula: "1=2", result: false };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test("explicit empty string formula caches survive load without inventing missing numeric caches", async () => {
  const bytes = await formulaFixture();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
  expect(workbook.worksheets[0]!.getCell("A1").result).toBeUndefined();
  restoreEmptyFormulaResults(workbook, unzipSync(bytes));
  expect(workbook.worksheets[0]!.getCell("A1").result).toBe("");
  expect(workbook.worksheets[0]!.getCell("B1").result).toBe(0);
  expect(workbook.worksheets[0]!.getCell("C1").result).toBe(false);
});

test("recalculation verification and subsequent reads accept a calculated empty string", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "atlas-empty-formula-"));
  try {
    // Deterministic converter transport: return fixture cache bytes. This exercises
    // verification without depending on a system LibreOffice installation.
    const converter = path.join(root, "converter.sh");
    await writeFile(
      converter,
      '#!/bin/sh\nfor input do :; done\ncp "$input" output/workbook.xlsx\n',
      { mode: 0o700 }
    );
    const calculated = await recalculateSpreadsheet(
      await formulaFixture(),
      undefined,
      async () => converter
    );
    expect(calculated.formulaErrorCount).toBe(0);
    await writeFile(path.join(root, "results.xlsx"), calculated.bytes);
    const read = await spreadsheetTool.run(
      { action: "read_range", path: "results.xlsx", range: "A1:C1" },
      { workspaceRoot: root }
    );
    expect(read).toMatchObject({
      rows: [
        [
          { cachedResult: "", calculationStatus: "unverified" },
          { cachedResult: 0 },
          { cachedResult: false },
        ],
      ],
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      Uint8Array.from(await readFile(path.join(root, "results.xlsx"))).buffer
    );
    workbook.worksheets[0]!.getCell("D1").value = { formula: "UNSUPPORTED()" };
    await expect(
      recalculateSpreadsheet(
        Buffer.from(await workbook.xlsx.writeBuffer()),
        undefined,
        async () => converter
      )
    ).rejects.toThrow();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

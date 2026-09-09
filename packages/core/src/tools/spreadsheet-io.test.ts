import { expect, test } from "bun:test";
import ExcelJS from "exceljs";
import { unzipSync, zipSync } from "fflate";
import { inspectSpreadsheetArchive } from "./spreadsheet-io";

test("spreadsheet preflight validates actual expansion before handing a ZIP to ExcelJS", async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Tasks").addRow([1, 2, 3]);
  const original = new Uint8Array(await workbook.xlsx.writeBuffer());
  expect(() => inspectSpreadsheetArchive(original)).not.toThrow();
  const parts = unzipSync(original);
  parts["xl/oversized.bin"] = new Uint8Array(2 * 1024 * 1024).fill(65);
  const forged = zipSync(parts);
  const view = new DataView(
    forged.buffer,
    forged.byteOffset,
    forged.byteLength
  );
  let altered = false;
  for (let offset = 0; offset < forged.length - 46; offset += 1) {
    if (view.getUint32(offset, true) !== 0x02_01_4b_50) {
      continue;
    }
    const nameLength = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(
      forged.subarray(offset + 46, offset + 46 + nameLength)
    );
    if (name === "xl/oversized.bin") {
      view.setUint32(offset + 24, 64, true);
      altered = true;
    }
  }
  expect(altered).toBe(true);
  expect(() => inspectSpreadsheetArchive(forged)).toThrow();
});

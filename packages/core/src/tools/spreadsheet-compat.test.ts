import { expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { officeConverter } from "../artifact-preview/office-converter";
import { elements, parseXml } from "../office-document/xml";
import { executeProtectedTool } from "./execution";
import { spreadsheetTool } from "./spreadsheet";
import { spreadsheetBytesForExcelJs } from "./spreadsheet-compat";
import { inspectSpreadsheetArchive } from "./spreadsheet-io";

test("protected spreadsheet output reopens through the same symlink workspace alias", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "atlas-sheet-alias-"));
  try {
    const physical = path.join(directory, "physical");
    const alias = path.join(directory, "alias");
    await mkdir(physical);
    await symlink(physical, alias);
    const context = { workspaceRoot: alias };
    const created = await executeProtectedTool(
      spreadsheetTool,
      {
        action: "create",
        data: [["00042", 7]],
        path: "test.xlsx",
      },
      context
    );
    expect(created.success).toBe(true);
    const output = created.data as { path: string };
    expect(output.path.startsWith("..")).toBe(false);
    expect(path.isAbsolute(output.path)).toBe(false);
    const read = await executeProtectedTool(
      spreadsheetTool,
      {
        action: "read_range",
        path: output.path,
        range: "A1:B1",
      },
      context
    );
    expect(read.success).toBe(true);
    expect((read.data as { rows: unknown[][] }).rows).toEqual([["00042", 7]]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("openpyxl plain comments, authors, validations and absolute table targets survive actual range writes", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "atlas-sheet-independent-")
  );
  try {
    for (const kind of ["comments", "table"]) {
      const filename = `spreadsheet-openpyxl-${kind}.xlsx`;
      const source = path.join(directory, filename);
      await copyFile(
        new URL(`../testing/fixtures/${filename}`, import.meta.url),
        source
      );
      const original = await readFile(source);
      const result = await executeProtectedTool(
        spreadsheetTool,
        {
          action: "write_range",
          path: filename,
          range: kind === "comments" ? "C2" : "B2",
          sheetName: kind === "comments" ? "Records" : "Table data",
          values: [[11]],
        },
        { workspaceRoot: directory }
      );
      expect(result.success).toBe(true);
      const output = await readFile(
        path.join(directory, (result.data as { path: string }).path)
      );
      expect(await readFile(source)).toEqual(original);
      const before = inspectSpreadsheetArchive(original);
      const after = inspectSpreadsheetArchive(output);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(
        Uint8Array.from(spreadsheetBytesForExcelJs(after)).buffer
      );
      if (kind === "comments") {
        const comment = Object.keys(after).find((name) =>
          /^xl\/comments\d+\.xml$/.test(name)
        )!;
        expect(after[comment]).toEqual(before["xl/comments/comment1.xml"]);
        const originalValidation = elements(
          parseXml(before["xl/worksheets/sheet1.xml"]!, "source")
            .documentElement,
          "dataValidations"
        )[0]!;
        const outputValidation = elements(
          parseXml(after["xl/worksheets/sheet1.xml"]!, "output")
            .documentElement,
          "dataValidations"
        )[0]!;
        expect(outputValidation.toString()).toBe(originalValidation.toString());
        const sheet = workbook.getWorksheet("Records")!;
        expect(sheet.getCell("C2").value).toBe(11);
        expect(sheet.getCell("A2").value).toBe("000042");
        expect(workbook.getWorksheet("Lookup")!.state).toBe("hidden");
      } else {
        const sheet = workbook.getWorksheet("Table data")!;
        expect(sheet.getCell("B2").value).toBe(11);
        expect(sheet.getTable("TasksTable").name).toBe("TasksTable");
        expect(sheet.conditionalFormattings.length).toBe(1);
        expect(sheet.getCell("B4").formula).toBe(
          "SUBTOTAL(109,TasksTable[Qty])"
        );
      }
    }
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test.skipIf(!(await officeConverter.resolveConverterBinary()))(
  "real recalculation preserves an independent workbook's color-scale definition and table total",
  async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "atlas-sheet-color-scale-")
    );
    try {
      const original = await readFile(
        new URL(
          "../testing/fixtures/spreadsheet-openpyxl-table.xlsx",
          import.meta.url
        )
      );
      const filename = path.join(directory, "input.xlsx");
      const { writeFile } = await import("node:fs/promises");
      await writeFile(filename, original);
      const context = { workspaceRoot: directory };
      const written = await executeProtectedTool(
        spreadsheetTool,
        {
          action: "write_range",
          path: "input.xlsx",
          range: "B2",
          sheetName: "Table data",
          values: [[12]],
        },
        context
      );
      expect(written.success).toBe(true);
      const recalculated = await executeProtectedTool(
        spreadsheetTool,
        {
          action: "recalculate",
          path: (written.data as { path: string }).path,
        },
        context
      );
      expect(recalculated.success).toBe(true);
      const output = await readFile(
        path.join(directory, (recalculated.data as { path: string }).path)
      );
      const read = (bytes: Uint8Array) =>
        elements(
          parseXml(
            inspectSpreadsheetArchive(bytes)["xl/worksheets/sheet1.xml"]!,
            "sheet"
          ).documentElement,
          "conditionalFormatting"
        )[0]!.toString();
      expect(read(output)).toBe(read(original));
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(Uint8Array.from(output).buffer);
      expect(workbook.getWorksheet("Table data")!.getCell("B4").result).toBe(
        17
      );
      expect(await readFile(filename)).toEqual(original);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  }
);

import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { spreadsheetTool } from "./spreadsheet";

async function withWorkbook(run: (root: string) => Promise<void>) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "atlas-batch-"))
  );
  try {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Assets").addRows([
      ["Asset", "Count"],
      ["Laptops", 10],
    ]);
    await workbook.xlsx.writeFile(path.join(root, "assets.xlsx"));
    await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("48 edits publish one version and preserve original values while applying layout", async () => {
  await withWorkbook(async (root) => {
    const before = await readFile(path.join(root, "assets.xlsx"));
    const operations = Array.from({ length: 47 }, (_, index) => ({
      action: "format_range",
      format: {
        bold: index === 0,
        columnWidth: 24,
        fillColor: "#1F4E78",
        fontColor: "#FFFFFF",
        fontSize: 14,
        rowHeight: 26,
      },
      range: `A${index + 1}:B${index + 1}`,
    }));
    const result = (await spreadsheetTool.run(
      {
        action: "batch_edit",
        operations: [
          { action: "write_range", range: "B2", values: [[12]] },
          ...operations,
        ],
        path: "assets.xlsx",
      },
      { workspaceRoot: root }
    )) as { path: string; operationsApplied: number };
    expect(result.operationsApplied).toBe(48);
    const outputDir = path.dirname(path.join(root, result.path));
    expect(
      (await readdir(outputDir)).filter(
        (file) =>
          file.endsWith(".xlsx") &&
          path.join(outputDir, file) !== path.join(root, "assets.xlsx")
      )
    ).toHaveLength(1);
    expect(result.path).not.toBe("assets.xlsx");
    expect(await readFile(path.join(root, "assets.xlsx"))).toEqual(before);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path.join(root, result.path));
    const sheet = workbook.getWorksheet("Assets")!;
    expect(sheet.getCell("B2").value).toBe(12);
    expect(sheet.getCell("A2").value).toBe("Laptops");
    expect(sheet.getColumn(1).width).toBe(24);
    expect(sheet.getRow(47).height).toBe(26);
    expect(sheet.getCell("B47").font.size).toBe(14);
    expect(sheet.getCell("A1").font.bold).toBe(true);
  });
});

test("a bad later operation cannot persist earlier writes, including in-place mode", async () => {
  await withWorkbook(async (root) => {
    const before = await readFile(path.join(root, "assets.xlsx"));
    const inspected = (await spreadsheetTool.run(
      { action: "inspect", path: "assets.xlsx" },
      { workspaceRoot: root }
    )) as { revision: string };
    for (const writeMode of ["versioned", "inplace"]) {
      await expect(
        spreadsheetTool.run(
          {
            action: "batch_edit",
            expectedRevision: inspected.revision,
            operations: [
              { action: "write_range", range: "B2", values: [[99]] },
              {
                action: "format_range",
                format: { bold: true },
                range: "A1",
                sheetName: "Missing",
              },
            ],
            path: "assets.xlsx",
            writeMode,
          },
          { workspaceRoot: root }
        )
      ).rejects.toThrow();
      expect(await readFile(path.join(root, "assets.xlsx"))).toEqual(before);
    }
  });
});

test("batch rejects nested paths, unbounded work, and edits to legacy inputs", async () => {
  await withWorkbook(async (root) => {
    const context = { workspaceRoot: root };
    for (const operations of [
      [{ action: "write_range", path: "../secret.xlsx", values: [[1]] }],
      [
        { action: "format_range", format: { bold: true }, range: "A1:J50000" },
        { action: "format_range", format: { bold: true }, range: "A1" },
      ],
      [],
    ]) {
      await expect(
        spreadsheetTool.run(
          { action: "batch_edit", operations, path: "assets.xlsx" },
          context
        )
      ).rejects.toThrow();
    }
    await expect(
      spreadsheetTool.run(
        {
          action: "batch_edit",
          operations: [{ action: "write_range", range: "A1", values: [[1]] }],
          path: "legacy.xls",
        },
        context
      )
    ).rejects.toThrow();
  });
});

test("batch inherits selected sheet and literal text defaults while allowing explicit operation overrides", async () => {
  await withWorkbook(async (root) => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(path.join(root, "assets.xlsx"));
    workbook.addWorksheet("Target");
    await workbook.xlsx.writeFile(path.join(root, "assets.xlsx"));
    const result = (await spreadsheetTool.run(
      {
        action: "batch_edit",
        literalStrings: true,
        operations: [
          { action: "write_range", range: "A1", values: [["=1+1"]] },
          {
            action: "write_range",
            literalStrings: false,
            range: "B2",
            sheetName: "Assets",
            values: [["=1+1"]],
          },
        ],
        path: "assets.xlsx",
        sheetName: "Target",
      },
      { workspaceRoot: root }
    )) as { path: string };
    const output = new ExcelJS.Workbook();
    await output.xlsx.readFile(path.join(root, result.path));
    expect(output.getWorksheet("Target")!.getCell("A1").value).toBe("=1+1");
    expect(output.getWorksheet("Assets")!.getCell("A1").value).toBe("Asset");
    expect(output.getWorksheet("Assets")!.getCell("B2").formula).toBe("1+1");
  });
});

import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { zipSync } from "fflate";
import { officeConverter } from "../artifact-preview/office-converter";
import type { ToolContext } from "../contract";
import { parseA1Range, spreadsheetTool } from "./spreadsheet";
import { parseSpreadsheetCsv } from "./spreadsheet-cells";
import { MAX_SPREADSHEET_BYTES, spreadsheetRevision } from "./spreadsheet-io";
import { recalculateSpreadsheet } from "./spreadsheet-recalculation";

interface SheetResult {
  calculationStatus?: string;
  csvEscapedCellCount?: number;
  engine?: string;
  formulaErrorCount?: number;
  hasMoreRows?: boolean;
  path: string;
  revision: string;
  rows?: unknown[][];
}

async function withWorkspace(
  operation: (
    context: ToolContext,
    run: (input: Record<string, unknown>) => Promise<SheetResult>
  ) => Promise<void>
) {
  const directory = await realpath(
    await mkdtemp(path.join(tmpdir(), "atlas-sheet-roundtrip-"))
  );
  const context: ToolContext = {
    orgId: "org_test",
    profileId: "profile_test",
    workspaceRoot: directory,
  };
  try {
    await operation(
      context,
      async (input) =>
        (await spreadsheetTool.run(input, context)) as SheetResult
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function openWorkbook(context: ToolContext, relative: string) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.join(context.workspaceRoot!, relative));
  return workbook;
}

test("CSV import and literal export preserve identifiers, quotes, multiline fields and blank cells", async () => {
  await withWorkspace(async (context, run) => {
    const original =
      'ID,Long ID,Quote,Lines,Expression,Code\r\n00123,12345678901234567890,"He said ""hi""","two\nlines",=1+1,-0042\r\n,,,,,\r\n  spaced  ,0.010,true,,end,';
    await writeFile(path.join(context.workspaceRoot!, "input.csv"), original);
    const imported = await run({
      action: "import_csv",
      csvPath: "input.csv",
      path: "data.xlsx",
    });
    const read = await run({
      action: "read_range",
      path: imported.path,
      range: "A1:F4",
    });
    expect(read.rows).toEqual(parseSpreadsheetCsv(original));
    const workbook = await openWorkbook(context, imported.path);
    expect(workbook.worksheets[0]!.getCell("A2").type).toBe(
      ExcelJS.ValueType.String
    );
    expect(workbook.worksheets[0]!.getCell("E2").formula).toBeUndefined();
    const exported = await run({
      action: "export_csv",
      escapeCsvFormulas: false,
      path: imported.path,
      targetCsvPath: "roundtrip.csv",
    });
    const csv = await readFile(
      path.join(context.workspaceRoot!, exported.path),
      "utf8"
    );
    expect(parseSpreadsheetCsv(csv)).toEqual(parseSpreadsheetCsv(original));
    expect(exported.csvEscapedCellCount).toBe(0);
    expect(
      await readFile(path.join(context.workspaceRoot!, "input.csv"), "utf8")
    ).toBe(original);
  });
});

test("CSV coercion is explicit and refuses numbers that lose identifier precision", () => {
  expect(parseSpreadsheetCsv("00123,0.25,true")).toEqual([
    ["00123", "0.25", "true"],
  ]);
  expect(
    parseSpreadsheetCsv("ID,Amount,Active\n00123,0.25,true", {
      columnTypes: ["number", "number", "boolean"],
      header: true,
    })
  ).toEqual([
    ["ID", "Amount", "Active"],
    [123, 0.25, true],
  ]);
  expect(() =>
    parseSpreadsheetCsv("12345678901234567890", { columnTypes: ["number"] })
  ).toThrow();
  expect(() =>
    parseSpreadsheetCsv("truthy", { columnTypes: ["boolean"] })
  ).toThrow();
  expect(() => parseSpreadsheetCsv('id,"unterminated')).toThrow();
});

test("new CSV workbooks size text IDs and wrap multiline cells without restyling existing workbooks", async () => {
  await withWorkspace(async (context, run) => {
    await writeFile(
      path.join(context.workspaceRoot!, "layout.csv"),
      'ID,Long ID,Description,Expression\n00012,12345678901234567890,"café; 東京\nsecond line",=SUM(A1:A2)\n'
    );
    const imported = await run({
      action: "import_csv",
      csvPath: "layout.csv",
      path: "layout.xlsx",
    });
    const workbook = await openWorkbook(context, imported.path);
    const sheet = workbook.worksheets[0]!;
    expect(sheet.getColumn(2).width).toBeGreaterThanOrEqual(22);
    expect(sheet.getCell("C2").alignment.wrapText).toBe(true);
    expect(sheet.getRow(2).height).toBeGreaterThanOrEqual(36);
    expect(sheet.getCell("B2").value).toBe("12345678901234567890");
    sheet.getColumn(2).width = 31;
    sheet.getRow(2).height = 55;
    const existing = path.join(context.workspaceRoot!, "existing.xlsx");
    await workbook.xlsx.writeFile(existing);
    const updated = await run({
      action: "write_range",
      path: "existing.xlsx",
      range: "A2",
      values: [["00013"]],
    });
    const changed = (await openWorkbook(context, updated.path)).worksheets[0]!;
    expect(changed.getColumn(2).width).toBe(31);
    expect(changed.getRow(2).height).toBe(55);
  });
});

test("explicit comma-decimal CSV numbers preserve text IDs and reject ambiguous grouping or precision loss", () => {
  expect(
    parseSpreadsheetCsv("ID;Amount\n00012;12,50\n00013;-0,75", {
      columnTypes: ["text", "number"],
      decimalSeparator: ",",
      delimiter: ";",
      header: true,
    })
  ).toEqual([
    ["ID", "Amount"],
    ["00012", 12.5],
    ["00013", -0.75],
  ]);
  for (const number of ["1.234,50", "1,234,50", "12345678901234567,89"]) {
    expect(() =>
      parseSpreadsheetCsv(number, {
        columnTypes: ["number"],
        decimalSeparator: ",",
        delimiter: ";",
      })
    ).toThrow();
  }
  expect(
    parseSpreadsheetCsv("00012;12,50", {
      decimalSeparator: ",",
      delimiter: ";",
    })
  ).toEqual([["00012", "12,50"]]);
});

test("create and write store formulas consistently while literalStrings preserves expressions as text", async () => {
  await withWorkspace(async (context, run) => {
    const created = await run({
      action: "create",
      data: [[2, "=A1*3"]],
      path: "formulas.xlsx",
    });
    const updated = await run({
      action: "write_range",
      path: created.path,
      range: "C1",
      values: [["=B1+1"]],
    });
    const literal = await run({
      action: "write_range",
      literalStrings: true,
      path: updated.path,
      range: "D1",
      values: [["=B1+1"]],
    });
    const workbook = await openWorkbook(context, literal.path);
    const sheet = workbook.worksheets[0]!;
    expect(sheet.getCell("B1").formula).toBe("A1*3");
    expect(sheet.getCell("C1").formula).toBe("B1+1");
    expect(sheet.getCell("D1").value).toBe("=B1+1");
    expect(sheet.getCell("B1").result).toBeUndefined();
    expect(created.path).not.toBe(updated.path);
    expect(updated.path).not.toBe(literal.path);
    expect(
      (await openWorkbook(context, created.path)).worksheets[0]!.getCell("C1")
        .value
    ).toBeNull();
  });
});

test("editing an input invalidates stale formula caches and CSV exports typed cells without object corruption", async () => {
  await withWorkspace(async (context, run) => {
    const source = new ExcelJS.Workbook();
    const sheet = source.addWorksheet("Data");
    sheet.getCell("A1").value = 2;
    sheet.getCell("B1").value = { formula: "A1*3", result: 6 };
    sheet.getCell("C1").value = -3;
    sheet.getCell("D1").value = { richText: [{ text: 'a "quote"' }] };
    sheet.getCell("E1").value = {
      hyperlink: "https://example.com",
      text: "Link title",
    };
    await mkdir(path.join(context.workspaceRoot!, "artifacts"));
    const sourcePath = path.join(
      context.workspaceRoot!,
      "artifacts",
      "cached.xlsx"
    );
    await source.xlsx.writeFile(sourcePath);
    const originalBytes = await readFile(sourcePath);
    const stale = await run({
      action: "read_range",
      path: "cached.xlsx",
      range: "B1",
    });
    expect(stale.rows).toEqual([
      [{ cachedResult: 6, calculationStatus: "unverified", formula: "=A1*3" }],
    ]);
    const updated = await run({
      action: "write_range",
      path: "cached.xlsx",
      range: "A1",
      values: [[10]],
    });
    const read = await run({
      action: "read_range",
      path: updated.path,
      range: "B1",
    });
    expect(read.rows).toEqual([
      [{ calculationStatus: "pending", formula: "=A1*3" }],
    ]);
    const exported = await run({
      action: "export_csv",
      path: updated.path,
      targetCsvPath: "cached.csv",
    });
    expect(exported.csvEscapedCellCount).toBe(1);
    expect(
      await readFile(path.join(context.workspaceRoot!, exported.path), "utf8")
    ).toBe('10,\'=A1*3,-3,"a ""quote""",Link title');
    await expect(
      run({
        action: "export_csv",
        formulaExport: "values",
        path: updated.path,
        targetCsvPath: "values.csv",
      })
    ).rejects.toThrow();
    expect(await readFile(sourcePath)).toEqual(originalBytes);
  });
});

test.skipIf(!(await officeConverter.resolveConverterBinary()))(
  "recalculate verifies real LibreOffice results before exposing values and exporting them",
  async () => {
    await withWorkspace(async (context, run) => {
      const created = await run({
        action: "create",
        data: [[10, "=A1*3", "=B1+7", "=1/0"]],
        path: "calculate.xlsx",
      });
      const recalculated = await run({
        action: "recalculate",
        path: created.path,
      });
      expect(recalculated.engine).toBe("LibreOffice Calc");
      expect(recalculated.formulaErrorCount).toBe(1);
      const read = await run({
        action: "read_range",
        path: recalculated.path,
        range: "B1:D1",
      });
      expect(read.rows).toEqual([
        [
          {
            cachedResult: 30,
            calculationStatus: "recalculated",
            formula: "=A1*3",
          },
          {
            cachedResult: 37,
            calculationStatus: "recalculated",
            formula: "=B1+7",
          },
          {
            cachedResult: { error: "#DIV/0!" },
            calculationStatus: "recalculated",
            formula: "=1/0",
          },
        ],
      ]);
      const exported = await run({
        action: "export_csv",
        formulaExport: "values",
        path: recalculated.path,
        targetCsvPath: "values.csv",
      });
      expect(
        await readFile(path.join(context.workspaceRoot!, exported.path), "utf8")
      ).toBe("10,30,37,#DIV/0!");
      const untouched = await run({
        action: "read_range",
        path: created.path,
        range: "B1",
      });
      expect(untouched.rows).toEqual([
        [{ calculationStatus: "pending", formula: "=A1*3" }],
      ]);
      const modified = await openWorkbook(context, recalculated.path);
      modified.worksheets[0]!.getCell("A1").value = 20;
      await modified.xlsx.writeFile(
        path.join(context.workspaceRoot!, recalculated.path)
      );
      const unverified = await run({
        action: "read_range",
        path: recalculated.path,
        range: "B1",
      });
      expect(unverified.rows).toEqual([
        [
          {
            cachedResult: 30,
            calculationStatus: "unverified",
            formula: "=A1*3",
          },
        ],
      ]);
    });
  },
  45_000
);

test("recalculation fails safely without host dependency, on cancellation, macros and external formula data", async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Sheet").getCell("A1").value = { formula: "1+1" };
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  await expect(
    recalculateSpreadsheet(bytes, undefined, async () => null)
  ).rejects.toThrow();
  await expect(
    recalculateSpreadsheet(bytes, AbortSignal.abort(), async () => null)
  ).rejects.toThrow();
  const macroBytes = Buffer.from(
    zipSync({
      "xl/vbaProject.bin": Buffer.from("macro"),
      "xl/workbook.xml": Buffer.from("<workbook/>"),
    })
  );
  let resolved = false;
  await expect(
    recalculateSpreadsheet(macroBytes, undefined, async () => {
      resolved = true;
      return null;
    })
  ).rejects.toThrow();
  expect(resolved).toBe(false);
  workbook.worksheets[0]!.getCell("A1").value = {
    formula: 'WEBSERVICE("https://example.com")',
  };
  const external = Buffer.from(await workbook.xlsx.writeBuffer());
  await expect(
    recalculateSpreadsheet(external, undefined, async () => "/not-launched")
  ).rejects.toThrow();
});

test("CSV import refuses to replace a corrupt existing workbook and malformed input produces no artifact", async () => {
  await withWorkspace(async (context, run) => {
    await mkdir(path.join(context.workspaceRoot!, "artifacts"));
    const corrupted = path.join(
      context.workspaceRoot!,
      "artifacts",
      "bad.xlsx"
    );
    await writeFile(corrupted, "not a zip");
    await writeFile(path.join(context.workspaceRoot!, "input.csv"), "1,2");
    await expect(
      run({ action: "import_csv", csvPath: "input.csv", path: "bad.xlsx" })
    ).rejects.toThrow();
    expect(await readFile(corrupted, "utf8")).toBe("not a zip");
    await writeFile(
      path.join(context.workspaceRoot!, "input.csv"),
      '1,"unterminated'
    );
    await expect(
      run({ action: "import_csv", csvPath: "input.csv", path: "new.xlsx" })
    ).rejects.toThrow();
    expect(
      await readdir(path.join(context.workspaceRoot!, "artifacts"))
    ).toEqual(["bad.xlsx"]);
  });
});

test("range, extension, cell, file and response limits reject invalid work without changing the source", async () => {
  for (const invalid of ["A0", "A1:B2:C3", "B2:A1", "IW1", "A100001", "A01"]) {
    expect(() => parseA1Range(invalid)).toThrow();
  }
  await withWorkspace(async (context, run) => {
    for (const extension of ["xls", "xlsm", "tsv"]) {
      await expect(
        run({ action: "create", data: [[1]], path: `invalid.${extension}` })
      ).rejects.toThrow();
    }
    await expect(
      run({
        action: "create",
        data: Array.from({ length: 2000 }, () =>
          Array.from({ length: 256 }, () => 1)
        ),
        path: "too-many-cells.xlsx",
      })
    ).rejects.toThrow();
    const created = await run({
      action: "create",
      data: Array.from({ length: 101 }, (_, i) => [i]),
      path: "bounded.xlsx",
    });
    const first = await run({ action: "read_range", path: created.path });
    expect(first.rows).toHaveLength(100);
    expect(first.hasMoreRows).toBe(true);
    await expect(
      run({
        action: "write_range",
        path: created.path,
        range: "A1:B2",
        values: [[1]],
      })
    ).rejects.toThrow();
    await expect(
      run({ action: "read_range", path: created.path, range: "A1:IV100" })
    ).rejects.toThrow();
    await expect(
      run({
        action: "write_range",
        path: created.path,
        startRow: 0,
        values: [[1]],
      })
    ).rejects.toThrow();
    await expect(
      run({
        action: "write_range",
        path: created.path,
        range: "A1",
        values: [["x".repeat(32_768)]],
      })
    ).rejects.toThrow();
    const text = await run({
      action: "create",
      data: Array.from({ length: 10 }, () => ["x".repeat(30_000)]),
      path: "text.xlsx",
    });
    await expect(
      run({ action: "read_range", path: text.path })
    ).rejects.toThrow();
    const oversized = path.join(
      context.workspaceRoot!,
      "artifacts",
      "large.csv"
    );
    await writeFile(oversized, Buffer.alloc(MAX_SPREADSHEET_BYTES + 1, 32));
    await expect(
      run({ action: "inspect", path: "large.csv" })
    ).rejects.toThrow();
    expect(
      (await run({ action: "inspect", path: created.path })).revision
    ).toBe(created.revision);
  });
});

test("concurrent versioned writes remain distinct and in-place revision guards allow only one writer", async () => {
  await withWorkspace(async (context, run) => {
    const versions = await Promise.all(
      [1, 2].map(
        async (value) =>
          await run({
            action: "create",
            data: [[value]],
            path: "concurrent.xlsx",
          })
      )
    );
    expect(new Set(versions.map((result) => result.path)).size).toBe(2);
    for (const [index, version] of versions.entries()) {
      expect(
        (await openWorkbook(context, version.path)).worksheets[0]!.getCell("A1")
          .value
      ).toBe(index + 1);
    }
    const original = versions[0]!;
    const edits = await Promise.allSettled(
      [3, 4].map(
        async (value) =>
          await run({
            action: "write_range",
            expectedRevision: original.revision,
            path: original.path,
            range: "A1",
            values: [[value]],
            writeMode: "inplace",
          })
      )
    );
    expect(edits.filter((edit) => edit.status === "fulfilled")).toHaveLength(1);
    expect(edits.filter((edit) => edit.status === "rejected")).toHaveLength(1);
    const actual = await readFile(
      path.join(context.workspaceRoot!, original.path)
    );
    expect(spreadsheetRevision(actual)).not.toBe(original.revision);
    const files = await readdir(path.join(context.workspaceRoot!, "artifacts"));
    expect(files.some((file) => file.endsWith(".tmp"))).toBe(false);
    expect(
      (await openWorkbook(context, versions[1]!.path)).worksheets[0]!.getCell(
        "A1"
      ).value
    ).toBe(2);
  });
});

test("basic formatting retains untouched styles, merged cells, sheets and formula definitions", async () => {
  await withWorkspace(async (context, run) => {
    const source = new ExcelJS.Workbook();
    const sheet = source.addWorksheet("Data");
    sheet.getCell("A1").value = 2;
    sheet.getCell("A1").font = { italic: true, name: "Arial", size: 12 };
    sheet.getCell("B1").value = { formula: "A1*3", result: 6 };
    sheet.mergeCells("A3:B3");
    sheet.getCell("A3").value = "Merged";
    source.addWorksheet("Notes").getCell("A1").value = "Untouched";
    await mkdir(path.join(context.workspaceRoot!, "artifacts"));
    await source.xlsx.writeFile(
      path.join(context.workspaceRoot!, "artifacts", "style.xlsx")
    );
    const formatted = await run({
      action: "format_range",
      format: {
        bold: true,
        fillColor: "AABBCC",
        numberFormat: "0.00",
        wrapText: true,
      },
      path: "style.xlsx",
      range: "A1",
    });
    const workbook = await openWorkbook(context, formatted.path);
    const cell = workbook.getWorksheet("Data")!.getCell("A1");
    expect(cell.font).toMatchObject({
      bold: true,
      italic: true,
      name: "Arial",
      size: 12,
    });
    expect(cell.fill).toMatchObject({
      fgColor: { argb: "FFAABBCC" },
      type: "pattern",
    });
    expect(cell.numFmt).toBe("0.00");
    expect(workbook.getWorksheet("Data")!.getCell("B3").isMerged).toBe(true);
    expect(workbook.getWorksheet("Data")!.getCell("B1").formula).toBe("A1*3");
    expect(workbook.getWorksheet("Notes")!.getCell("A1").value).toBe(
      "Untouched"
    );
  });
});

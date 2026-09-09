import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import type { ToolContext } from "../contract";
import { executeProtectedTool } from "./execution";
import { spreadsheetTool } from "./spreadsheet";

async function withWorkspace(
  run: (workspaceRoot: string, context: ToolContext) => Promise<void>
): Promise<void> {
  const workspaceRoot = await realpath(
    await mkdtemp(path.join(tmpdir(), "atlas-spreadsheet-input-"))
  );
  try {
    await run(workspaceRoot, { workspaceRoot });
  } finally {
    await rm(workspaceRoot, { force: true, recursive: true });
  }
}

async function seedWorkbook(workspaceRoot: string): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Assets");
  sheet.addRow(["Original", "B", "C", "D", "E", "F"]);
  sheet.addRow(["old", "old", "old", "old", "old", "old"]);
  const filename = path.join(workspaceRoot, "assets.xlsx");
  await workbook.xlsx.writeFile(filename);
  return await readFile(filename);
}

async function reopenWorkbook(
  workspaceRoot: string,
  result: unknown
): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(
    path.join(workspaceRoot, (result as { path: string }).path)
  );
  return workbook;
}

for (const colors of [
  { fillColor: "#1f4E78", fontColor: "#fFffff" },
  { fillColor: "1f4E78", fontColor: "fFffff" },
]) {
  test(`protected formatting persists RGB colors ${JSON.stringify(colors)} as uppercase ARGB`, async () => {
    await withWorkspace(async (workspaceRoot, context) => {
      const original = await seedWorkbook(workspaceRoot);
      const input = {
        action: "format_range",
        format: { ...colors, bold: true },
        path: "assets.xlsx",
        range: "A1:B1",
      };
      const result = await executeProtectedTool(
        spreadsheetTool,
        input,
        context
      );
      expect(result.success).toBe(true);
      expect(result.metadata.retries).toBe(0);
      const workbook = await reopenWorkbook(workspaceRoot, result.data);
      for (const coordinate of ["A1", "B1"]) {
        const cell = workbook.getWorksheet("Assets")!.getCell(coordinate);
        expect(cell.fill).toEqual({
          fgColor: { argb: "FF1F4E78" },
          pattern: "solid",
          type: "pattern",
        });
        expect(cell.font.color?.argb).toBe("FFFFFFFF");
        expect(cell.font.bold).toBe(true);
      }
      expect(input.format).toEqual({ ...colors, bold: true });
      expect(await readFile(path.join(workspaceRoot, "assets.xlsx"))).toEqual(
        original
      );
    });
  });
}

for (const field of ["values", "data"] as const) {
  test(`protected write_range preserves cell types with ${field}`, async () => {
    await withWorkspace(async (workspaceRoot, context) => {
      const original = await seedWorkbook(workspaceRoot);
      const rows = [["", null, false, 0, "=D2+2", "00042"]];
      const input = {
        action: "write_range",
        path: "assets.xlsx",
        range: "A2:F2",
        [field]: rows,
      };
      const result = await executeProtectedTool(
        spreadsheetTool,
        input,
        context
      );
      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ cellsUpdated: 6, status: "updated" });
      const sheet = (
        await reopenWorkbook(workspaceRoot, result.data)
      ).getWorksheet("Assets")!;
      expect(sheet.getCell("A2").value).toBe("");
      expect(sheet.getCell("B2").value).toBeNull();
      expect(sheet.getCell("C2").value).toBe(false);
      expect(sheet.getCell("D2").value).toBe(0);
      expect(sheet.getCell("E2").formula).toBe("D2+2");
      expect(sheet.getCell("F2").value).toBe("00042");
      expect(sheet.getCell("A1").value).toBe("Original");
      expect(input).toEqual({
        action: "write_range",
        path: "assets.xlsx",
        range: "A2:F2",
        [field]: [["", null, false, 0, "=D2+2", "00042"]],
      });
      expect(await readFile(path.join(workspaceRoot, "assets.xlsx"))).toEqual(
        original
      );
    });
  });
}

test("direct spreadsheet calls normalize colors and write aliases without changing literal strings", async () => {
  await withWorkspace(async (workspaceRoot, context) => {
    await seedWorkbook(workspaceRoot);
    const formatted = await spreadsheetTool.run(
      {
        action: "format_range",
        format: { fillColor: "#aabbCc", fontColor: "#123abc" },
        path: "assets.xlsx",
        range: "A2",
      },
      context
    );
    const written = await spreadsheetTool.run(
      {
        action: "write_range",
        data: [["=SUM(1,2)"]],
        literalStrings: true,
        path: (formatted as { path: string }).path,
        range: "A2",
      },
      context
    );
    const cell = (await reopenWorkbook(workspaceRoot, written))
      .getWorksheet("Assets")!
      .getCell("A2");
    expect(cell.value).toBe("=SUM(1,2)");
    expect(cell.formula).toBeUndefined();
    expect(cell.fill).toMatchObject({ fgColor: { argb: "FFAABBCC" } });
    expect(cell.font.color?.argb).toBe("FF123ABC");
  });
});

test("malformed colors fail validation without creating a workspace or publishing artifacts", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const context = { workspaceRoot: path.join(workspaceRoot, "uncreated") };
    for (const field of ["fillColor", "fontColor"]) {
      for (const color of [
        "#ABC",
        "ABC",
        "#11223344",
        "11223344",
        "##112233",
        "red",
        "#11223G",
        " #112233",
        "112233 ",
        "112233\n",
        "#112233\n",
      ]) {
        const input = {
          action: "format_range",
          format: { [field]: color },
          path: "missing.xlsx",
          range: "A1",
        };
        const result = await executeProtectedTool(
          spreadsheetTool,
          input,
          context
        );
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_ARGUMENT");
        expect(result.error?.retryable).toBe(false);
        expect(result.artifacts).toBeUndefined();
        await expect(spreadsheetTool.run(input, context)).rejects.toMatchObject(
          {
            code: "INVALID_ARGUMENT",
          }
        );
      }
    }
    expect(await readdir(workspaceRoot)).toEqual([]);
  });
});

test("missing and empty formatting fail before workspace I/O", async () => {
  await withWorkspace(async (workspaceRoot) => {
    const context = { workspaceRoot: path.join(workspaceRoot, "uncreated") };
    for (const fields of [{}, { format: {} }]) {
      const input = { action: "format_range", path: "missing.xlsx", ...fields };
      const result = await executeProtectedTool(
        spreadsheetTool,
        input,
        context
      );
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_ARGUMENT");
      expect(result.error?.retryable).toBe(false);
      expect(result.artifacts).toBeUndefined();
      await expect(spreadsheetTool.run(input, context)).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    }
    expect(await readdir(workspaceRoot)).toEqual([]);
  });
});

const INVALID_WRITES = [
  {},
  { values: [] },
  { values: [[], []] },
  { data: [] },
  { data: [[], []] },
  { data: [[2]], values: [[1]] },
  { data: [[1]], values: [[1]] },
  { data: [[1]], values: [] },
  { data: [[1]], values: [[], []] },
  { data: [], values: [[1]] },
];

test("empty and ambiguous range writes fail before workspace I/O and cannot retry", async () => {
  await withWorkspace(async (workspaceRoot) => {
    let attempts = 0;
    const context: ToolContext = {
      async beforeToolCall() {
        attempts += 1;
      },
      workspaceRoot: path.join(workspaceRoot, "uncreated"),
    };
    for (const fields of INVALID_WRITES) {
      const input = { action: "write_range", path: "missing.xlsx", ...fields };
      const attemptsBefore = attempts;
      const result = await executeProtectedTool(
        spreadsheetTool,
        input,
        context,
        { retryPolicy: { initialDelayMs: 0, maxRetries: 2 } }
      );
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_ARGUMENT");
      expect(result.error?.retryable).toBe(false);
      expect(result.artifacts).toBeUndefined();
      expect(attempts - attemptsBefore).toBeLessThanOrEqual(1);
      await expect(spreadsheetTool.run(input, context)).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    }
    expect(await readdir(workspaceRoot)).toEqual([]);
  });
});

test("invalid range writes leave the source and its version inventory unchanged", async () => {
  await withWorkspace(async (workspaceRoot, context) => {
    const original = await seedWorkbook(workspaceRoot);
    for (const fields of INVALID_WRITES) {
      const result = await executeProtectedTool(
        spreadsheetTool,
        { action: "write_range", path: "assets.xlsx", range: "A1", ...fields },
        context
      );
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_ARGUMENT");
      expect(result.artifacts).toBeUndefined();
      expect(await readdir(workspaceRoot)).toEqual(["assets.xlsx"]);
      expect(await readFile(path.join(workspaceRoot, "assets.xlsx"))).toEqual(
        original
      );
    }
  });
});

test("create and add_sheet continue using data while permitting empty sheets", async () => {
  await withWorkspace(async (workspaceRoot, context) => {
    const created = await executeProtectedTool(
      spreadsheetTool,
      {
        action: "create",
        columns: ["Asset"],
        data: [["Laptop"]],
        path: "new.xlsx",
        sheetName: "Assets",
        values: [["Ignored"]],
      },
      context
    );
    expect(created.success).toBe(true);
    const added = await executeProtectedTool(
      spreadsheetTool,
      {
        action: "add_sheet",
        data: [[false, 0]],
        path: (created.data as { path: string }).path,
        sheetName: "Summary",
        values: [["Ignored"]],
      },
      context
    );
    expect(added.success).toBe(true);
    const empty = await executeProtectedTool(
      spreadsheetTool,
      {
        action: "add_sheet",
        data: [],
        path: (added.data as { path: string }).path,
        sheetName: "Empty",
      },
      context
    );
    expect(empty.success).toBe(true);
    const workbook = await reopenWorkbook(workspaceRoot, empty.data);
    expect(workbook.getWorksheet("Assets")!.getCell("A1").value).toBe("Asset");
    expect(workbook.getWorksheet("Assets")!.getCell("A2").value).toBe("Laptop");
    expect(workbook.getWorksheet("Summary")!.getCell("A1").value).toBe(false);
    expect(workbook.getWorksheet("Summary")!.getCell("B1").value).toBe(0);
    expect(workbook.getWorksheet("Empty")!.rowCount).toBe(0);
  });
});

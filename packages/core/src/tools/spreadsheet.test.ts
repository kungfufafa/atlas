import { describe, expect, test } from "bun:test";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolContext } from "../contract";
import { getProfileSoulDir } from "../soul/resolve";
import {
  parseA1Range,
  sanitizeCsvFormulaInjection,
  spreadsheetTool,
} from "./spreadsheet";

describe("spreadsheet tool V2", () => {
  async function withTempWorkspace<T>(
    fn: (workspaceRoot: string, context: ToolContext) => Promise<T>
  ): Promise<T> {
    const rawDir = await mkdtemp(path.join(tmpdir(), "atlas-sheet-test-"));
    const dir = await realpath(rawDir);
    const context: ToolContext = {
      orgId: "org_test",
      profileId: "profile_test",
      workspaceRoot: dir,
    };
    try {
      return await fn(dir, context);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  }

  test("creates a real .xlsx workbook, writes formulas, and reads range with A1 notation", async () => {
    await withTempWorkspace(async (_workspaceRoot, context) => {
      const createRes = (await spreadsheetTool.run(
        {
          action: "create",
          columns: ["Item", "Price", "Qty", "Total"],
          data: [
            ["Apples", 3, 10, "=B2*C2"],
            ["Bananas", 2, 25, "=B3*C3"],
          ],
          path: "sales.xlsx",
          sheetName: "Q1",
        },
        context
      )) as { status: string };
      expect(createRes.status).toBe("created");

      const inspectRes = (await spreadsheetTool.run(
        {
          action: "inspect",
          path: "sales.xlsx",
        },
        context
      )) as {
        sheetCount: number;
        sheets: Array<{ name: string; rowCount: number }>;
      };
      expect(inspectRes.sheetCount).toBe(1);
      expect(inspectRes.sheets[0]?.name).toBe("Q1");
      expect(inspectRes.sheets[0]?.rowCount).toBe(3);

      const readRes = (await spreadsheetTool.run(
        {
          action: "read_range",
          path: "sales.xlsx",
          range: "A1:D3",
          sheetName: "Q1",
        },
        context
      )) as { rows: unknown[][] };
      expect(readRes.rows.length).toBe(3);
      expect(readRes.rows[0]?.[0]).toBe("Item");
      expect(readRes.rows[1]?.[0]).toBe("Apples");
      expect(readRes.rows[1]?.[3]).toBe("=B2*C2");
    });
  });

  test("adds sheets, updates cell ranges, and exports to CSV", async () => {
    await withTempWorkspace(async (_workspaceRoot, context) => {
      await spreadsheetTool.run(
        {
          action: "create",
          columns: ["Year", "Revenue"],
          data: [["2025", 50_000]],
          path: "finance.xlsx",
          sheetName: "2025",
        },
        context
      );

      const addSheetRes = (await spreadsheetTool.run(
        {
          action: "add_sheet",
          columns: ["Year", "Revenue"],
          data: [["2026", 75_000]],
          path: "finance.xlsx",
          sheetName: "2026",
        },
        context
      )) as { status: string };
      expect(addSheetRes.status).toBe("sheet_added");

      const writeRes = (await spreadsheetTool.run(
        {
          action: "write_range",
          path: "finance.xlsx",
          sheetName: "2026",
          startCol: 2,
          startRow: 2,
          values: [[85_000]],
        },
        context
      )) as { cellsUpdated: number; status: string };
      expect(writeRes.status).toBe("updated");
      expect(writeRes.cellsUpdated).toBe(1);

      const exportRes = (await spreadsheetTool.run(
        {
          action: "export_csv",
          path: "finance.xlsx",
          sheetName: "2026",
          targetCsvPath: "report_2026.csv",
        },
        context
      )) as { exportedRows: number; status: string };
      expect(exportRes.status).toBe("csv_exported");
      expect(exportRes.exportedRows).toBe(2);
    });
  });

  test("uses profile soul dir when workspaceRoot is omitted", async () => {
    const configDir = await mkdtemp(path.join(tmpdir(), "atlas-sheet-soul-"));
    const previous = process.env.ATLAS_CONFIG_DIR;
    process.env.ATLAS_CONFIG_DIR = configDir;
    try {
      const soulDir = getProfileSoulDir("org_test", "profile_test");
      await spreadsheetTool.run(
        {
          action: "create",
          columns: ["A"],
          data: [[1]],
          path: "soul-only.xlsx",
        },
        { orgId: "org_test", profileId: "profile_test" }
      );
      await access(path.join(soulDir, "soul-only.xlsx"));
      await expect(
        access(path.join(process.cwd(), "soul-only.xlsx"))
      ).rejects.toThrow();
    } finally {
      if (previous === undefined) {
        delete process.env.ATLAS_CONFIG_DIR;
      } else {
        process.env.ATLAS_CONFIG_DIR = previous;
      }
      await rm(configDir, { force: true, recursive: true });
    }
  });

  test("formula injection sanitization escapes dangerous spreadsheet prefixes", () => {
    expect(sanitizeCsvFormulaInjection("=SUM(A1:A10)")).toBe("'=SUM(A1:A10)");
    expect(sanitizeCsvFormulaInjection("+123456")).toBe("'+123456");
    expect(sanitizeCsvFormulaInjection("-CMD|' /C calc'")).toBe(
      "'-CMD|' /C calc'"
    );
    expect(sanitizeCsvFormulaInjection("@SUM()")).toBe("'@SUM()");
    expect(sanitizeCsvFormulaInjection("Normal Text")).toBe("Normal Text");
  });

  test("parseA1Range correctly converts coordinates", () => {
    expect(parseA1Range("A1")).toEqual({ startCol: 1, startRow: 1 });
    expect(parseA1Range("B5:D10")).toEqual({
      endCol: 4,
      endRow: 10,
      startCol: 2,
      startRow: 5,
    });
    expect(parseA1Range("AA10:AB20")).toEqual({
      endCol: 28,
      endRow: 20,
      startCol: 27,
      startRow: 10,
    });
  });
});

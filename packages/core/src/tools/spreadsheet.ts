import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { z } from "zod";
import type { ToolContext, ToolDefinition } from "../contract";
import { getProfileSoulDir } from "../soul/resolve";
import {
  getCustomToolsDir,
  guardFilePath,
  type PathGuardOptions,
} from "./paths";
import { jsonSchemaFromZod, trimmedOptionalString } from "./schema";

const SpreadsheetActionSchema = z.enum([
  "create",
  "inspect",
  "read_range",
  "write_range",
  "add_sheet",
  "delete_sheet",
  "import_csv",
  "export_csv",
  "export_xlsx",
]);

export interface WorkbookSheetData {
  columns?: string[];
  name: string;
  rows: (string | number | boolean | null)[][];
}

export interface WorkbookData {
  sheets: WorkbookSheetData[];
  version: 1;
}

const SpreadsheetInputSchema = z
  .object({
    action: SpreadsheetActionSchema,
    columns: z.array(z.string()).optional(),
    csvPath: z.string().optional(),
    cwd: trimmedOptionalString,
    data: z
      .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))
      .optional(),
    endCol: z.number().int().min(1).optional(),
    endRow: z.number().int().min(1).optional(),
    path: z.string().min(1),
    range: z.string().optional(),
    sheetName: z.string().optional(),
    startCol: z.number().int().min(1).optional(),
    startRow: z.number().int().min(1).optional(),
    targetCsvPath: z.string().optional(),
    targetXlsxPath: z.string().optional(),
    values: z
      .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))
      .optional(),
  })
  .strict();

export type SpreadsheetInput = z.infer<typeof SpreadsheetInputSchema>;

export function sanitizeCsvFormulaInjection(cell: string): string {
  if (/^[=+\-@\t\r]/.test(cell)) {
    return `'${cell}`;
  }
  return cell;
}

export function parseA1Range(rangeStr: string): {
  endCol?: number;
  endRow?: number;
  startCol: number;
  startRow: number;
} {
  const parts = rangeStr.trim().toUpperCase().split(":");
  const start = parts[0]!;
  const end = parts[1];

  const colToNum = (col: string): number => {
    let num = 0;
    for (let i = 0; i < col.length; i += 1) {
      num = num * 26 + (col.charCodeAt(i) - 64);
    }
    return num;
  };

  const matchStart = start.match(/^([A-Z]+)(\d+)$/);
  if (!matchStart) {
    throw new Error(`Invalid A1 range: "${rangeStr}"`);
  }

  const startCol = colToNum(matchStart[1]!);
  const startRow = Number.parseInt(matchStart[2]!, 10);

  if (!end) {
    return { startCol, startRow };
  }

  const matchEnd = end.match(/^([A-Z]+)(\d+)$/);
  if (!matchEnd) {
    throw new Error(`Invalid A1 range: "${rangeStr}"`);
  }

  const endCol = colToNum(matchEnd[1]!);
  const endRow = Number.parseInt(matchEnd[2]!, 10);

  return { endCol, endRow, startCol, startRow };
}

function parseCsv(content: string): (string | number | boolean | null)[][] {
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return lines.map((line) => {
    const cells: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (const char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        cells.push(cur.trim());
        cur = "";
      } else {
        cur += char;
      }
    }
    cells.push(cur.trim());
    return cells.map((c) => {
      const num = Number(c);
      if (!Number.isNaN(num) && c !== "") {
        return num;
      }
      if (c.toLowerCase() === "true") {
        return true;
      }
      if (c.toLowerCase() === "false") {
        return false;
      }
      if (c === "") {
        return null;
      }
      return c;
    });
  });
}

function formatCsv(rows: (string | number | boolean | null)[][]): string {
  return rows
    .map((row) =>
      row
        .map((cell) => {
          if (cell === null || cell === undefined) {
            return "";
          }
          let str = String(cell);
          str = sanitizeCsvFormulaInjection(str);
          if (str.includes(",") || str.includes('"') || str.includes("\n")) {
            return `"${str.replace(/"/g, '""')}"`;
          }
          return str;
        })
        .join(",")
    )
    .join("\n");
}

async function loadExcelWorkbook(filePath: string): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  if (filePath.endsWith(".xlsx")) {
    await wb.xlsx.readFile(filePath);
  } else if (filePath.endsWith(".csv")) {
    const raw = await readFile(filePath, "utf8");
    const rows = parseCsv(raw);
    const ws = wb.addWorksheet("Sheet1");
    for (const r of rows) {
      ws.addRow(r);
    }
  } else {
    const raw = await readFile(filePath, "utf8");
    const data: WorkbookData = JSON.parse(raw);
    for (const s of data.sheets) {
      const ws = wb.addWorksheet(s.name);
      if (s.columns) {
        ws.addRow(s.columns);
      }
      for (const r of s.rows) {
        ws.addRow(r);
      }
    }
  }
  return wb;
}

async function saveExcelWorkbook(
  filePath: string,
  wb: ExcelJS.Workbook
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  if (filePath.endsWith(".xlsx")) {
    await wb.xlsx.writeFile(filePath);
  } else if (filePath.endsWith(".csv")) {
    const ws = wb.worksheets[0] || wb.addWorksheet("Sheet1");
    const rows: (string | number | boolean | null)[][] = [];
    ws.eachRow((row) => {
      const values = Array.isArray(row.values)
        ? (row.values.slice(1) as (string | number | boolean | null)[])
        : [];
      rows.push(values);
    });
    await writeFile(filePath, formatCsv(rows), "utf8");
  } else {
    const sheets: WorkbookSheetData[] = [];
    for (const ws of wb.worksheets) {
      const rows: (string | number | boolean | null)[][] = [];
      ws.eachRow((row) => {
        const values = Array.isArray(row.values)
          ? (row.values.slice(1) as (string | number | boolean | null)[])
          : [];
        rows.push(values);
      });
      sheets.push({ name: ws.name, rows });
    }
    await writeFile(
      filePath,
      JSON.stringify({ sheets, version: 1 }, null, 2),
      "utf8"
    );
  }
}

const SUPER_AGENT_PROFILE_ID = "super_agent";

function buildSpreadsheetGuardOptions(
  workspaceRoot: string,
  profileId?: string
): PathGuardOptions {
  const allowedDirs =
    profileId?.trim() === SUPER_AGENT_PROFILE_ID
      ? [workspaceRoot, getCustomToolsDir()]
      : [workspaceRoot];

  return {
    allowedDirs,
    cwd: workspaceRoot,
  };
}

export const spreadsheetTool: ToolDefinition = {
  description:
    "Create, inspect, modify, read, write, import and export spreadsheets and Excel workbooks (.xlsx, .csv, .json) deterministically with support for multi-sheet, formulas, styles, and cell ranges.",
  name: "spreadsheet",
  parallelSafe: false,
  parameters: jsonSchemaFromZod(SpreadsheetInputSchema),
  async run(input: unknown, context: ToolContext) {
    const parsed = SpreadsheetInputSchema.parse(input);
    const orgId = context.orgId?.trim();
    const profileId = context.profileId?.trim();
    const workspaceRoot =
      context.workspaceRoot?.trim() ||
      (orgId && profileId ? getProfileSoulDir(orgId, profileId) : "");
    if (!workspaceRoot) {
      throw new Error("orgId and profileId are required.");
    }
    await mkdir(workspaceRoot, { recursive: true });
    const guardOptions = buildSpreadsheetGuardOptions(
      workspaceRoot,
      context.profileId
    );
    const guarded = await guardFilePath(
      parsed.path,
      parsed.cwd,
      undefined,
      guardOptions
    );
    const filePath = guarded.resolved;

    switch (parsed.action) {
      case "create": {
        const wb = new ExcelJS.Workbook();
        const sheetName = parsed.sheetName || "Sheet1";
        const ws = wb.addWorksheet(sheetName);

        if (parsed.columns && parsed.columns.length > 0) {
          ws.addRow(parsed.columns);
        }

        if (parsed.data && parsed.data.length > 0) {
          for (const row of parsed.data) {
            ws.addRow(row);
          }
        }

        await saveExcelWorkbook(filePath, wb);
        return {
          columnCount: parsed.columns?.length ?? 0,
          format: path.extname(filePath) || ".xlsx",
          path: path.relative(workspaceRoot, filePath),
          rowCount: parsed.data?.length ?? 0,
          sheetName,
          status: "created",
        };
      }

      case "inspect": {
        const wb = await loadExcelWorkbook(filePath);
        const sheets = wb.worksheets.map((ws) => {
          const firstRow = ws.getRow(1);
          const columns = Array.isArray(firstRow.values)
            ? (firstRow.values.slice(1).map(String) as string[])
            : [];
          return {
            columnCount: ws.columnCount,
            columns,
            name: ws.name,
            rowCount: ws.rowCount,
          };
        });

        return {
          path: path.relative(workspaceRoot, filePath),
          sheetCount: wb.worksheets.length,
          sheets,
        };
      }

      case "read_range": {
        const wb = await loadExcelWorkbook(filePath);
        const ws = parsed.sheetName
          ? wb.getWorksheet(parsed.sheetName)
          : wb.worksheets[0];

        if (!ws) {
          throw new Error(`Sheet "${parsed.sheetName}" not found in workbook.`);
        }

        let startR = parsed.startRow ?? 1;
        let endR = parsed.endRow ?? ws.rowCount;
        let startC = parsed.startCol ?? 1;
        let endC = parsed.endCol ?? ws.columnCount;

        if (parsed.range) {
          const parsedA1 = parseA1Range(parsed.range);
          startR = parsedA1.startRow;
          startC = parsedA1.startCol;
          if (parsedA1.endRow) {
            endR = parsedA1.endRow;
          }
          if (parsedA1.endCol) {
            endC = parsedA1.endCol;
          }
        }

        const rows: (string | number | boolean | null)[][] = [];
        for (let r = startR; r <= Math.max(startR, endR); r += 1) {
          const rowData: (string | number | boolean | null)[] = [];
          const row = ws.getRow(r);
          for (let c = startC; c <= Math.max(startC, endC); c += 1) {
            const cell = row.getCell(c);
            let val = cell.value;
            if (val && typeof val === "object") {
              if ("result" in val && val.result !== undefined) {
                val = val.result as string | number | boolean | null;
              } else if ("formula" in val) {
                val = `=${val.formula}`;
              }
            }
            rowData.push((val as string | number | boolean | null) ?? null);
          }
          rows.push(rowData);
        }

        return {
          endCol: endC,
          endRow: endR,
          range: parsed.range ?? `R${startR}C${startC}:R${endR}C${endC}`,
          rows,
          sheetName: ws.name,
          startCol: startC,
          startRow: startR,
        };
      }

      case "write_range": {
        const wb = await loadExcelWorkbook(filePath);
        const ws = parsed.sheetName
          ? wb.getWorksheet(parsed.sheetName)
          : wb.worksheets[0];

        if (!ws) {
          throw new Error(`Sheet "${parsed.sheetName}" not found in workbook.`);
        }

        let startR = parsed.startRow ?? 1;
        let startC = parsed.startCol ?? 1;

        if (parsed.range) {
          const parsedA1 = parseA1Range(parsed.range);
          startR = parsedA1.startRow;
          startC = parsedA1.startCol;
        }

        const values = parsed.values ?? [];
        for (let r = 0; r < values.length; r += 1) {
          const rowValues = values[r] ?? [];
          const row = ws.getRow(startR + r);
          for (let c = 0; c < rowValues.length; c += 1) {
            const cell = row.getCell(startC + c);
            const val = rowValues[c];
            if (typeof val === "string" && val.startsWith("=")) {
              cell.value = { formula: val.slice(1) };
            } else {
              cell.value = val;
            }
          }
          row.commit();
        }

        await saveExcelWorkbook(filePath, wb);
        return {
          cellsUpdated: values.reduce((acc, row) => acc + row.length, 0),
          path: path.relative(workspaceRoot, filePath),
          sheetName: ws.name,
          status: "updated",
        };
      }

      case "add_sheet": {
        const wb = await loadExcelWorkbook(filePath);
        const sheetName =
          parsed.sheetName || `Sheet${wb.worksheets.length + 1}`;
        if (wb.getWorksheet(sheetName)) {
          throw new Error(`Sheet "${sheetName}" already exists.`);
        }
        const ws = wb.addWorksheet(sheetName);

        if (parsed.columns) {
          ws.addRow(parsed.columns);
        }
        if (parsed.data) {
          for (const row of parsed.data) {
            ws.addRow(row);
          }
        }

        await saveExcelWorkbook(filePath, wb);
        return {
          path: path.relative(workspaceRoot, filePath),
          sheetName,
          status: "sheet_added",
        };
      }

      case "delete_sheet": {
        const wb = await loadExcelWorkbook(filePath);
        if (!parsed.sheetName) {
          throw new Error("sheetName is required to delete a sheet.");
        }
        const ws = wb.getWorksheet(parsed.sheetName);
        if (!ws) {
          throw new Error(`Sheet "${parsed.sheetName}" not found.`);
        }
        if (wb.worksheets.length <= 1) {
          throw new Error("Cannot delete the only sheet in a workbook.");
        }
        wb.removeWorksheet(ws.id);
        await saveExcelWorkbook(filePath, wb);
        return {
          path: path.relative(workspaceRoot, filePath),
          sheetName: parsed.sheetName,
          status: "sheet_deleted",
        };
      }

      case "import_csv": {
        if (!parsed.csvPath) {
          throw new Error("csvPath is required for import_csv.");
        }
        const guardedCsv = await guardFilePath(
          parsed.csvPath,
          parsed.cwd,
          undefined,
          guardOptions
        );
        const csvRaw = await readFile(guardedCsv.resolved, "utf8");
        const rows = parseCsv(csvRaw);
        const sheetName =
          parsed.sheetName || path.basename(parsed.csvPath, ".csv");

        let wb: ExcelJS.Workbook;
        try {
          wb = await loadExcelWorkbook(filePath);
        } catch {
          wb = new ExcelJS.Workbook();
        }

        let ws = wb.getWorksheet(sheetName);
        if (ws) {
          wb.removeWorksheet(ws.id);
        }
        ws = wb.addWorksheet(sheetName);
        for (const row of rows) {
          ws.addRow(row);
        }

        await saveExcelWorkbook(filePath, wb);
        return {
          importedRows: rows.length,
          path: path.relative(workspaceRoot, filePath),
          sheetName,
          status: "csv_imported",
        };
      }

      case "export_csv": {
        if (!parsed.targetCsvPath) {
          throw new Error("targetCsvPath is required for export_csv.");
        }
        const wb = await loadExcelWorkbook(filePath);
        const ws = parsed.sheetName
          ? wb.getWorksheet(parsed.sheetName)
          : wb.worksheets[0];
        if (!ws) {
          throw new Error(`Sheet "${parsed.sheetName}" not found.`);
        }

        const rows: (string | number | boolean | null)[][] = [];
        ws.eachRow((row) => {
          const values = Array.isArray(row.values)
            ? (row.values.slice(1) as (string | number | boolean | null)[])
            : [];
          rows.push(values);
        });

        const guardedTarget = await guardFilePath(
          parsed.targetCsvPath,
          parsed.cwd,
          undefined,
          guardOptions
        );
        await mkdir(path.dirname(guardedTarget.resolved), { recursive: true });
        await writeFile(guardedTarget.resolved, formatCsv(rows), "utf8");

        return {
          exportedRows: rows.length,
          sourcePath: path.relative(workspaceRoot, filePath),
          status: "csv_exported",
          targetCsvPath: path.relative(workspaceRoot, guardedTarget.resolved),
        };
      }

      case "export_xlsx": {
        if (!parsed.targetXlsxPath) {
          throw new Error("targetXlsxPath is required for export_xlsx.");
        }
        const wb = await loadExcelWorkbook(filePath);
        const guardedTarget = await guardFilePath(
          parsed.targetXlsxPath,
          parsed.cwd,
          undefined,
          guardOptions
        );
        await mkdir(path.dirname(guardedTarget.resolved), { recursive: true });
        await wb.xlsx.writeFile(guardedTarget.resolved);

        return {
          sourcePath: path.relative(workspaceRoot, filePath),
          status: "xlsx_exported",
          targetXlsxPath: path.relative(workspaceRoot, guardedTarget.resolved),
        };
      }
    }
  },
};

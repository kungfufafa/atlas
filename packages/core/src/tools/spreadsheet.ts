import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { z } from "zod";
import { stampArtifactLineage } from "../artifact-lineage";
import { coerceDeliverableArtifactPath } from "../artifact-path";
import { officeConverter } from "../artifact-preview/office-converter";
import {
  isArtifactPublicationPath,
  stageToolArtifact,
} from "../artifact-publication";
import type { ToolContext, ToolDefinition } from "../contract";
import { readOfficeZipParts } from "../office-document/archive";
import {
  attribute,
  elements,
  parseXml,
  serializeXml,
} from "../office-document/xml";
import { getProfileSoulDir } from "../soul/resolve";
import { guardFilePath, type PathGuardOptions } from "./paths";
import { jsonSchemaFromZod, trimmedOptionalString } from "./schema";
import {
  assertWorkbookBounds,
  assignSpreadsheetCell,
  formatSpreadsheetCsv,
  invalidateSpreadsheetCalculation,
  parseSpreadsheetCsv,
  type SpreadsheetCalculationStatus,
  type SpreadsheetPrimitive,
  sanitizeCsvFormulaInjection,
  spreadsheetCellValue,
} from "./spreadsheet-cells";
import {
  preserveSpreadsheetMetadata,
  spreadsheetBytesForExcelJs,
} from "./spreadsheet-compat";
import {
  inspectUnsupportedSpreadsheet,
  unsupportedSpreadsheetFeatures,
} from "./spreadsheet-features";
import {
  boundedSpreadsheetResponse,
  inspectSpreadsheetArchive,
  MAX_SPREADSHEET_BYTES,
  MAX_SPREADSHEET_CELL_BYTES,
  MAX_SPREADSHEET_CELLS,
  MAX_SPREADSHEET_COLUMNS,
  MAX_SPREADSHEET_READ_CELLS,
  MAX_SPREADSHEET_ROWS,
  publishSpreadsheet,
  readSpreadsheetBytes,
  spreadsheetExists,
  spreadsheetFormat,
  spreadsheetRevision,
  withSpreadsheetWrite,
} from "./spreadsheet-io";
import { formatNewCsvWorksheet } from "./spreadsheet-layout";
import {
  spreadsheetPartsForCellRead,
  writeSpreadsheetCellsPreservingParts,
} from "./spreadsheet-ooxml";
import {
  readSpreadsheetCalculation,
  recalculateSpreadsheet,
  recordSpreadsheetCalculation,
} from "./spreadsheet-recalculation";

export { sanitizeCsvFormulaInjection };

const PrimitiveSchema = z.union([
  z.string().max(MAX_SPREADSHEET_CELL_BYTES),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const RowsSchema = z
  .array(z.array(PrimitiveSchema).max(MAX_SPREADSHEET_COLUMNS))
  .max(MAX_SPREADSHEET_ROWS)
  .refine(
    (rows) =>
      rows.length *
        rows.reduce((width, row) => Math.max(width, row.length), 0) <=
      MAX_SPREADSHEET_CELLS,
    "Spreadsheet input exceeds the 500000-cell limit. Split the input into smaller workbooks."
  );
const CoordinateRow = z.number().int().min(1).max(MAX_SPREADSHEET_ROWS);
const CoordinateColumn = z.number().int().min(1).max(MAX_SPREADSHEET_COLUMNS);
const SpreadsheetInputSchema = z
  .object({
    action: z.enum([
      "create",
      "inspect",
      "read_range",
      "write_range",
      "format_range",
      "add_sheet",
      "delete_sheet",
      "import_csv",
      "export_csv",
      "export_xlsx",
      "recalculate",
    ]),
    columns: z
      .array(z.string().max(MAX_SPREADSHEET_CELL_BYTES))
      .max(MAX_SPREADSHEET_COLUMNS)
      .optional(),
    columnTypes: z
      .array(z.enum(["text", "number", "boolean"]))
      .max(MAX_SPREADSHEET_COLUMNS)
      .optional()
      .describe(
        "CSV columns are text by default; explicit types opt into conversion."
      ),
    csvHeader: z
      .boolean()
      .optional()
      .describe("Keep the first CSV row as text when columnTypes is set."),
    csvPath: z.string().optional(),
    cwd: trimmedOptionalString,
    data: RowsSchema.optional(),
    decimalSeparator: z
      .enum([".", ","])
      .optional()
      .describe(
        "Decimal separator for explicit CSV number columns; defaults to dot. Grouping separators are unsupported."
      ),
    delimiter: z.enum([",", ";", "\t"]).optional(),
    endCol: CoordinateColumn.optional(),
    endRow: CoordinateRow.optional(),
    escapeCsvFormulas: z
      .boolean()
      .default(true)
      .describe(
        "Escape formula-like text when exporting CSV; false requests a literal roundtrip."
      ),
    expectedRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional()
      .describe(
        "SHA-256 from inspect/read_range, required for in-place writes."
      ),
    format: z
      .object({
        alignment: z.enum(["left", "center", "right"]).optional(),
        bold: z.boolean().optional(),
        fillColor: z
          .string()
          .regex(/^[a-fA-F0-9]{6}$/)
          .optional(),
        fontColor: z
          .string()
          .regex(/^[a-fA-F0-9]{6}$/)
          .optional(),
        italic: z.boolean().optional(),
        numberFormat: z.string().max(100).optional(),
        wrapText: z.boolean().optional(),
      })
      .strict()
      .optional(),
    formulaExport: z
      .enum(["formulas", "values"])
      .default("formulas")
      .describe(
        "CSV formula values require verified recalculation; default exports formula text."
      ),
    literalStrings: z
      .boolean()
      .default(false)
      .describe("Store '=...' as text. CSV imports always use literal text."),
    path: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Workbook path (.xlsx, .csv, .json; .xls/.xlsm/.xlsb support inspect, read_range, export_xlsx). Export legacy workbooks to a new .xlsx before editing; macros are not preserved. Follow the returned path after edits."
      ),
    range: z.string().max(30).optional(),
    sheetName: z
      .string()
      .min(1)
      .max(31)
      .regex(/^[^[\]:*?/\\]+$/)
      .optional(),
    startCol: CoordinateColumn.optional(),
    startRow: CoordinateRow.optional(),
    targetCsvPath: z.string().optional(),
    targetXlsxPath: z.string().optional(),
    values: RowsSchema.optional(),
    writeMode: z
      .enum(["versioned", "inplace"])
      .default("versioned")
      .describe(
        "Default saves a new version. In-place requires expectedRevision."
      ),
  })
  .strict();
export type SpreadsheetInput = z.infer<typeof SpreadsheetInputSchema>;
export interface WorkbookSheetData {
  columns?: string[];
  name: string;
  rows: SpreadsheetPrimitive[][];
}
export interface WorkbookData {
  sheets: WorkbookSheetData[];
  version: 1;
}

export function parseA1Range(range: string): {
  startCol: number;
  startRow: number;
  endCol?: number;
  endRow?: number;
} {
  const match = /^([A-Z]+)([1-9]\d*)(?::([A-Z]+)([1-9]\d*))?$/.exec(
    range.trim().toUpperCase()
  );
  if (!match) {
    throw new Error(`Invalid A1 range: ${range}`);
  }
  const columnNumber = (text: string) => {
    let value = 0;
    for (const character of text) {
      value = value * 26 + character.charCodeAt(0) - 64;
    }
    return value;
  };
  const startCol = columnNumber(match[1]!);
  const startRow = Number(match[2]);
  const endCol = match[3] ? columnNumber(match[3]) : undefined;
  const endRow = match[4] ? Number(match[4]) : undefined;
  if (
    startRow > MAX_SPREADSHEET_ROWS ||
    (endRow ?? startRow) > MAX_SPREADSHEET_ROWS ||
    startCol > MAX_SPREADSHEET_COLUMNS ||
    (endCol ?? startCol) > MAX_SPREADSHEET_COLUMNS ||
    (endRow ?? startRow) < startRow ||
    (endCol ?? startCol) < startCol
  ) {
    throw new Error(
      "Range must be ordered and within 100000 rows and 256 columns."
    );
  }
  return {
    startCol,
    startRow,
    ...(endCol === undefined ? {} : { endCol, endRow }),
  };
}

function addRows(
  sheet: ExcelJS.Worksheet,
  rows: SpreadsheetPrimitive[][],
  literal: boolean,
  startRow = 1,
  startCol = 1
): void {
  if (
    startRow + rows.length - 1 > MAX_SPREADSHEET_ROWS ||
    rows.some((row) => startCol + row.length - 1 > MAX_SPREADSHEET_COLUMNS)
  ) {
    throw new Error("Written cells exceed the spreadsheet coordinate limits.");
  }
  for (const [r, values] of rows.entries()) {
    for (const [c, value] of values.entries()) {
      assignSpreadsheetCell(
        sheet.getCell(startRow + r, startCol + c),
        value,
        literal
      );
    }
  }
}
const JsonCellSchema = z.union([
  PrimitiveSchema,
  z
    .object({ formula: z.string().min(1).max(MAX_SPREADSHEET_CELL_BYTES) })
    .strict(),
]);
const JsonWorkbookSchema = z
  .object({
    sheets: z
      .array(
        z
          .object({
            columns: z.array(z.string()).optional(),
            name: z.string().min(1).max(31),
            rows: z
              .array(z.array(JsonCellSchema).max(MAX_SPREADSHEET_COLUMNS))
              .max(MAX_SPREADSHEET_ROWS),
          })
          .strict()
      )
      .min(1)
      .max(64),
    version: z.literal(1),
  })
  .strict();

function spreadsheetInputFormat(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".xls" || extension === ".xlsm" || extension === ".xlsb") {
    return extension;
  }
  return spreadsheetFormat(filePath);
}

function isLegacySpreadsheet(filePath: string): boolean {
  return [".xls", ".xlsm", ".xlsb"].includes(spreadsheetInputFormat(filePath));
}

function passiveMacroWorkbookParts(bytes: Buffer): Record<string, Uint8Array> {
  const parts = readOfficeZipParts(bytes, { allowMacros: true });
  if (!parts["xl/workbook.xml"]) {
    throw new Error("The source is not an XLSM workbook.");
  }
  for (const [name, content] of Object.entries(parts)) {
    if (/vba(project|data)|\.vba$/i.test(name)) {
      delete parts[name];
      continue;
    }
    if (name.endsWith(".rels") || name === "[Content_Types].xml") {
      const document = parseXml(content, name);
      for (const element of [
        ...elements(document.documentElement, "Relationship"),
        ...elements(document.documentElement, "Override"),
        ...elements(document.documentElement, "Default"),
      ]) {
        if (
          /vba/i.test(
            ["Type", "Target", "PartName", "ContentType"]
              .map((key) => attribute(element, key))
              .join(" ")
          )
        ) {
          element.parentNode?.removeChild(element);
        } else if (
          attribute(element, "ContentType") ===
          "application/vnd.ms-excel.sheet.macroEnabled.main+xml"
        ) {
          element.setAttribute(
            "ContentType",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"
          );
        }
      }
      parts[name] = serializeXml(document);
    }
  }
  return parts;
}

async function loadWorkbook(
  filePath: string,
  parsed: SpreadsheetInput,
  signal?: AbortSignal
) {
  const originalBytes = await readSpreadsheetBytes(filePath);
  const format = spreadsheetInputFormat(filePath);
  if (
    format === ".xls" &&
    !originalBytes.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex"))
  ) {
    throw new Error("The source is not a supported binary XLS workbook.");
  }
  if (
    format === ".xlsb" &&
    !readOfficeZipParts(originalBytes)["xl/workbook.bin"]
  ) {
    throw new Error("The source is not an XLSB workbook.");
  }
  const needsConversion = format === ".xls" || format === ".xlsb";
  const converted = needsConversion
    ? await officeConverter.convertOfficeToXlsx({
        buffer: originalBytes,
        filename: path.basename(filePath),
        maxOutputBytes: MAX_SPREADSHEET_BYTES,
        signal,
      })
    : undefined;
  const bytes = converted?.bytes ?? originalBytes;
  const legacyInput = isLegacySpreadsheet(filePath);
  const workbook = new ExcelJS.Workbook();
  let preserveChartParts = false;
  let unsupportedInspection:
    | ReturnType<typeof inspectUnsupportedSpreadsheet>
    | undefined;
  if (format === ".xlsx" || legacyInput) {
    const parts =
      format === ".xlsm"
        ? passiveMacroWorkbookParts(bytes)
        : inspectSpreadsheetArchive(bytes);
    const features = unsupportedSpreadsheetFeatures(parts);
    preserveChartParts =
      features.includes("charts") &&
      features.every((feature) =>
        ["charts", "drawing shapes or charts"].includes(feature)
      );
    if (
      preserveChartParts &&
      !["inspect", "read_range", "write_range", "export_csv"].includes(
        parsed.action
      )
    ) {
      throw new Error(
        "Chart workbooks support inspect, read_range, write_range, and export_csv. Layout changes and chart recalculation are unsupported."
      );
    }
    if (features.length && !preserveChartParts) {
      if (parsed.action !== "inspect") {
        throw new Error(
          `This workbook contains unsupported features (${features.join(", ")}); use inspect for metadata and an assigned coding tool or desktop spreadsheet editor for its cells. No output was saved.`
        );
      }
      unsupportedInspection = inspectUnsupportedSpreadsheet(parts, features);
    } else {
      await workbook.xlsx.load(
        Uint8Array.from(
          spreadsheetBytesForExcelJs(
            preserveChartParts ? spreadsheetPartsForCellRead(parts) : parts
          )
        ).buffer
      );
    }
  } else if (format === ".csv") {
    addRows(
      workbook.addWorksheet("Sheet1"),
      parseSpreadsheetCsv(bytes.toString("utf8"), {
        columnTypes: parsed.columnTypes,
        decimalSeparator: parsed.decimalSeparator,
        delimiter: parsed.delimiter,
        header: parsed.csvHeader,
      }),
      true
    );
  } else {
    const data = JsonWorkbookSchema.parse(JSON.parse(bytes.toString("utf8")));
    for (const definition of data.sheets) {
      const sheet = workbook.addWorksheet(definition.name);
      if (definition.columns) {
        addRows(sheet, [definition.columns], true);
      }
      for (const [r, row] of definition.rows.entries()) {
        for (const [c, value] of row.entries()) {
          sheet.getCell(r + 1 + (definition.columns ? 1 : 0), c + 1).value =
            value;
        }
      }
    }
  }
  if (!unsupportedInspection) {
    assertWorkbookBounds(workbook);
  }
  const revision = spreadsheetRevision(originalBytes);
  return {
    bytes,
    calculationStatus: await readSpreadsheetCalculation(filePath, revision),
    conversion: legacyInput
      ? {
          sourceFormat: format,
          supportedActions: ["inspect", "read_range", "export_xlsx"],
          warnings: [
            "Export to a new XLSX before editing. The original is unchanged; macros are not executed or preserved in the exported workbook. Verify workbook features and formula results after conversion.",
          ],
        }
      : undefined,
    preserveChartParts,
    revision,
    unsupportedInspection,
    workbook,
  };
}

function selectedSheet(
  workbook: ExcelJS.Workbook,
  name?: string
): ExcelJS.Worksheet {
  const sheet = name ? workbook.getWorksheet(name) : workbook.worksheets[0];
  if (!sheet) {
    throw new Error(`Sheet ${name ?? "1"} was not found.`);
  }
  return sheet;
}

async function serializeWorkbook(
  filePath: string,
  workbook: ExcelJS.Workbook,
  parsed: SpreadsheetInput,
  report: Record<string, unknown>,
  calculationStatus?: SpreadsheetCalculationStatus
): Promise<Buffer> {
  const format = spreadsheetFormat(filePath);
  assertWorkbookBounds(workbook);
  if (format === ".xlsx") {
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }
  if (format === ".csv") {
    if (workbook.worksheets.length !== 1 && parsed.action !== "export_csv") {
      throw new Error(
        "CSV cannot preserve multiple sheets. Export a selected sheet or use XLSX."
      );
    }
    const csv = formatSpreadsheetCsv(
      selectedSheet(workbook, parsed.sheetName),
      {
        calculationStatus,
        delimiter: parsed.delimiter,
        escapeFormulas: parsed.escapeCsvFormulas,
        formulaExport: parsed.formulaExport,
      }
    );
    report.csvEscapedCellCount = csv.escapedCellCount;
    return Buffer.from(csv.content);
  }
  const sheets = workbook.worksheets.map((sheet) => {
    const rows: unknown[][] = [];
    for (let r = 1; r <= sheet.rowCount; r += 1) {
      const values: unknown[] = [];
      for (let c = 1; c <= sheet.columnCount; c += 1) {
        const cell = sheet.getCell(r, c);
        const value = cell.formula
          ? { formula: cell.formula }
          : spreadsheetCellValue(cell);
        if (value && typeof value === "object" && "error" in value) {
          throw new Error("JSON export cannot preserve error cells. Use XLSX.");
        }
        values.push(value);
      }
      rows.push(values);
    }
    return { name: sheet.name, rows };
  });
  return Buffer.from(JSON.stringify({ sheets, version: 1 }));
}

function resolveRange(
  parsed: SpreadsheetInput,
  sheet: ExcelJS.Worksheet,
  readDefault = false
) {
  if (
    parsed.range &&
    [parsed.startRow, parsed.startCol, parsed.endRow, parsed.endCol].some(
      (value) => value !== undefined
    )
  ) {
    throw new Error("Use an A1 range or numeric coordinates, not both.");
  }
  const a1 = parsed.range ? parseA1Range(parsed.range) : undefined;
  const startRow = a1?.startRow ?? parsed.startRow ?? 1;
  const startCol = a1?.startCol ?? parsed.startCol ?? 1;
  const endRow = a1
    ? (a1.endRow ?? a1.startRow)
    : (parsed.endRow ??
      (readDefault
        ? Math.max(startRow, Math.min(sheet.rowCount, startRow + 99))
        : startRow));
  const endCol = a1
    ? (a1.endCol ?? a1.startCol)
    : (parsed.endCol ??
      (readDefault
        ? Math.max(startCol, Math.min(sheet.columnCount, startCol + 49))
        : startCol));
  if (
    endRow < startRow ||
    endCol < startCol ||
    (endRow - startRow + 1) * (endCol - startCol + 1) >
      MAX_SPREADSHEET_READ_CELLS
  ) {
    throw new Error(
      "Range must be ordered and contain at most 10000 cells. Request smaller ranges."
    );
  }
  return { endCol, endRow, startCol, startRow };
}
function inspectWorkbook(
  workbook: ExcelJS.Workbook,
  calculationStatus?: SpreadsheetCalculationStatus
) {
  return workbook.worksheets.map((sheet) => ({
    columnCount: sheet.columnCount,
    columns: Array.from({ length: sheet.columnCount }, (_, index) =>
      spreadsheetCellValue(sheet.getCell(1, index + 1), calculationStatus)
    ),
    name: sheet.name,
    rowCount: sheet.rowCount,
  }));
}
function readRange(
  workbook: ExcelJS.Workbook,
  parsed: SpreadsheetInput,
  calculationStatus?: SpreadsheetCalculationStatus
) {
  const sheet = selectedSheet(workbook, parsed.sheetName);
  const range = resolveRange(parsed, sheet, true);
  const rows: unknown[][] = [];
  for (let r = range.startRow; r <= range.endRow; r += 1) {
    const values: unknown[] = [];
    for (let c = range.startCol; c <= range.endCol; c += 1) {
      values.push(spreadsheetCellValue(sheet.getCell(r, c), calculationStatus));
    }
    rows.push(values);
  }
  return {
    ...range,
    hasMoreColumns: range.endCol < sheet.columnCount,
    hasMoreRows: range.endRow < sheet.rowCount,
    rows,
    sheetName: sheet.name,
  };
}
function formatRange(
  workbook: ExcelJS.Workbook,
  parsed: SpreadsheetInput
): void {
  if (!parsed.format || Object.keys(parsed.format).length === 0) {
    throw new Error("format_range requires formatting properties.");
  }
  const sheet = selectedSheet(workbook, parsed.sheetName);
  const range = resolveRange(parsed, sheet);
  const style = parsed.format;
  for (let r = range.startRow; r <= range.endRow; r += 1) {
    for (let c = range.startCol; c <= range.endCol; c += 1) {
      const cell = sheet.getCell(r, c);
      cell.font = {
        ...cell.font,
        ...(style.bold === undefined ? {} : { bold: style.bold }),
        ...(style.italic === undefined ? {} : { italic: style.italic }),
        ...(style.fontColor ? { color: { argb: `FF${style.fontColor}` } } : {}),
      };
      cell.alignment = {
        ...cell.alignment,
        ...(style.alignment ? { horizontal: style.alignment } : {}),
        ...(style.wrapText === undefined ? {} : { wrapText: style.wrapText }),
      };
      if (style.numberFormat !== undefined) {
        cell.numFmt = style.numberFormat;
      }
      if (style.fillColor) {
        cell.fill = {
          fgColor: { argb: `FF${style.fillColor}` },
          pattern: "solid",
          type: "pattern",
        };
      }
    }
  }
}

async function resolveSpreadsheetPath(
  requested: string,
  parsed: SpreadsheetInput,
  guardOptions: PathGuardOptions,
  existing: boolean
): Promise<string> {
  spreadsheetInputFormat(requested);
  const relative = coerceDeliverableArtifactPath(requested);
  const guarded = await guardFilePath(
    relative,
    parsed.cwd,
    undefined,
    guardOptions
  );
  if (
    !existing ||
    (await spreadsheetExists(guarded.resolved)) ||
    relative === requested
  ) {
    return guarded.resolved;
  }
  const legacy = await guardFilePath(
    requested,
    parsed.cwd,
    undefined,
    guardOptions
  );
  return (await spreadsheetExists(legacy.resolved))
    ? legacy.resolved
    : guarded.resolved;
}
function validateAction(parsed: SpreadsheetInput): void {
  if (
    isLegacySpreadsheet(parsed.path) &&
    (!["inspect", "read_range", "export_xlsx"].includes(parsed.action) ||
      parsed.writeMode === "inplace")
  ) {
    throw new Error(
      "Legacy workbooks support inspect, read_range, and export_xlsx. Export to a new XLSX before editing; the original and macros are not modified."
    );
  }
  if (
    parsed.action === "write_range" &&
    (!parsed.values ||
      parsed.values.length === 0 ||
      parsed.values.every((row) => row.length === 0))
  ) {
    throw new Error("write_range requires nonempty values.");
  }
  if (parsed.action === "delete_sheet" && !parsed.sheetName) {
    throw new Error("delete_sheet requires sheetName.");
  }
  if (parsed.action === "import_csv" && !parsed.csvPath) {
    throw new Error("import_csv requires csvPath.");
  }
  if (
    parsed.action === "export_csv" &&
    (!parsed.targetCsvPath ||
      spreadsheetFormat(parsed.targetCsvPath) !== ".csv")
  ) {
    throw new Error("export_csv requires targetCsvPath ending in .csv.");
  }
  if (
    parsed.action === "export_xlsx" &&
    (!parsed.targetXlsxPath ||
      spreadsheetFormat(parsed.targetXlsxPath) !== ".xlsx")
  ) {
    throw new Error("export_xlsx requires targetXlsxPath ending in .xlsx.");
  }
  if (parsed.writeMode === "inplace" && !parsed.expectedRevision) {
    throw new Error(
      "In-place editing requires expectedRevision from inspect or read_range."
    );
  }
  if (
    (parsed.action === "format_range" || parsed.action === "recalculate") &&
    spreadsheetFormat(parsed.path) !== ".xlsx"
  ) {
    throw new Error(`${parsed.action} requires an XLSX workbook.`);
  }
}

async function mutateWorkbook(
  workbook: ExcelJS.Workbook,
  parsed: SpreadsheetInput,
  guardOptions: PathGuardOptions
): Promise<Record<string, unknown>> {
  switch (parsed.action) {
    case "create":
    case "add_sheet": {
      const sheet = workbook.addWorksheet(
        parsed.sheetName ?? `Sheet${workbook.worksheets.length + 1}`
      );
      if (parsed.columns) {
        addRows(sheet, [parsed.columns], true);
      }
      addRows(
        sheet,
        parsed.data ?? [],
        parsed.literalStrings,
        parsed.columns ? 2 : 1
      );
      return {
        sheetName: sheet.name,
        status: parsed.action === "create" ? "created" : "sheet_added",
      };
    }
    case "write_range": {
      const sheet = selectedSheet(workbook, parsed.sheetName);
      const range = resolveRange(parsed, sheet);
      const values = parsed.values!;
      if (
        (parsed.range?.includes(":") ||
          parsed.endRow !== undefined ||
          parsed.endCol !== undefined) &&
        (values.length !== range.endRow - range.startRow + 1 ||
          values.some(
            (row) => row.length !== range.endCol - range.startCol + 1
          ))
      ) {
        throw new Error(
          "Values must exactly match the explicit target rectangle."
        );
      }
      addRows(
        sheet,
        values,
        parsed.literalStrings,
        range.startRow,
        range.startCol
      );
      return {
        cellsUpdated: values.reduce((count, row) => count + row.length, 0),
        sheetName: sheet.name,
        status: "updated",
      };
    }
    case "format_range":
      formatRange(workbook, parsed);
      return { status: "formatted" };
    case "delete_sheet":
      if (workbook.worksheets.length <= 1) {
        throw new Error("Cannot delete the only sheet in a workbook.");
      }
      workbook.removeWorksheet(selectedSheet(workbook, parsed.sheetName).id);
      return { sheetName: parsed.sheetName, status: "sheet_deleted" };
    case "import_csv": {
      if (spreadsheetFormat(parsed.csvPath!) !== ".csv") {
        throw new Error("import_csv requires a .csv source.");
      }
      const source = await guardFilePath(
        parsed.csvPath!,
        parsed.cwd,
        undefined,
        guardOptions
      );
      const rows = parseSpreadsheetCsv(
        (await readSpreadsheetBytes(source.resolved)).toString("utf8"),
        {
          columnTypes: parsed.columnTypes,
          decimalSeparator: parsed.decimalSeparator,
          delimiter: parsed.delimiter,
          header: parsed.csvHeader,
        }
      );
      const sheetName =
        parsed.sheetName ??
        path
          .basename(source.resolved, path.extname(source.resolved))
          .slice(0, 31);
      const existing = workbook.getWorksheet(sheetName);
      if (existing) {
        workbook.removeWorksheet(existing.id);
      }
      addRows(workbook.addWorksheet(sheetName), rows, true);
      return { importedRows: rows.length, sheetName, status: "csv_imported" };
    }
    default:
      return {
        status:
          parsed.action === "export_csv" ? "csv_exported" : "xlsx_exported",
      };
  }
}

export const spreadsheetTool: ToolDefinition = {
  description:
    "Create, read, edit, format, recalculate, and export XLSX/CSV/JSON spreadsheets. Inspect/read XLS/XLSM/XLSB inputs and export_xlsx to a new editable XLSX; legacy macros are not preserved. Edits save a new version: follow the returned path. CSV imports preserve text; formula results carry calculation status. XLS/XLSB conversion and recalculation require LibreOffice on the Atlas host.",
  name: "spreadsheet",
  parallelSafe: false,
  parameters: jsonSchemaFromZod(SpreadsheetInputSchema),
  async run(input: unknown, context: ToolContext) {
    const parsed = SpreadsheetInputSchema.parse(input);
    validateAction(parsed);
    context.signal?.throwIfAborted();
    const requestedWorkspaceRoot =
      context.workspaceRoot?.trim() ||
      (context.orgId && context.profileId
        ? getProfileSoulDir(context.orgId, context.profileId)
        : "");
    if (!requestedWorkspaceRoot) {
      throw new Error("A profile workspace is required.");
    }
    await mkdir(requestedWorkspaceRoot, { recursive: true });
    const workspaceRoot = await realpath(requestedWorkspaceRoot);
    const guardOptions: PathGuardOptions = {
      allowedDirs: [workspaceRoot],
      cwd: workspaceRoot,
    };
    const filePath = await resolveSpreadsheetPath(
      parsed.path,
      parsed,
      guardOptions,
      parsed.action !== "create"
    );
    return await withSpreadsheetWrite(filePath, async () => {
      const sourceExists = await spreadsheetExists(filePath);
      const loaded =
        parsed.action === "create" ||
        (parsed.action === "import_csv" && !sourceExists)
          ? undefined
          : await loadWorkbook(filePath, parsed, context.signal);
      if (
        parsed.expectedRevision &&
        loaded?.revision !== parsed.expectedRevision &&
        parsed.action !== "create"
      ) {
        throw new Error(
          "Spreadsheet changed since it was read. Inspect it again before editing."
        );
      }
      const workbook = loaded?.workbook ?? new ExcelJS.Workbook();
      if (parsed.action === "inspect") {
        if (loaded?.unsupportedInspection) {
          return boundedSpreadsheetResponse({
            ...loaded.unsupportedInspection,
            conversion: loaded.conversion,
            path: path.relative(workspaceRoot, filePath),
            revision: loaded.revision,
          });
        }
        return boundedSpreadsheetResponse({
          conversion: loaded?.conversion,
          path: path.relative(workspaceRoot, filePath),
          revision: loaded!.revision,
          sheetCount: workbook.worksheets.length,
          sheets: inspectWorkbook(workbook, loaded?.calculationStatus),
          ...(loaded?.preserveChartParts
            ? {
                editable: true,
                supportedActions: [
                  "inspect",
                  "read_range",
                  "write_range",
                  "export_csv",
                ],
              }
            : {}),
        });
      }
      if (parsed.action === "read_range") {
        return boundedSpreadsheetResponse({
          conversion: loaded?.conversion,
          path: path.relative(workspaceRoot, filePath),
          revision: loaded!.revision,
          ...readRange(workbook, parsed, loaded?.calculationStatus),
        });
      }
      const target =
        parsed.action === "export_csv"
          ? parsed.targetCsvPath
          : parsed.action === "export_xlsx"
            ? parsed.targetXlsxPath
            : undefined;
      const destination = target
        ? await resolveSpreadsheetPath(target, parsed, guardOptions, false)
        : filePath;
      if (target && parsed.writeMode === "inplace") {
        throw new Error(
          "Exports create new versions. Edit the destination separately for in-place changes."
        );
      }
      const report = await mutateWorkbook(workbook, parsed, guardOptions);
      if (
        parsed.action === "import_csv" &&
        !loaded &&
        spreadsheetFormat(destination) === ".xlsx"
      ) {
        report.layout = formatNewCsvWorksheet(
          selectedSheet(workbook, String(report.sheetName))
        );
      }
      let calculationStatus: SpreadsheetCalculationStatus | undefined =
        loaded?.calculationStatus;
      if (
        [
          "create",
          "write_range",
          "format_range",
          "add_sheet",
          "delete_sheet",
          "import_csv",
        ].includes(parsed.action)
      ) {
        invalidateSpreadsheetCalculation(workbook);
        calculationStatus = undefined;
      }
      let bytes: Buffer;
      if (parsed.action === "recalculate") {
        const calculated = await recalculateSpreadsheet(
          loaded!.bytes,
          context.signal
        );
        bytes = Buffer.from(
          preserveSpreadsheetMetadata(
            inspectSpreadsheetArchive(loaded!.bytes),
            calculated.bytes
          )
        );
        Object.assign(report, {
          calculationStatus: "recalculated",
          engine: calculated.engine,
          formulaErrorCount: calculated.formulaErrorCount,
          formulaErrors: calculated.formulaErrors,
          status: "recalculated",
        });
        calculationStatus = "recalculated";
      } else if (
        loaded?.preserveChartParts &&
        parsed.action === "write_range"
      ) {
        const sheet = selectedSheet(workbook, parsed.sheetName);
        const range = resolveRange(parsed, sheet);
        assertWorkbookBounds(workbook);
        bytes = Buffer.from(
          writeSpreadsheetCellsPreservingParts({
            literalStrings: parsed.literalStrings,
            parts: inspectSpreadsheetArchive(loaded.bytes),
            sheetName: sheet.name,
            startCol: range.startCol,
            startRow: range.startRow,
            values: parsed.values!,
          })
        );
        Object.assign(report, {
          chartDataStatus: "refresh_on_open",
          formulaCalculationStatus: "stale",
          preservedFeatures: ["charts", "drawings", "relationships"],
        });
      } else {
        bytes = await serializeWorkbook(
          destination,
          workbook,
          parsed,
          report,
          calculationStatus
        );
        if (
          loaded &&
          spreadsheetInputFormat(filePath) === ".xlsx" &&
          spreadsheetFormat(destination) === ".xlsx"
        ) {
          bytes = Buffer.from(
            preserveSpreadsheetMetadata(
              inspectSpreadsheetArchive(loaded.bytes),
              bytes,
              parsed.action === "import_csv"
                ? String(report.sheetName)
                : undefined
            )
          );
        }
      }
      const published = await publishSpreadsheet({
        bytes,
        expectedRevision: parsed.expectedRevision,
        path: destination,
        signal: context.signal,
        writeMode: parsed.writeMode,
      });
      await stampArtifactLineage({
        extraDetails: { sheetCount: workbook.worksheets.length },
        parentFilePath:
          sourceExists && published.path !== filePath ? filePath : undefined,
        sizeBytes: bytes.length,
        writtenPath: published.path,
      });
      if (
        calculationStatus === "recalculated" &&
        spreadsheetFormat(published.path) === ".xlsx"
      ) {
        await recordSpreadsheetCalculation(published.path, published.revision);
      }
      const publicationPath = path
        .relative(workspaceRoot, published.path)
        .split(path.sep)
        .join("/");
      if (isArtifactPublicationPath(publicationPath)) {
        await stageToolArtifact(context.artifactPublisher, {
          bytes,
          sourcePath: publicationPath,
        });
      }
      return boundedSpreadsheetResponse({
        ...report,
        bytesWritten: bytes.length,
        conversion: loaded?.conversion,
        path: path.relative(workspaceRoot, published.path),
        revision: published.revision,
        sourcePath: sourceExists
          ? path.relative(workspaceRoot, filePath)
          : undefined,
        ...(parsed.action === "export_csv"
          ? {
              exportedRows: selectedSheet(workbook, parsed.sheetName).rowCount,
              targetCsvPath: path.relative(workspaceRoot, published.path),
            }
          : {}),
        ...(parsed.action === "export_xlsx"
          ? { targetXlsxPath: path.relative(workspaceRoot, published.path) }
          : {}),
      });
    });
  },
};

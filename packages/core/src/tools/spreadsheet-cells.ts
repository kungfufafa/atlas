import type ExcelJS from "exceljs";
import {
  type DelimitedTextDelimiter,
  parseDelimitedText,
} from "../delimited-text";
import {
  MAX_SPREADSHEET_CELL_BYTES,
  MAX_SPREADSHEET_CELLS,
  MAX_SPREADSHEET_COLUMNS,
  MAX_SPREADSHEET_ROWS,
} from "./spreadsheet-io";

export type SpreadsheetPrimitive = string | number | boolean | null;
export type SpreadsheetColumnType = "text" | "number" | "boolean";
export type SpreadsheetCalculationStatus =
  | "pending"
  | "unverified"
  | "recalculated";
export type SpreadsheetCellValue =
  | SpreadsheetPrimitive
  | {
      cachedResult?: SpreadsheetPrimitive | { error: string };
      calculationStatus: SpreadsheetCalculationStatus;
      formula: string;
    };

export function sanitizeCsvFormulaInjection(cell: string): string {
  return /^[=+\-@\t\r]/.test(cell) ? `'${cell}` : cell;
}

export function parseSpreadsheetCsv(
  content: string,
  options: {
    columnTypes?: SpreadsheetColumnType[];
    decimalSeparator?: "." | ",";
    delimiter?: DelimitedTextDelimiter;
    header?: boolean;
  } = {}
): SpreadsheetPrimitive[][] {
  const parsed = parseDelimitedText(content.replace(/^\uFEFF/, ""), {
    delimiter: options.delimiter,
    maxCellBytes: MAX_SPREADSHEET_CELL_BYTES,
    maxColumns: MAX_SPREADSHEET_COLUMNS,
    maxRows: MAX_SPREADSHEET_ROWS,
  });
  if (
    parsed.truncated ||
    parsed.rowCount * parsed.columnCount > MAX_SPREADSHEET_CELLS
  ) {
    throw new Error(
      "CSV exceeds spreadsheet row, column, cell, or text limits. Split the input before importing."
    );
  }
  return parsed.rows.map((row, rowIndex) =>
    row.map((value, columnIndex) => {
      const type =
        options.header && rowIndex === 0
          ? "text"
          : (options.columnTypes?.[columnIndex] ?? "text");
      if (type === "text") {
        return value;
      }
      if (value === "") {
        return null;
      }
      if (type === "boolean" && /^(true|false)$/i.test(value)) {
        return value.toLowerCase() === "true";
      }
      const numericText =
        options.decimalSeparator === "," ? value.replace(",", ".") : value;
      const localeConflict =
        options.decimalSeparator === "," && value.includes(".");
      if (
        type === "number" &&
        !localeConflict &&
        /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(numericText)
      ) {
        const numeric = Number(numericText);
        const significant = numericText
          .replace(/^[+-]?0*/, "")
          .split(/[eE]/)[0]!
          .replace(".", "")
          .replace(/0+$/, "");
        if (
          Number.isFinite(numeric) &&
          significant.length <= 15 &&
          (!Number.isInteger(numeric) || Number.isSafeInteger(numeric))
        ) {
          return numeric;
        }
      }
      throw new Error(
        `CSV cell R${rowIndex + 1}C${columnIndex + 1} cannot be converted losslessly to ${type}. Import that column as text.`
      );
    })
  );
}

export function assertWorkbookBounds(workbook: ExcelJS.Workbook): void {
  if (workbook.worksheets.length < 1 || workbook.worksheets.length > 64) {
    throw new Error("A spreadsheet must contain between 1 and 64 sheets.");
  }
  let cells = 0;
  for (const sheet of workbook.worksheets) {
    cells += sheet.rowCount * sheet.columnCount;
    if (
      sheet.rowCount > MAX_SPREADSHEET_ROWS ||
      sheet.columnCount > MAX_SPREADSHEET_COLUMNS ||
      cells > MAX_SPREADSHEET_CELLS
    ) {
      throw new Error(
        "Workbook exceeds the 100000-row, 256-column, or 500000-cell limit."
      );
    }
    sheet.eachRow((row) =>
      row.eachCell((cell) => {
        if (
          Buffer.byteLength(JSON.stringify(cell.value) ?? "") >
          MAX_SPREADSHEET_CELL_BYTES
        ) {
          throw new Error(
            `Cell ${sheet.name}!${cell.address} exceeds the text limit.`
          );
        }
      })
    );
  }
}

export function assignSpreadsheetCell(
  cell: ExcelJS.Cell,
  value: SpreadsheetPrimitive,
  literal = false
): void {
  if (typeof value === "string" && !literal && value.startsWith("=")) {
    if (value.length === 1) {
      throw new Error("A formula must contain an expression after '='.");
    }
    cell.value = { formula: value.slice(1) };
  } else {
    cell.value = value;
  }
}

function normalizeScalar(
  value: ExcelJS.CellValue
): SpreadsheetPrimitive | { error: string } {
  if (value == null) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value !== "object") {
    return value;
  }
  if ("richText" in value) {
    return value.richText.map((part) => part.text).join("");
  }
  if ("text" in value) {
    return value.text;
  }
  if ("error" in value) {
    return { error: value.error };
  }
  throw new Error(
    "Unsupported cell value. Use XLSX export to retain workbook structure."
  );
}

export function spreadsheetCellValue(
  cell: ExcelJS.Cell,
  status?: SpreadsheetCalculationStatus
): SpreadsheetCellValue | { error: string } {
  if (cell.formula) {
    const cachedResult =
      cell.result === undefined ? undefined : normalizeScalar(cell.result);
    return {
      calculationStatus:
        status ?? (cachedResult === undefined ? "pending" : "unverified"),
      formula: `=${cell.formula}`,
      ...(cachedResult === undefined ? {} : { cachedResult }),
    };
  }
  return normalizeScalar(cell.value);
}

export function invalidateSpreadsheetCalculation(
  workbook: ExcelJS.Workbook
): void {
  // Keep shared/array formula metadata while removing every obsolete cache.
  for (const sheet of workbook.worksheets) {
    sheet.eachRow((row) =>
      row.eachCell((cell) => {
        const value = cell.value;
        if (
          value &&
          typeof value === "object" &&
          ("formula" in value || "sharedFormula" in value)
        ) {
          const formula = { ...value };
          delete formula.result;
          cell.value = formula;
        }
      })
    );
  }
  workbook.calcProperties.fullCalcOnLoad = true;
}

export function formatSpreadsheetCsv(
  sheet: ExcelJS.Worksheet,
  options: {
    calculationStatus?: SpreadsheetCalculationStatus;
    delimiter?: DelimitedTextDelimiter;
    escapeFormulas?: boolean;
    formulaExport?: "formulas" | "values";
  } = {}
): { content: string; escapedCellCount: number } {
  const rows: string[] = [];
  let escapedCellCount = 0;
  for (let r = 1; r <= sheet.rowCount; r += 1) {
    const values: string[] = [];
    for (let c = 1; c <= sheet.columnCount; c += 1) {
      const cell = sheet.getCell(r, c);
      let value = spreadsheetCellValue(cell, options.calculationStatus);
      if (value && typeof value === "object" && "formula" in value) {
        if (options.formulaExport === "values") {
          if (
            value.calculationStatus !== "recalculated" ||
            value.cachedResult === undefined
          ) {
            throw new Error(
              "Formula values are not verified. Run recalculate before exporting values, or export formulas as text."
            );
          }
          value = value.cachedResult;
        } else {
          value = value.formula;
        }
      }
      const primitive =
        value && typeof value === "object" ? value.error : value;
      let text = primitive == null ? "" : String(primitive);
      // Numbers, including negatives, remain numbers. Only text can introduce
      // spreadsheet commands when a CSV is opened by another application.
      if (typeof primitive === "string" && options.escapeFormulas !== false) {
        const escaped = sanitizeCsvFormulaInjection(text);
        escapedCellCount += Number(escaped !== text);
        text = escaped;
      }
      if (text.includes(options.delimiter ?? ",") || /["\r\n]/.test(text)) {
        text = `"${text.replaceAll('"', '""')}"`;
      }
      values.push(text);
    }
    rows.push(values.join(options.delimiter ?? ","));
  }
  return { content: rows.join("\n"), escapedCellCount };
}

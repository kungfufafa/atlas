import {
  type DelimitedTextDelimiter,
  parseDelimitedText,
} from "../../delimited-text";
import type { ArtifactFileTarget, ArtifactPreviewer } from "../previewer";
import {
  PREVIEW_VERSION,
  type PreviewContext,
  type PreviewMetadata,
  type PreviewOptions,
  type SpreadsheetCellFormat,
  type SpreadsheetPreview,
  type SpreadsheetSheetData,
} from "../types";

const DEFAULT_MAX_ROWS = 500;
const DEFAULT_MAX_COLS = 50;
const DEFAULT_MAX_CELL_BYTES = 64 * 1024;

function boundedPreviewLimit(requested: number, maximum: number): number {
  if (!Number.isFinite(requested)) {
    return maximum;
  }
  return Math.min(Math.max(Math.trunc(requested), 0), maximum);
}

function coerceDelimitedCell(value: string): string | number | boolean | null {
  if (value === "") {
    return null;
  }
  if (value.trim() !== value) {
    return value;
  }
  if (value.toLowerCase() === "true") {
    return true;
  }
  if (value.toLowerCase() === "false") {
    return false;
  }
  const numberValue = Number(value);
  if (
    !(Number.isNaN(numberValue) || value.startsWith("0")) &&
    value.length < 15
  ) {
    return numberValue;
  }
  return value;
}

function parseCsvBuffer(
  buffer: Buffer,
  maxRows = DEFAULT_MAX_ROWS,
  maxCols = DEFAULT_MAX_COLS,
  delimiterOverride?: DelimitedTextDelimiter
): SpreadsheetSheetData {
  const text = buffer.toString("utf8");
  const parsed = parseDelimitedText(text, {
    delimiter: delimiterOverride,
    maxCellBytes: DEFAULT_MAX_CELL_BYTES,
    maxColumns: boundedPreviewLimit(maxCols, DEFAULT_MAX_COLS),
    maxRows: boundedPreviewLimit(maxRows, DEFAULT_MAX_ROWS),
  });
  const data = parsed.rows.map((row) => row.map(coerceDelimitedCell));

  const headers = data.length > 0 ? (data[0].map(String) as string[]) : [];

  return {
    columnCount: parsed.columnCount,
    data,
    headers,
    name: "Sheet1",
    rowCount: parsed.rowCount,
  };
}

function colLetterToNumber(letter: string): number {
  let result = 0;
  for (let i = 0; i < letter.length; i++) {
    result = result * 26 + (letter.charCodeAt(i) - 64);
  }
  return result;
}

export function parseRangeQuery(rangeStr?: string): {
  endCol: number;
  endRow: number;
  startCol: number;
  startRow: number;
} | null {
  if (!rangeStr) {
    return null;
  }
  const match = rangeStr
    .trim()
    .match(/^([A-Za-z]+)(\d+)(?::([A-Za-z]+)(\d+))?$/);
  if (!match) {
    return null;
  }

  const startCol = colLetterToNumber(match[1].toUpperCase());
  const startRow = Number.parseInt(match[2], 10);
  const endCol = match[3]
    ? colLetterToNumber(match[3].toUpperCase())
    : startCol;
  const endRow = match[4] ? Number.parseInt(match[4], 10) : startRow;

  return {
    endCol: Math.max(startCol, endCol),
    endRow: Math.max(startRow, endRow),
    startCol: Math.min(startCol, endCol),
    startRow: Math.min(startRow, endRow),
  };
}

export class SpreadsheetPreviewer implements ArtifactPreviewer {
  readonly type = "spreadsheet" as const;

  supports(artifact: { filename: string; mimeType: string }): boolean {
    const lowerName = artifact.filename.toLowerCase();
    return (
      lowerName.endsWith(".xlsx") ||
      lowerName.endsWith(".csv") ||
      lowerName.endsWith(".tsv") ||
      lowerName.endsWith(".xls") ||
      artifact.mimeType ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      artifact.mimeType === "text/csv" ||
      artifact.mimeType === "text/tab-separated-values" ||
      artifact.mimeType === "application/vnd.ms-excel"
    );
  }

  async inspect(
    artifact: ArtifactFileTarget,
    buffer: Buffer,
    _context: PreviewContext
  ): Promise<PreviewMetadata> {
    const lowerName = artifact.filename.toLowerCase();
    const isDelimited =
      lowerName.endsWith(".csv") ||
      lowerName.endsWith(".tsv") ||
      artifact.mimeType === "text/csv" ||
      artifact.mimeType === "text/tab-separated-values";
    const isTsv =
      lowerName.endsWith(".tsv") ||
      artifact.mimeType === "text/tab-separated-values";
    const isLegacyXls =
      lowerName.endsWith(".xls") && !lowerName.endsWith(".xlsx");

    if (
      isLegacyXls &&
      (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b)
    ) {
      return {
        metadata: { isLegacy: true },
        status: "unsupported",
        summary: "Legacy Excel (.xls) binary file",
        type: "spreadsheet",
      };
    }

    if (isDelimited) {
      const parsed = parseCsvBuffer(
        buffer,
        5,
        DEFAULT_MAX_COLS,
        isTsv ? "\t" : undefined
      );
      return {
        metadata: {
          columnCount: parsed.columnCount,
          isCsv: true,
          rowCount: parsed.rowCount,
          sheetCount: 1,
          sheetNames: ["Sheet1"],
        },
        status: "available",
        summary: `${isTsv ? "TSV" : "CSV"} · 1 sheet · ${parsed.rowCount} rows`,
        type: "spreadsheet",
      };
    }

    try {
      const ExcelJS = (await import("exceljs")).default;
      const workbook = new ExcelJS.Workbook();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await workbook.xlsx.load(buffer as any);

      const sheetNames = workbook.worksheets.map((ws) => ws.name);
      let totalRows = 0;
      let maxCols = 0;

      for (const ws of workbook.worksheets) {
        totalRows += ws.rowCount || 0;
        if ((ws.columnCount || 0) > maxCols) {
          maxCols = ws.columnCount;
        }
      }

      return {
        metadata: {
          columnCount: maxCols,
          isCsv: false,
          rowCount: totalRows,
          sheetCount: workbook.worksheets.length,
          sheetNames,
        },
        status: "available",
        summary: `Excel Workbook · ${workbook.worksheets.length} sheet${workbook.worksheets.length === 1 ? "" : "s"} · ${totalRows} rows`,
        type: "spreadsheet",
      };
    } catch {
      return {
        metadata: { isCsv: false, sheetCount: 1, sheetNames: ["Sheet1"] },
        status: "available",
        summary: "Excel Workbook",
        type: "spreadsheet",
      };
    }
  }

  async generate(
    artifact: ArtifactFileTarget,
    buffer: Buffer,
    options: PreviewOptions,
    context: PreviewContext
  ): Promise<SpreadsheetPreview> {
    const lowerName = artifact.filename.toLowerCase();
    const isDelimited =
      lowerName.endsWith(".csv") ||
      lowerName.endsWith(".tsv") ||
      artifact.mimeType === "text/csv" ||
      artifact.mimeType === "text/tab-separated-values";
    const isTsv =
      lowerName.endsWith(".tsv") ||
      artifact.mimeType === "text/tab-separated-values";
    const isLegacyXls =
      lowerName.endsWith(".xls") && !lowerName.endsWith(".xlsx");
    const targetPath = artifact.path || artifact.filename;
    const downloadUrl = `/v1/profiles/${encodeURIComponent(context.profileId)}/artifacts/content?path=${encodeURIComponent(targetPath)}`;

    if (
      isLegacyXls &&
      (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b)
    ) {
      return {
        activeSheet: {
          columnCount: 0,
          data: [],
          name: "Sheet1",
          rowCount: 0,
        },
        activeSheetIndex: 0,
        artifactId: artifact.artifactId,
        downloadUrl,
        error:
          "Legacy Excel (.xls) binary file is not supported for inline preview. You can still download the original.",
        filename: artifact.filename,
        generatedAt: new Date().toISOString(),
        mimeType: artifact.mimeType || "application/vnd.ms-excel",
        previewVersion: PREVIEW_VERSION,
        revision: artifact.revision,
        sheetNames: ["Sheet1"],
        sizeBytes: artifact.sizeBytes || buffer.length,
        status: "unsupported",
        totalSheets: 1,
        type: "spreadsheet",
      };
    }

    if (isDelimited) {
      const activeSheet = parseCsvBuffer(
        buffer,
        options.maxLines ?? DEFAULT_MAX_ROWS,
        DEFAULT_MAX_COLS,
        isTsv ? "\t" : undefined
      );
      return {
        activeSheet,
        activeSheetIndex: 0,
        artifactId: artifact.artifactId,
        downloadUrl,
        filename: artifact.filename,
        generatedAt: new Date().toISOString(),
        metadata: {
          isCsv: true,
          totalColumns: activeSheet.columnCount,
          totalRows: activeSheet.rowCount,
        },
        mimeType:
          artifact.mimeType ||
          (isTsv ? "text/tab-separated-values" : "text/csv"),
        previewVersion: PREVIEW_VERSION,
        revision: artifact.revision,
        sheetNames: ["Sheet1"],
        sheetsSummary: [
          {
            columnCount: activeSheet.columnCount,
            name: "Sheet1",
            rowCount: activeSheet.rowCount,
          },
        ],
        sizeBytes: artifact.sizeBytes || buffer.length,
        status: "available",
        totalSheets: 1,
        type: "spreadsheet",
      };
    }

    try {
      const ExcelJS = (await import("exceljs")).default;
      const workbook = new ExcelJS.Workbook();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await workbook.xlsx.load(buffer as any);

      const sheetNames = workbook.worksheets.map((ws) => ws.name);
      const sheetsSummary = workbook.worksheets.map((ws) => ({
        columnCount: ws.columnCount || 0,
        name: ws.name,
        rowCount: ws.rowCount || 0,
      }));

      // Determine active sheet
      let activeIndex = 0;
      if (options.sheet) {
        const found = sheetNames.indexOf(options.sheet);
        if (found !== -1) {
          activeIndex = found;
        }
      } else if (
        options.sheetIndex !== undefined &&
        options.sheetIndex >= 0 &&
        options.sheetIndex < workbook.worksheets.length
      ) {
        activeIndex = options.sheetIndex;
      }

      const targetWorksheet =
        workbook.worksheets[activeIndex] || workbook.worksheets[0];
      const parsedRange = parseRangeQuery(options.range);

      const startRow = parsedRange ? parsedRange.startRow : 1;
      const maxRows = options.maxLines ?? DEFAULT_MAX_ROWS;
      const endRow = parsedRange
        ? Math.min(parsedRange.endRow, targetWorksheet?.rowCount || 0)
        : Math.min(targetWorksheet?.rowCount || 0, maxRows);

      const startCol = parsedRange ? parsedRange.startCol : 1;
      const endCol = parsedRange
        ? Math.min(
            parsedRange.endCol,
            targetWorksheet?.columnCount || DEFAULT_MAX_COLS
          )
        : Math.min(targetWorksheet?.columnCount || 0, DEFAULT_MAX_COLS);

      const data: (string | number | boolean | null)[][] = [];
      const cellFormats: Record<string, SpreadsheetCellFormat> = {};
      const mergedCells: Array<{
        e: { c: number; r: number };
        s: { c: number; r: number };
      }> = [];

      if (targetWorksheet) {
        for (let r = startRow; r <= endRow; r++) {
          const row = targetWorksheet.getRow(r);
          const rowValues: (string | number | boolean | null)[] = [];

          for (let c = startCol; c <= endCol; c++) {
            const cell = row.getCell(c);
            let val: string | number | boolean | null = null;

            if (cell.value !== null && cell.value !== undefined) {
              if (typeof cell.value === "object") {
                // Formula or rich text or date
                if (cell.value instanceof Date) {
                  val = cell.value.toISOString().split("T")[0];
                } else if (
                  "result" in cell.value &&
                  cell.value.result !== undefined
                ) {
                  val = cell.value.result as string | number;
                } else if (
                  "text" in cell.value &&
                  cell.value.text !== undefined
                ) {
                  val = String(cell.value.text);
                } else if (
                  "richText" in cell.value &&
                  Array.isArray(cell.value.richText)
                ) {
                  val = cell.value.richText
                    .map((t: { text: string }) => t.text)
                    .join("");
                } else {
                  val = String(cell.text || "");
                }
              } else if (
                typeof cell.value === "number" ||
                typeof cell.value === "boolean"
              ) {
                val = cell.value;
              } else {
                val = String(cell.value);
              }
            }

            rowValues.push(val);

            // Record format if cell has styling
            const cellKey = `${r - startRow}:${c - startCol}`;
            const format: SpreadsheetCellFormat = {};
            let hasFormat = false;

            if (cell.font?.bold) {
              format.bold = true;
              hasFormat = true;
            }
            if (cell.alignment?.horizontal) {
              format.align = cell.alignment.horizontal as
                | "left"
                | "center"
                | "right";
              hasFormat = true;
            }
            if (cell.numFmt) {
              format.formatCode = cell.numFmt;
              if (
                cell.numFmt.includes("$") ||
                cell.numFmt.includes("€") ||
                cell.numFmt.includes("£")
              ) {
                format.type = "currency";
              } else if (cell.numFmt.includes("%")) {
                format.type = "percentage";
              } else if (
                cell.numFmt.includes("yy") ||
                cell.numFmt.includes("mm") ||
                cell.numFmt.includes("dd")
              ) {
                format.type = "date";
              }
              hasFormat = true;
            }

            if (hasFormat) {
              cellFormats[cellKey] = format;
            }
          }

          data.push(rowValues);
        }
      }

      const activeSheetData: SpreadsheetSheetData = {
        cellFormats,
        columnCount: targetWorksheet?.columnCount || (data[0]?.length ?? 0),
        data,
        headers: data[0] ? data[0].map(String) : [],
        mergedCells,
        name: targetWorksheet?.name || "Sheet1",
        rowCount: targetWorksheet?.rowCount || data.length,
      };

      let totalWorkbookRows = 0;
      for (const summary of sheetsSummary) {
        totalWorkbookRows += summary.rowCount;
      }

      return {
        activeSheet: activeSheetData,
        activeSheetIndex: activeIndex,
        artifactId: artifact.artifactId,
        downloadUrl,
        filename: artifact.filename,
        generatedAt: new Date().toISOString(),
        metadata: {
          isCsv: false,
          totalColumns: activeSheetData.columnCount,
          totalRows: totalWorkbookRows,
        },
        mimeType:
          artifact.mimeType ||
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        previewVersion: PREVIEW_VERSION,
        revision: artifact.revision,
        sheetNames,
        sheetsSummary,
        sizeBytes: artifact.sizeBytes || buffer.length,
        status: "available",
        totalSheets: workbook.worksheets.length,
        type: "spreadsheet",
      };
    } catch {
      // Fallback empty preview
      return {
        activeSheet: {
          columnCount: 0,
          data: [],
          name: "Sheet1",
          rowCount: 0,
        },
        activeSheetIndex: 0,
        artifactId: artifact.artifactId,
        downloadUrl,
        error: "Failed to parse workbook",
        filename: artifact.filename,
        generatedAt: new Date().toISOString(),
        mimeType: artifact.mimeType,
        previewVersion: PREVIEW_VERSION,
        sheetNames: ["Sheet1"],
        sizeBytes: artifact.sizeBytes || buffer.length,
        status: "failed",
        totalSheets: 1,
        type: "spreadsheet",
      };
    }
  }
}

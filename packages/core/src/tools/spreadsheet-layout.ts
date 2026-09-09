import type ExcelJS from "exceljs";

const WIDE_CHARACTER =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}]/u;
const COMBINING_CHARACTER = /\p{Mark}/u;
const MIN_COLUMN_WIDTH = 12;
const MAX_COLUMN_WIDTH = 48;
const MAX_ROW_HEIGHT = 409;

function displayWidth(text: string): number {
  let width = 0;
  for (const character of text) {
    if (character === "\t") {
      width += 4;
    } else if (WIDE_CHARACTER.test(character)) {
      width += 2;
    } else if (!COMBINING_CHARACTER.test(character)) {
      width += 1;
    }
  }
  return width;
}

/** CSV has no source layout to preserve. Apply bounded, conservative sizing
 * only when creating a new workbook, never when opening an existing workbook.
 */
export function formatNewCsvWorksheet(sheet: ExcelJS.Worksheet) {
  const widths = Array.from(
    { length: sheet.columnCount },
    () => MIN_COLUMN_WIDTH
  );
  sheet.eachRow((row) =>
    row.eachCell((cell, column) => {
      const width =
        Math.max(
          ...String(cell.value ?? "")
            .split(/\r?\n/)
            .map(displayWidth)
        ) + 2;
      widths[column - 1] = Math.min(
        MAX_COLUMN_WIDTH,
        Math.max(widths[column - 1]!, width)
      );
    })
  );
  for (const [index, width] of widths.entries()) {
    sheet.getColumn(index + 1).width = width;
  }
  let rowsClamped = 0;
  sheet.eachRow((row) => {
    let lines = 1;
    row.eachCell((cell, column) => {
      cell.alignment = { ...cell.alignment, vertical: "top", wrapText: true };
      const wrapped = String(cell.value ?? "")
        .split(/\r?\n/)
        .reduce(
          (total, line) =>
            total +
            Math.max(
              1,
              Math.ceil(
                displayWidth(line) / Math.max(1, widths[column - 1]! - 2)
              )
            ),
          0
        );
      lines = Math.max(lines, wrapped);
    });
    const height = lines * 15 + 6;
    if (height > MAX_ROW_HEIGHT) {
      rowsClamped += 1;
    }
    row.height = Math.min(MAX_ROW_HEIGHT, height);
  });
  return {
    columnsSized: widths.length,
    estimated: true,
    rowsClamped,
    wrapped: true,
  };
}

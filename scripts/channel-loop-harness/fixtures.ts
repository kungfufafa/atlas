import ExcelJS from "../../packages/core/node_modules/exceljs/excel.js";

export const SALES_MARKER = "CHANNEL_LOOP_SALES";
export const NOTES_MARKER = "CHANNEL_LOOP_NOTES";
export const RESULT_XLSX = "channel-loop-result.xlsx";
export const RESULT_MD = "channel-loop-summary.md";

export const XLSX_MEDIA_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const CSV_BODY = [
  "sku,qty,revenue",
  `${SALES_MARKER},2,100`,
  "WIDGET,5,250",
  "GADGET,3,180",
  "",
].join("\n");

const NOTES_BODY = `${NOTES_MARKER}\nClean these notes and save a markdown summary.\n`;

export interface FileFixture {
  bytes: Buffer;
  filename: string;
  mediaType: string;
}

export function salesCsv(): FileFixture {
  return {
    bytes: Buffer.from(CSV_BODY, "utf8"),
    filename: "sales.csv",
    mediaType: "text/csv",
  };
}

export function notesTxt(): FileFixture {
  return {
    bytes: Buffer.from(NOTES_BODY, "utf8"),
    filename: "notes.txt",
    mediaType: "text/plain",
  };
}

export async function salesXlsx(): Promise<FileFixture> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sales");
  sheet.addRow(["sku", "qty", "revenue"]);
  sheet.addRow([SALES_MARKER, 2, 100]);
  sheet.addRow(["WIDGET", 5, 250]);
  const buffer = await workbook.xlsx.writeBuffer();
  return {
    bytes: Buffer.from(buffer),
    filename: "sales.xlsx",
    mediaType: XLSX_MEDIA_TYPE,
  };
}

export function zipArchive(): FileFixture {
  return {
    bytes: Buffer.from("PK\u0003\u0004fake-zip", "binary"),
    filename: "archive.zip",
    mediaType: "application/zip",
  };
}

export function isZipMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

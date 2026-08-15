export async function inspectSpreadsheetBuffer(buffer: Buffer): Promise<{
  columnCount: number;
  rowCount: number;
  sheetCount: number;
  sheetNames: string[];
}> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as any);
  const sheetNames = workbook.worksheets.map((s) => s.name);
  const firstSheet = workbook.worksheets[0];

  return {
    columnCount: firstSheet?.columnCount ?? 0,
    rowCount: firstSheet?.rowCount ?? 0,
    sheetCount: workbook.worksheets.length,
    sheetNames,
  };
}

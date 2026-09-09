import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { unzipSync, zipSync } from "fflate";
import { officeConverter } from "../artifact-preview/office-converter";
import { spreadsheetTool } from "./spreadsheet";
import { spreadsheetRevision } from "./spreadsheet-io";

let conversion: ReturnType<typeof spyOn> | undefined;
afterEach(() => conversion?.mockRestore());

async function workbookBytes() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Orders");
  sheet.addRows([
    ["Code", "Amount", "Active"],
    ["00123", 12.5, true],
  ]);
  sheet.getCell("B3").value = { formula: "B2*2", result: 25 };
  workbook.addWorksheet("Notes").getCell("A1").value = "Original notes";
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function withWorkbook(
  extension: string,
  bytes: Buffer,
  run: (input: {
    directory: string;
    source: string;
    execute: (
      args: Record<string, unknown>
    ) => Promise<Record<string, unknown>>;
  }) => Promise<void>
) {
  const directory = await mkdtemp(path.join(tmpdir(), "atlas-legacy-sheet-"));
  const source = `source.${extension}`;
  await writeFile(path.join(directory, source), bytes);
  try {
    await run({
      directory,
      execute: async (args) =>
        (await spreadsheetTool.run(
          { path: source, ...args },
          { workspaceRoot: directory }
        )) as Record<string, unknown>,
      source,
    });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test("XLSM cells and formulas can be read and exported as editable XLSX without modifying or copying macros", async () => {
  const parts = unzipSync(await workbookBytes());
  parts["[Content_Types].xml"] = Buffer.from(
    Buffer.from(parts["[Content_Types].xml"]!)
      .toString("utf8")
      .replace(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml",
        "application/vnd.ms-excel.sheet.macroEnabled.main+xml"
      )
      .replace(
        "</Types>",
        '<Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>'
      )
  );
  parts["xl/_rels/workbook.xml.rels"] = Buffer.from(
    Buffer.from(parts["xl/_rels/workbook.xml.rels"]!)
      .toString("utf8")
      .replace(
        "</Relationships>",
        '<Relationship Id="macro" Type="http://schemas.microsoft.com/office/2006/relationships/vbaProject" Target="vbaProject.bin"/></Relationships>'
      )
  );
  parts["xl/vbaProject.bin"] = Buffer.from("inert macro payload");
  const sourceBytes = Buffer.from(zipSync(parts));
  conversion = spyOn(officeConverter, "convertOfficeToXlsx");
  await withWorkbook(
    "xlsm",
    sourceBytes,
    async ({ directory, execute, source }) => {
      const inspection = await execute({ action: "inspect" });
      expect(inspection.sheetCount).toBe(2);
      expect(inspection.revision).toBe(spreadsheetRevision(sourceBytes));
      expect(inspection.conversion).toMatchObject({ sourceFormat: ".xlsm" });
      const read = await execute({ action: "read_range", range: "A2:C3" });
      expect(read.rows).toMatchObject([
        ["00123", 12.5, true],
        [null, { formula: "=B2*2" }, null],
      ]);
      const exported = await execute({
        action: "export_xlsx",
        targetXlsxPath: "editable.xlsx",
      });
      expect(exported.path).toBe("artifacts/editable.xlsx");
      expect(exported.sourcePath).toBe(source);
      const outputBytes = await readFile(
        path.join(directory, String(exported.path))
      );
      expect(unzipSync(outputBytes)["xl/vbaProject.bin"]).toBeUndefined();
      expect(
        Buffer.from(
          unzipSync(outputBytes)["xl/_rels/workbook.xml.rels"]!
        ).toString("utf8")
      ).not.toContain("vbaProject");
      const opened = new ExcelJS.Workbook();
      await opened.xlsx.load(Uint8Array.from(outputBytes).buffer);
      expect(opened.getWorksheet("Orders")?.getCell("A2").value).toBe("00123");
      expect(opened.getWorksheet("Orders")?.getCell("B3").formula).toBe("B2*2");
      const updated = await execute({
        action: "write_range",
        path: exported.path,
        range: "B2",
        values: [[14]],
      });
      const changed = await execute({
        action: "read_range",
        path: updated.path,
        range: "A2:C2",
      });
      expect(changed.rows).toEqual([["00123", 14, true]]);
      expect(await readFile(path.join(directory, source))).toEqual(sourceBytes);
      expect(conversion).not.toHaveBeenCalled();
    }
  );
});

for (const extension of ["xls", "xlsb"] as const) {
  test(`${extension} uses bounded Office conversion and exports typed cells to an editable copy`, async () => {
    const sourceBytes =
      extension === "xls"
        ? Buffer.concat([
            Buffer.from("d0cf11e0a1b11ae1", "hex"),
            Buffer.from("controlled binary workbook"),
          ])
        : Buffer.from(
            zipSync({
              "xl/workbook.bin": Buffer.from("controlled workbook records"),
            })
          );
    const convertedBytes = await workbookBytes();
    conversion = spyOn(
      officeConverter,
      "convertOfficeToXlsx"
    ).mockImplementation(async (input) => {
      expect(input.buffer).toEqual(sourceBytes);
      expect(input.filename).toBe(`source.${extension}`);
      expect(input.maxOutputBytes).toBe(25 * 1024 * 1024);
      return {
        bytes: convertedBytes,
        converterVersion: "controlled converter",
      };
    });
    await withWorkbook(
      extension,
      sourceBytes,
      async ({ directory, execute, source }) => {
        const read = await execute({ action: "read_range", range: "A2:C2" });
        expect(read.rows).toEqual([["00123", 12.5, true]]);
        expect(read.revision).toBe(spreadsheetRevision(sourceBytes));
        const exported = await execute({
          action: "export_xlsx",
          targetXlsxPath: "editable.xlsx",
        });
        const opened = new ExcelJS.Workbook();
        await opened.xlsx.readFile(path.join(directory, String(exported.path)));
        expect(opened.worksheets).toHaveLength(2);
        expect(opened.getWorksheet("Orders")?.getCell("A2").value).toBe(
          "00123"
        );
        expect(opened.getWorksheet("Orders")?.getCell("B2").value).toBe(12.5);
        expect(await readFile(path.join(directory, source))).toEqual(
          sourceBytes
        );
        expect(conversion).toHaveBeenCalledTimes(2);
      }
    );
  });
}

for (const extension of ["xls", "xlsm", "xlsb"]) {
  test(`${extension} rejects direct edits and malformed sources without publishing artifacts`, async () => {
    await withWorkbook(
      extension,
      Buffer.from("not a workbook"),
      async ({ directory, execute }) => {
        for (const action of [
          "create",
          "write_range",
          "format_range",
          "recalculate",
        ]) {
          await expect(execute({ action, values: [[1]] })).rejects.toThrow();
        }
        await expect(
          execute({ action: "export_xlsx", targetXlsxPath: "bad.xlsx" })
        ).rejects.toThrow();
        expect(await readdir(directory)).toEqual([`source.${extension}`]);
      }
    );
  });
}

test("unavailable Office conversion fails legacy input without publishing a guessed workbook", async () => {
  conversion = spyOn(officeConverter, "convertOfficeToXlsx").mockRejectedValue(
    new Error("LibreOffice unavailable")
  );
  const sourceBytes = Buffer.concat([
    Buffer.from("d0cf11e0a1b11ae1", "hex"),
    Buffer.alloc(20),
  ]);
  await withWorkbook(
    "xls",
    sourceBytes,
    async ({ directory, execute, source }) => {
      if (!(await officeConverter.resolveConverterBinary())) {
        await expect(
          execute({ action: "export_xlsx", targetXlsxPath: "converted.xlsx" })
        ).rejects.toThrow();
        expect(await readdir(directory)).toEqual([source]);
        return;
      }
      await expect(
        execute({ action: "export_xlsx", targetXlsxPath: "missing.xlsx" })
      ).rejects.toThrow();
      expect(await readdir(directory)).toEqual([source]);
      expect(await readFile(path.join(directory, source))).toEqual(sourceBytes);
    }
  );
});

test("real binary XLS converts through the bundled LibreOffice and reopens with typed cells", async () => {
  // Synthetic ExcelJS cells exported with LibreOffice Calc's MS Excel 97 filter.
  const sourceBytes = await readFile(
    new URL(
      "../testing/fixtures/spreadsheet-legacy-libreoffice.xls",
      import.meta.url
    )
  );
  await withWorkbook(
    "xls",
    sourceBytes,
    async ({ directory, execute, source }) => {
      const output = await execute({
        action: "export_xlsx",
        targetXlsxPath: "converted.xlsx",
      });
      const read = await execute({
        action: "read_range",
        path: output.path,
        range: "A1:B2",
      });
      expect(read.rows).toEqual([
        ["Code", "Amount"],
        ["00123", 12.5],
      ]);
      expect(await readFile(path.join(directory, source))).toEqual(sourceBytes);
    }
  );
}, 30_000);

test("real XLSB imports and exports through LibreOffice without losing typed cells or changing the source", async () => {
  const sourceBytes = await readFile(
    new URL("../testing/fixtures/apache-poi/sample.xlsb", import.meta.url)
  );
  await withWorkbook(
    "xlsb",
    sourceBytes,
    async ({ directory, execute, source }) => {
      if (!(await officeConverter.resolveConverterBinary())) {
        await expect(
          execute({ action: "export_xlsx", targetXlsxPath: "converted.xlsx" })
        ).rejects.toThrow();
        expect(await readdir(directory)).toEqual([source]);
        return;
      }
      const read = await execute({ action: "read_range", range: "A1:B3" });
      expect(read.rows).toEqual([
        ["Lorem", 111],
        ["ipsum", 222],
        ["dolor", 333],
      ]);
      const output = await execute({
        action: "export_xlsx",
        targetXlsxPath: "converted.xlsx",
      });
      const reopened = await execute({
        action: "read_range",
        path: output.path,
        range: "A1:B3",
      });
      expect(reopened.rows).toEqual(read.rows);
      expect(await readFile(path.join(directory, source))).toEqual(sourceBytes);
    }
  );
}, 30_000);

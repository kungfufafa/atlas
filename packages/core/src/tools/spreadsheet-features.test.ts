import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { unzipSync, zipSync } from "fflate";
import { elements, parseXml, serializeXml } from "../office-document/xml";
import { spreadsheetTool } from "./spreadsheet";
import { unsupportedSpreadsheetFeatures } from "./spreadsheet-features";
import { recalculateSpreadsheet } from "./spreadsheet-recalculation";

test("a real chart workbook exposes cell edit support while guarding unsupported layout changes", async () => {
  const original = Buffer.from(
    await Bun.file(
      new URL("../testing/fixtures/spreadsheet-chart.xlsx", import.meta.url)
    ).arrayBuffer()
  );
  const directory = await mkdtemp(path.join(tmpdir(), "atlas-chart-guard-"));
  try {
    await writeFile(path.join(directory, "chart.xlsx"), original);
    const context = { workspaceRoot: directory };
    const inspection = await spreadsheetTool.run(
      { action: "inspect", path: "chart.xlsx" },
      context
    );
    expect(inspection).toMatchObject({
      editable: true,
      sheetCount: 1,
      sheets: [{ name: "Tasks" }],
      supportedActions: expect.arrayContaining(["write_range", "read_range"]),
    });
    for (const action of ["format_range", "recalculate", "export_xlsx"]) {
      await expect(
        spreadsheetTool.run(
          {
            action,
            format: { bold: true },
            path: "chart.xlsx",
            range: "A2",
            targetXlsxPath: "output.xlsx",
            values: [[9]],
          },
          context
        )
      ).rejects.toThrow();
    }
    expect(await readFile(path.join(directory, "chart.xlsx"))).toEqual(
      original
    );
    expect(await readdir(directory)).toEqual(["chart.xlsx"]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("common conditional formatting survives an ordinary range edit", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "atlas-cf-roundtrip-"));
  try {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Tasks");
    sheet.addRows([
      [4, 7],
      [5, 8],
    ]);
    sheet.addConditionalFormatting({
      ref: "B1:B2",
      rules: [
        {
          cfvo: [{ type: "min" }, { type: "max" }],
          color: [{ argb: "FFF8696B" }, { argb: "FF63BE7B" }],
          priority: 1,
          type: "colorScale",
        },
      ],
    });
    await workbook.xlsx.writeFile(path.join(directory, "conditional.xlsx"));
    const result = (await spreadsheetTool.run(
      {
        action: "write_range",
        path: "conditional.xlsx",
        range: "A1",
        values: [[9]],
      },
      { workspaceRoot: directory }
    )) as { path: string };
    const edited = new ExcelJS.Workbook();
    await edited.xlsx.readFile(path.join(directory, result.path));
    expect(edited.getWorksheet("Tasks")!.getCell("A1").value).toBe(9);
    expect(edited.getWorksheet("Tasks")!.conditionalFormattings).toMatchObject([
      {
        ref: "B1:B2",
        rules: [
          { cfvo: [{ type: "min" }, { type: "max" }], type: "colorScale" },
        ],
      },
    ]);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("named external-data formulas are refused before starting a recalculation process", async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Tasks").addRow([1]);
  const parts = unzipSync(new Uint8Array(await workbook.xlsx.writeBuffer()));
  const xml = parseXml(parts["xl/workbook.xml"]!, "workbook");
  const namespace = xml.documentElement.namespaceURI;
  const names =
    elements(xml.documentElement, "definedNames")[0] ??
    xml.createElementNS(namespace, "definedNames");
  if (!names.parentNode) {
    xml.documentElement.appendChild(names);
  }
  const name = xml.createElementNS(namespace, "definedName");
  name.setAttribute("name", "RemoteValue");
  name.textContent = 'WEBSERVICE("https://example.invalid/data")';
  names.appendChild(name);
  parts["xl/workbook.xml"] = serializeXml(xml);
  let resolverCalls = 0;
  await expect(
    recalculateSpreadsheet(Buffer.from(zipSync(parts)), undefined, async () => {
      resolverCalls++;
      return null;
    })
  ).rejects.toThrow();
  expect(resolverCalls).toBe(0);
});

test("empty recalculation metadata is harmless while real custom properties remain guarded", () => {
  const empty =
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"></Properties>';
  expect(
    unsupportedSpreadsheetFeatures({
      "docProps/custom.xml": new TextEncoder().encode(empty),
    })
  ).toEqual([]);
  const populated = empty.replace(
    "</Properties>",
    '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="ReviewStatus"><vt:lpwstr>Approved</vt:lpwstr></property></Properties>'
  );
  expect(
    unsupportedSpreadsheetFeatures({
      "docProps/custom.xml": new TextEncoder().encode(populated),
    })
  ).toContain("custom document properties");
});

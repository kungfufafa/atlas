import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { readOfficeZipParts } from "../office-document/archive";
import {
  attribute,
  elements,
  parseXml,
  serializeXml,
} from "../office-document/xml";
import { spreadsheetTool } from "./spreadsheet";

const fixture = new URL(
  "../testing/fixtures/spreadsheet-chart-source-openpyxl.xlsx",
  import.meta.url
);

test("editing an independent chart source preserves chart series, drawings, relationships, styles and source bytes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "atlas-chart-edit-"));
  try {
    const original = await readFile(fixture);
    await writeFile(path.join(directory, "input.xlsx"), original);
    const result = (await spreadsheetTool.run(
      {
        action: "write_range",
        path: "input.xlsx",
        range: "B2",
        sheetName: "Chart data",
        values: [[12]],
      },
      { workspaceRoot: directory }
    )) as { path: string; chartDataStatus: string };
    expect(result.chartDataStatus).toBe("refresh_on_open");
    const before = readOfficeZipParts(original);
    const after = readOfficeZipParts(
      await readFile(path.join(directory, result.path))
    );
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
    for (const [name, bytes] of Object.entries(before)) {
      if (!["xl/workbook.xml", "xl/worksheets/sheet1.xml"].includes(name)) {
        expect(after[name]).toEqual(bytes);
      }
    }
    const read = await spreadsheetTool.run(
      {
        action: "read_range",
        path: result.path,
        range: "B2",
        sheetName: "Chart data",
      },
      { workspaceRoot: directory }
    );
    expect(read).toMatchObject({ rows: [[12]] });
    expect(await readFile(path.join(directory, "input.xlsx"))).toEqual(
      original
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("chart edits invalidate stale cached chart and formula values while retaining series references", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "atlas-chart-cache-"));
  try {
    const parts = readOfficeZipParts(await readFile(fixture));
    const chartName = "xl/charts/chart1.xml";
    const chart = parseXml(parts[chartName]!, chartName);
    const reference = elements(chart.documentElement, "numRef")[0]!;
    const cache = chart.createElementNS(reference.namespaceURI, "numCache");
    const point = chart.createElementNS(reference.namespaceURI, "pt");
    point.setAttribute("idx", "0");
    const value = chart.createElementNS(reference.namespaceURI, "v");
    value.textContent = "999";
    point.appendChild(value);
    cache.appendChild(point);
    reference.appendChild(cache);
    parts[chartName] = serializeXml(chart);
    const sheet = parseXml(parts["xl/worksheets/sheet1.xml"]!, "sheet");
    const formulaCell = sheet.createElementNS(
      sheet.documentElement.namespaceURI,
      "c"
    );
    formulaCell.setAttribute("r", "C2");
    const formula = sheet.createElementNS(
      sheet.documentElement.namespaceURI,
      "f"
    );
    formula.textContent = "B2*2";
    const cachedValue = sheet.createElementNS(
      sheet.documentElement.namespaceURI,
      "v"
    );
    cachedValue.textContent = "999";
    formulaCell.appendChild(formula);
    formulaCell.appendChild(cachedValue);
    elements(sheet.documentElement, "row")
      .find((row) => attribute(row, "r") === "2")!
      .appendChild(formulaCell);
    parts["xl/worksheets/sheet1.xml"] = serializeXml(sheet);
    await writeFile(path.join(directory, "cached.xlsx"), zipSync(parts));
    const result = (await spreadsheetTool.run(
      {
        action: "write_range",
        path: "cached.xlsx",
        range: "B2",
        sheetName: "Chart data",
        values: [[12]],
      },
      { workspaceRoot: directory }
    )) as { path: string };
    const output = readOfficeZipParts(
      await readFile(path.join(directory, result.path))
    );
    const updated = parseXml(output[chartName]!, chartName);
    expect(elements(updated.documentElement, "numCache")).toHaveLength(0);
    expect(
      elements(updated.documentElement, "f").map(
        (element) => element.textContent
      )
    ).toEqual(
      elements(chart.documentElement, "f").map((element) => element.textContent)
    );
    const outputSheet = parseXml(output["xl/worksheets/sheet1.xml"]!, "sheet");
    const outputFormula = elements(outputSheet.documentElement, "c").find(
      (cell) => attribute(cell, "r") === "C2"
    )!;
    expect(elements(outputFormula, "f")[0]?.textContent).toBe("B2*2");
    expect(elements(outputFormula, "v")).toHaveLength(0);
    const workbook = parseXml(output["xl/workbook.xml"]!, "workbook");
    expect(
      attribute(
        elements(workbook.documentElement, "calcPr")[0]!,
        "fullCalcOnLoad"
      )
    ).toBe("1");
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

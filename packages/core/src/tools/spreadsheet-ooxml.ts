import path from "node:path";
import type { Element } from "@xmldom/xmldom";
import type ExcelJS from "exceljs";
import { zipSync } from "fflate";
import {
  attribute,
  elements,
  parseXml,
  serializeXml,
} from "../office-document/xml";
import type { SpreadsheetPrimitive } from "./spreadsheet-cells";

const SHEET_PART = /^xl\/worksheets\/[^/]+\.xml$/i;
const CHART_PART = /^xl\/charts\/[^/]+\.xml$/i;
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
const ESCAPED_CHARACTER = /_x[0-9a-f]{4}_/gi;
const INVALID_XML_CHARACTER =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g;

function cellAddress(row: number, column: number): string {
  let letters = "";
  for (let value = column; value; value = Math.floor((value - 1) / 26)) {
    letters = String.fromCharCode(65 + ((value - 1) % 26)) + letters;
  }
  return `${letters}${row}`;
}

function columnIndex(address: string): number {
  let value = 0;
  for (const character of address.replace(/\d/g, "")) {
    value = value * 26 + character.charCodeAt(0) - 64;
  }
  return value;
}

function removeChildren(element: Element, names: string[]) {
  for (const child of Array.from(element.childNodes)) {
    if (
      child.nodeType === 1 &&
      names.includes((child as Element).localName ?? "")
    ) {
      element.removeChild(child);
    }
  }
}

/** ExcelJS is used only as a cell reader for this path. Hide drawing references
 * in its temporary input, never in the original package or published output.
 */
export function spreadsheetPartsForCellRead(parts: Record<string, Uint8Array>) {
  const readable = { ...parts };
  for (const [name, bytes] of Object.entries(parts)) {
    if (name.startsWith("xl/drawings/") && !name.endsWith(".vml")) {
      delete readable[name];
      continue;
    }
    if (name.endsWith(".rels")) {
      const document = parseXml(bytes, name);
      for (const relationship of elements(
        document.documentElement,
        "Relationship"
      )) {
        if (attribute(relationship, "Type").endsWith("/drawing")) {
          relationship.parentNode!.removeChild(relationship);
        }
      }
      readable[name] = serializeXml(document);
      continue;
    }
    if (!SHEET_PART.test(name)) {
      continue;
    }
    const document = parseXml(bytes, name);
    for (const drawing of elements(document.documentElement, "drawing")) {
      drawing.parentNode!.removeChild(drawing);
    }
    readable[name] = serializeXml(document);
  }
  return readable;
}

function worksheetPart(
  parts: Record<string, Uint8Array>,
  name: string
): string {
  const workbook = parseXml(parts["xl/workbook.xml"]!, "xl/workbook.xml");
  const sheet = elements(workbook.documentElement, "sheet").find(
    (item) => attribute(item, "name") === name
  );
  const relationships = parseXml(
    parts["xl/_rels/workbook.xml.rels"]!,
    "workbook relationships"
  );
  const relationship = elements(
    relationships.documentElement,
    "Relationship"
  ).find((item) => attribute(item, "Id") === (sheet && attribute(sheet, "id")));
  if (!relationship || attribute(relationship, "TargetMode") === "External") {
    throw new Error("Worksheet relationship is missing or external.");
  }
  const target = attribute(relationship, "Target");
  const result = path.posix.normalize(
    target.startsWith("/") ? target.slice(1) : path.posix.join("xl", target)
  );
  if (!parts[result]) {
    throw new Error("Worksheet part is missing.");
  }
  return result;
}

/** ExcelJS discards <v/> for formula strings. Restore only an explicitly
 * serialized empty string, never a missing cache or a blank numeric result. */
export function restoreEmptyFormulaResults(
  workbook: ExcelJS.Workbook,
  parts: Record<string, Uint8Array>
): void {
  for (const sheet of workbook.worksheets) {
    const part = worksheetPart(parts, sheet.name);
    const document = parseXml(parts[part]!, part);
    for (const element of elements(document.documentElement, "c")) {
      if (attribute(element, "t") !== "str" || !elements(element, "f").length) {
        continue;
      }
      const cached = elements(element, "v");
      if (cached.length !== 1 || cached[0]!.textContent !== "") {
        continue;
      }
      const address = attribute(element, "r");
      if (!/^[A-Z]{1,3}[1-9][0-9]*$/.test(address)) {
        continue;
      }
      const cell = sheet.getCell(address);
      const value = cell.value;
      if (
        value &&
        typeof value === "object" &&
        ("formula" in value || "sharedFormula" in value)
      ) {
        cell.value = { ...value, result: "" };
      }
    }
  }
}

function setValue(
  cell: Element,
  value: SpreadsheetPrimitive,
  literal: boolean
) {
  const document = cell.ownerDocument!;
  const prefix = cell.prefix ? `${cell.prefix}:` : "";
  const child = (name: string, text?: string) => {
    const element = document.createElementNS(
      cell.namespaceURI,
      `${prefix}${name}`
    );
    if (text !== undefined) {
      element.textContent = text;
    }
    return element;
  };
  removeChildren(cell, ["f", "v", "is"]);
  cell.removeAttribute("t");
  if (value === null) {
    return;
  }
  if (typeof value === "string") {
    if (!literal && value.startsWith("=")) {
      cell.appendChild(child("f", value.slice(1)));
      return;
    }
    cell.setAttribute("t", "inlineStr");
    const inline = child("is");
    const text = child(
      "t",
      value
        .replace(ESCAPED_CHARACTER, (match) => `_x005F_${match.slice(1)}`)
        .replace(
          INVALID_XML_CHARACTER,
          (match) => `_x${match.charCodeAt(0).toString(16).padStart(4, "0")}_`
        )
    );
    text.setAttributeNS(XML_NAMESPACE, "xml:space", "preserve");
    inline.appendChild(text);
    cell.appendChild(inline);
    return;
  }
  cell.setAttribute("t", typeof value === "boolean" ? "b" : "n");
  cell.appendChild(
    child("v", typeof value === "boolean" ? (value ? "1" : "0") : String(value))
  );
}

function writableCell(
  root: Element,
  rowIndex: number,
  column: number
): Element {
  const document = root.ownerDocument!;
  const prefix = root.prefix ? `${root.prefix}:` : "";
  const sheetData = elements(root, "sheetData")[0];
  if (!sheetData) {
    throw new Error("Worksheet has no sheetData.");
  }
  const rows = elements(sheetData, "row");
  let row = rows.find((item) => Number(attribute(item, "r")) === rowIndex);
  if (!row) {
    row = document.createElementNS(root.namespaceURI, `${prefix}row`);
    row.setAttribute("r", String(rowIndex));
    sheetData.insertBefore(
      row,
      rows.find((item) => Number(attribute(item, "r")) > rowIndex) ?? null
    );
  }
  row.removeAttribute("spans");
  const address = cellAddress(rowIndex, column);
  const cells = elements(row, "c");
  let cell = cells.find((item) => attribute(item, "r") === address);
  if (!cell) {
    cell = document.createElementNS(root.namespaceURI, `${prefix}c`);
    cell.setAttribute("r", address);
    row.insertBefore(
      cell,
      cells.find((item) => columnIndex(attribute(item, "r")) > column) ?? null
    );
  }
  return cell;
}

/** Patch cell values in the source package. Drawings, charts, relationships,
 * styles, named ranges and all unrelated package parts are retained. Formula
 * results and linked chart caches are invalidated to prevent stale values.
 */
export function writeSpreadsheetCellsPreservingParts(input: {
  parts: Record<string, Uint8Array>;
  sheetName: string;
  startRow: number;
  startCol: number;
  values: SpreadsheetPrimitive[][];
  literalStrings: boolean;
}): Uint8Array {
  const result = { ...input.parts };
  const part = worksheetPart(result, input.sheetName);
  const document = parseXml(result[part]!, part);
  // Multi-cell formulas require an explicit range-aware formula contract. Do
  // not detach one member and leave an inconsistent shared/array formula group.
  if (
    elements(document.documentElement, "f").some((formula) =>
      ["shared", "array", "dataTable"].includes(attribute(formula, "t"))
    )
  ) {
    throw new Error(
      "Direct chart-workbook edits with shared, array, or data-table formulas are unsupported."
    );
  }
  if (elements(document.documentElement, "sheetProtection").length) {
    throw new Error("Editing a protected worksheet is unsupported.");
  }
  const merges = elements(document.documentElement, "mergeCell").map((merge) =>
    attribute(merge, "ref")
  );
  for (const [r, row] of input.values.entries()) {
    for (const [c, value] of row.entries()) {
      const rowIndex = input.startRow + r;
      const column = input.startCol + c;
      const address = cellAddress(rowIndex, column);
      for (const merge of merges) {
        const [first, last] = merge.split(":");
        if (
          first &&
          last &&
          address !== first &&
          rowIndex >= Number(first.replace(/\D/g, "")) &&
          rowIndex <= Number(last.replace(/\D/g, "")) &&
          column >= columnIndex(first) &&
          column <= columnIndex(last)
        ) {
          throw new Error(
            "Editing a merged-cell continuation is unsupported; edit the merged anchor cell."
          );
        }
      }
      setValue(
        writableCell(
          document.documentElement,
          input.startRow + r,
          input.startCol + c
        ),
        value,
        input.literalStrings
      );
    }
  }
  // Dimension is optional; omitting it lets readers calculate the used range,
  // including newly inserted rows/cells, without touching column/row layout.
  removeChildren(document.documentElement, ["dimension"]);
  result[part] = serializeXml(document);
  for (const [name, bytes] of Object.entries(result)) {
    if (
      !(
        SHEET_PART.test(name) ||
        CHART_PART.test(name) ||
        name === "xl/workbook.xml"
      )
    ) {
      continue;
    }
    const xml = parseXml(bytes, name);
    let changed = false;
    if (SHEET_PART.test(name)) {
      for (const formula of elements(xml.documentElement, "f")) {
        removeChildren(formula.parentNode as Element, ["v"]);
        changed = true;
      }
    } else if (CHART_PART.test(name)) {
      for (const cacheName of ["numCache", "strCache", "multiLvlStrCache"]) {
        for (const cache of elements(xml.documentElement, cacheName)) {
          cache.parentNode!.removeChild(cache);
          changed = true;
        }
      }
    } else {
      let calculation = elements(xml.documentElement, "calcPr")[0];
      if (!calculation) {
        const root = xml.documentElement;
        calculation = xml.createElementNS(
          root.namespaceURI,
          `${root.prefix ? `${root.prefix}:` : ""}calcPr`
        );
        const successor = Array.from(root.childNodes).find(
          (node) =>
            node.nodeType === 1 &&
            [
              "oleSize",
              "customWorkbookViews",
              "pivotCaches",
              "smartTagPr",
              "smartTagTypes",
              "webPublishing",
              "fileRecoveryPr",
              "webPublishObjects",
              "extLst",
            ].includes((node as Element).localName ?? "")
        );
        root.insertBefore(calculation, successor ?? null);
      }
      calculation.setAttribute("fullCalcOnLoad", "1");
      calculation.setAttribute("forceFullCalc", "1");
      calculation.setAttribute("calcMode", "auto");
      changed = true;
    }
    if (changed) {
      result[name] = serializeXml(xml);
    }
  }
  if (result["xl/calcChain.xml"]) {
    delete result["xl/calcChain.xml"];
    for (const name of ["[Content_Types].xml", "xl/_rels/workbook.xml.rels"]) {
      const xml = parseXml(result[name]!, name);
      for (const child of Array.from(xml.documentElement.childNodes)) {
        if (child.nodeType !== 1) {
          continue;
        }
        const element = child as Element;
        if (
          attribute(element, "PartName") === "/xl/calcChain.xml" ||
          attribute(element, "Type").endsWith("/calcChain")
        ) {
          xml.documentElement.removeChild(element);
        }
      }
      result[name] = serializeXml(xml);
    }
  }
  return zipSync(result);
}

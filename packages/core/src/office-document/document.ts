import type { Element } from "@xmldom/xmldom";
import type { OfficeArchive } from "./archive";
import {
  isInsertedText,
  type OfficeRevisionOptions,
  WordRevisionWriter,
} from "./revisions";
import { WordReadback } from "./word-readback";
import {
  attribute,
  DRAWING_NAMESPACES,
  elements,
  nearestAncestor,
  type ParsedXmlDocument,
  PRESENTATION_NAMESPACES,
  parseXml,
  serializeXml,
  WORD_NAMESPACES,
} from "./xml";

const SLIDE_RELATIONSHIP = /\/slide$/;
const NOTES_RELATIONSHIP = /\/notesSlide$/;
const WORD_COMPANION_RELATIONSHIP = /\/(header|footer|footnotes|endnotes)$/;
const MAX_TEXT_CHARACTERS = 24_000;
const MAX_PARAGRAPH_CHARACTERS = 4000;
const MAX_EDIT_EXPANSION_CHARACTERS = 4 * 1024 * 1024;
const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";

interface OfficeUnit {
  kind: string;
  notesPart?: string;
  part: string;
}

export interface OfficeSelection {
  section?: "content" | "notes";
  unit?: number;
}

export type OfficeEdit = OfficeSelection &
  (
    | {
        expectedMatches: number;
        find: string;
        kind: "replace_text";
        paragraph?: number;
        replace: string;
      }
    | {
        column: number;
        expectedText: string;
        kind: "set_table_cell";
        row: number;
        table: number;
        text: string;
      }
  );

export interface OfficeReadOptions extends OfficeSelection {
  columnLimit?: number;
  columnStart?: number;
  limit: number;
  start: number;
  table?: number;
}

interface TextAtom {
  element?: Element;
  text: string;
}

function relationshipId(element: Element): string {
  for (let index = 0; index < element.attributes.length; index += 1) {
    const item = element.attributes.item(index);
    if (
      item?.localName === "id" &&
      item.namespaceURI?.endsWith("/relationships")
    ) {
      return item.value;
    }
  }
  return "";
}

function textAtoms(
  paragraph: Element,
  namespaces: ReadonlySet<string>
): TextAtom[] {
  const atoms: TextAtom[] = [];
  if (
    nearestAncestor(paragraph, "del", WORD_NAMESPACES) ||
    nearestAncestor(paragraph, "moveFrom", WORD_NAMESPACES)
  ) {
    return atoms;
  }
  const pending: Element[] = [];
  for (let child = paragraph.lastChild; child; child = child.previousSibling) {
    if (child.nodeType === 1) {
      pending.push(child as Element);
    }
  }
  while (pending.length) {
    const element = pending.pop()!;
    if (namespaces.has(element.namespaceURI ?? "")) {
      if (["p", "del", "moveFrom"].includes(element.localName ?? "")) {
        continue;
      }
      if (element.localName === "t") {
        atoms.push({ element, text: element.textContent ?? "" });
        continue;
      }
      if (["br", "cr", "tab"].includes(element.localName ?? "")) {
        atoms.push({ text: element.localName === "tab" ? "\t" : "\n" });
      }
    }
    for (let child = element.lastChild; child; child = child.previousSibling) {
      if (child.nodeType === 1) {
        pending.push(child as Element);
      }
    }
  }
  return atoms;
}

function paragraphText(
  paragraph: Element,
  namespaces: ReadonlySet<string>
): string {
  return textAtoms(paragraph, namespaces)
    .map((atom) => atom.text)
    .join("");
}

function requireEditableParagraph(
  paragraph: Element,
  namespaces: ReadonlySet<string>
): void {
  for (const name of [
    "fld",
    "fldChar",
    "fldSimple",
    "instrText",
    "moveFrom",
    "moveTo",
  ]) {
    if (
      elements(paragraph, name, namespaces).length ||
      nearestAncestor(paragraph, name, namespaces)
    ) {
      throw new Error(
        "Editing text fields or tracked moves is unsupported; choose a plain paragraph."
      );
    }
  }
}

function setText(element: Element, text: string): void {
  element.textContent = text;
  element.setAttributeNS(XML_NAMESPACE, "xml:space", "preserve");
}

function requireSingleLine(text: string): void {
  if (/[\u0000-\u001f]/.test(text)) {
    throw new Error(
      "Office text edits accept a single line without control characters; structural line changes require a layout editor."
    );
  }
}

function replaceInParagraph(
  paragraph: Element,
  namespaces: ReadonlySet<string>,
  find: string,
  replacement: string,
  maximumMatches: number,
  revisions?: WordRevisionWriter
): number {
  const atoms = textAtoms(paragraph, namespaces);
  const text = atoms.map((atom) => atom.text).join("");
  const matches: number[] = [];
  for (
    let offset = text.indexOf(find);
    offset >= 0;
    offset = text.indexOf(find, offset + find.length)
  ) {
    matches.push(offset);
    if (matches.length > maximumMatches) {
      throw new Error(
        "Text matches exceed expectedMatches; no output was saved."
      );
    }
  }
  if (!matches.length) {
    return 0;
  }
  requireEditableParagraph(paragraph, namespaces);
  const ranges: Array<TextAtom & { start: number; end: number }> = [];
  let offset = 0;
  for (const atom of atoms) {
    ranges.push({ ...atom, end: offset + atom.text.length, start: offset });
    offset += atom.text.length;
  }
  for (const start of matches.reverse()) {
    const end = start + find.length;
    if (revisions) {
      // Recompute spans after each reverse-order change: a tracked edit splits
      // runs, while the lower offsets still refer to the same visible text.
      let position = 0;
      const spans = textAtoms(paragraph, namespaces)
        .map((atom) => {
          const span = {
            ...atom,
            end: position + atom.text.length,
            start: position,
          };
          position = span.end;
          return span;
        })
        .filter((span) => span.end > start && span.start < end);
      if (spans.some((span) => !span.element)) {
        throw new Error(
          "Tracked replacement cannot cross a tab or line break."
        );
      }
      const insertion = nearestAncestor(
        spans[0]!.element!,
        "ins",
        WORD_NAMESPACES
      );
      if (
        spans.some(
          (span) =>
            nearestAncestor(span.element!, "ins", WORD_NAMESPACES) !== insertion
        )
      ) {
        throw new Error(
          "Tracked replacement across different insertion histories is unsupported; edit each revision separately."
        );
      }
      for (const [index, span] of spans.entries()) {
        revisions.replace(
          span.element!,
          Math.max(0, start - span.start),
          Math.min(span.text.length, end - span.start),
          index === 0 ? replacement : ""
        );
      }
      continue;
    }
    const matched = ranges.filter(
      (range) => range.end > start && range.start < end
    );
    if (matched.some((range) => !range.element)) {
      throw new Error(
        "Replacement crosses a tab or line break; select text within a single text span."
      );
    }
    const first = matched[0]!;
    const last = matched.at(-1)!;
    if (first === last) {
      const current = first.element!.textContent ?? "";
      setText(
        first.element!,
        current.slice(0, start - first.start) +
          replacement +
          current.slice(end - first.start)
      );
      continue;
    }
    setText(
      first.element!,
      (first.element!.textContent ?? "").slice(0, start - first.start) +
        replacement
    );
    for (const middle of matched.slice(1, -1)) {
      setText(middle.element!, "");
    }
    setText(
      last.element!,
      (last.element!.textContent ?? "").slice(end - last.start)
    );
  }
  return matches.length;
}

function rowsForTable(
  table: Element,
  namespaces: ReadonlySet<string>
): Element[] {
  return elements(table, "tr", namespaces).filter(
    (row) => nearestAncestor(row, "tbl", namespaces) === table
  );
}

function cellsForRow(row: Element, namespaces: ReadonlySet<string>): Element[] {
  return elements(row, "tc", namespaces).filter(
    (cell) => nearestAncestor(cell, "tr", namespaces) === row
  );
}

function isMergedCell(cell: Element, namespaces: ReadonlySet<string>): boolean {
  return (
    ["vMerge", "hMerge"].some(
      (name) => elements(cell, name, namespaces).length > 0
    ) ||
    elements(cell, "gridSpan", namespaces).some(
      (span) => attribute(span, "val") !== "1"
    ) ||
    ["gridSpan", "rowSpan"].some((name) => {
      const value = attribute(cell, name);
      return value !== "" && value !== "1";
    }) ||
    ["vMerge", "hMerge"].some((name) => {
      const value = attribute(cell, name);
      return value !== "" && value !== "0" && value !== "false";
    })
  );
}

function isMergeContinuation(cell: Element): boolean {
  return ["vMerge", "hMerge"].some((name) =>
    ["1", "true"].includes(attribute(cell, name))
  );
}

function pageCoverage(start: number, limit: number, total: number) {
  const returned = Math.max(0, Math.min(limit, total - start + 1));
  return {
    complete: start === 1 && returned === total,
    nextStart: start + returned <= total ? start + returned : null,
    returned,
    start,
    total,
  };
}

function textBudget() {
  let remaining = MAX_TEXT_CHARACTERS;
  return (text: string) => {
    const count = Math.min(text.length, remaining, MAX_PARAGRAPH_CHARACTERS);
    remaining -= count;
    return {
      characters: text.length,
      text: text.slice(0, count),
      truncated: count < text.length,
    };
  };
}

export class OfficeDocument {
  private readonly documents = new Map<string, ParsedXmlDocument>();
  private readonly units: OfficeUnit[];
  private readonly namespaces: ReadonlySet<string>;

  constructor(readonly archive: OfficeArchive) {
    this.namespaces =
      archive.format === "docx" ? WORD_NAMESPACES : DRAWING_NAMESPACES;
    const main = this.document(archive.mainPart);
    if (archive.format === "docx") {
      if (
        !(
          WORD_NAMESPACES.has(main.documentElement.namespaceURI ?? "") &&
          elements(main.documentElement, "body", WORD_NAMESPACES).length
        )
      ) {
        throw new Error("Word main document/body namespace is invalid.");
      }
      this.units = [{ kind: "document", part: archive.mainPart }];
      const seen = new Set([archive.mainPart]);
      for (const relationship of archive.relationships.get(archive.mainPart) ??
        []) {
        const kind = WORD_COMPANION_RELATIONSHIP.exec(relationship.type)?.[1];
        if (kind && !relationship.external && !seen.has(relationship.target)) {
          this.units.push({ kind, part: relationship.target });
          seen.add(relationship.target);
        }
      }
    } else {
      if (
        !PRESENTATION_NAMESPACES.has(main.documentElement.namespaceURI ?? "")
      ) {
        throw new Error("PowerPoint presentation namespace is invalid.");
      }
      const relationships = archive.relationships.get(archive.mainPart) ?? [];
      this.units = elements(
        main.documentElement,
        "sldId",
        PRESENTATION_NAMESPACES
      ).map((slide) => {
        const relationship = relationships.find(
          (item) =>
            item.id === relationshipId(slide) &&
            SLIDE_RELATIONSHIP.test(item.type) &&
            !item.external
        );
        if (!relationship) {
          throw new Error(
            "Presentation slide relationship is missing or invalid."
          );
        }
        const notes = archive.relationships
          .get(relationship.target)
          ?.find(
            (item) => NOTES_RELATIONSHIP.test(item.type) && !item.external
          );
        return {
          kind: "slide",
          notesPart: notes?.target,
          part: relationship.target,
        };
      });
    }
    if (!this.units.length) {
      throw new Error("The Office document has no readable content units.");
    }
  }

  inspect(start: number, limit: number) {
    return {
      coverage: pageCoverage(start, limit, this.units.length),
      format: this.archive.format,
      imageParts: Object.keys(this.archive.parts).filter(
        (name) => name.includes("/media/") && !name.endsWith("/")
      ).length,
      packageParts: Object.keys(this.archive.parts).length,
      units: this.units
        .slice(start - 1, start - 1 + limit)
        .map((unit, offset) => {
          const root = this.document(unit.part).documentElement;
          return {
            index: start + offset,
            kind: unit.kind,
            notesAvailable: Boolean(unit.notesPart),
            paragraphs: elements(root, "p", this.namespaces).length,
            tables: elements(root, "tbl", this.namespaces).length,
          };
        }),
      warnings: this.warnings(),
    };
  }

  read(options: OfficeReadOptions) {
    const { root, unit } = this.select(options);
    const tables = elements(root, "tbl", this.namespaces);
    const wordReadback =
      this.archive.format === "docx"
        ? new WordReadback(
            root,
            unit.part,
            unit.kind,
            options.unit ?? 1,
            this.units.length
          )
        : null;
    const takeText = textBudget();
    const base = {
      format: this.archive.format,
      section: options.section ?? "content",
      unit: options.unit ?? 1,
      unitKind: unit.kind,
      warnings: this.warnings(),
    };
    if (options.table !== undefined) {
      const table = tables[options.table - 1];
      if (!table) {
        throw new Error("Selected table does not exist.");
      }
      const rows = rowsForTable(table, this.namespaces);
      const columnStart = options.columnStart ?? 1;
      const columnLimit = options.columnLimit ?? 20;
      const coverage = pageCoverage(options.start, options.limit, rows.length);
      const returnedRows = rows
        .slice(options.start - 1, options.start - 1 + options.limit)
        .map((row, index) => {
          const cells = cellsForRow(row, this.namespaces);
          return {
            cells: cells
              .slice(columnStart - 1, columnStart - 1 + columnLimit)
              .map((cell, cellIndex) => ({
                column: columnStart + cellIndex,
                merged: isMergedCell(cell, this.namespaces),
                ...takeText(this.cellText(cell)),
                ...(wordReadback
                  ? { location: wordReadback.location(cell, true) }
                  : {}),
              })),
            coverage: pageCoverage(columnStart, columnLimit, cells.length),
            index: options.start + index,
          };
        });
      return {
        ...base,
        coverage,
        rows: returnedRows,
        table: options.table,
        ...(wordReadback
          ? {
              readback: wordReadback.coverage({
                paginationComplete:
                  coverage.complete &&
                  returnedRows.every((row) => row.coverage.complete),
                returnedLocationsComplete: returnedRows.every((row) =>
                  row.cells.every(
                    (cell) => cell.location?.tablesCoverage.complete === true
                  )
                ),
                returnedTextComplete: returnedRows.every((row) =>
                  row.cells.every((cell) => !cell.truncated)
                ),
                scope: "selected_table_cells",
              }),
            }
          : {}),
      };
    }
    const paragraphs = elements(root, "p", this.namespaces);
    const coverage = pageCoverage(
      options.start,
      options.limit,
      paragraphs.length
    );
    const returnedParagraphs = paragraphs
      .slice(options.start - 1, options.start - 1 + options.limit)
      .map((paragraph, index) => ({
        index: options.start + index,
        ...takeText(paragraphText(paragraph, this.namespaces)),
        ...(wordReadback ? { location: wordReadback.location(paragraph) } : {}),
      }));
    return {
      ...base,
      coverage,
      paragraphs: returnedParagraphs,
      tableCoverage: pageCoverage(1, 100, tables.length),
      tables: tables.slice(0, 100).map((table, index) => ({
        index: index + 1,
        rows: rowsForTable(table, this.namespaces).length,
      })),
      ...(wordReadback
        ? {
            readback: wordReadback.coverage({
              paginationComplete: coverage.complete,
              returnedLocationsComplete: returnedParagraphs.every(
                (paragraph) =>
                  paragraph.location?.tablesCoverage.complete === true
              ),
              returnedTextComplete: returnedParagraphs.every(
                (paragraph) => !paragraph.truncated
              ),
              scope: "selected_unit_paragraphs",
            }),
          }
        : {}),
    };
  }

  edit(edits: OfficeEdit[], options: OfficeRevisionOptions = {}): string[] {
    this.requireEditableDocument();
    if (options.trackChanges && this.archive.format !== "docx") {
      throw new Error("Tracked changes require a Word document.");
    }
    const revisionWriter =
      this.archive.format === "docx"
        ? new WordRevisionWriter(
            this.units.map((unit) => this.document(unit.part).documentElement),
            options.revisionAuthor
          )
        : undefined;
    const changed = new Set<string>();
    for (const edit of edits) {
      const selected = this.select(edit);
      if (edit.kind === "replace_text") {
        requireSingleLine(edit.replace);
        if (
          !edit.find ||
          edit.replace.length * edit.expectedMatches >
            MAX_EDIT_EXPANSION_CHARACTERS
        ) {
          throw new Error(
            "A nonempty search and bounded replacement size are required."
          );
        }
        let paragraphs = elements(selected.root, "p", this.namespaces);
        if (edit.paragraph !== undefined) {
          const paragraph = paragraphs[edit.paragraph - 1];
          if (!paragraph) {
            throw new Error("Selected paragraph does not exist.");
          }
          paragraphs = [paragraph];
        }
        const matches = paragraphs.reduce(
          (count, paragraph) =>
            count +
            replaceInParagraph(
              paragraph,
              this.namespaces,
              edit.find,
              edit.replace,
              edit.expectedMatches - count,
              revisionWriter &&
                (options.trackChanges ||
                  textAtoms(paragraph, this.namespaces).some(
                    (atom) => atom.element && isInsertedText(atom.element)
                  ))
                ? revisionWriter
                : undefined
            ),
          0
        );
        if (matches !== edit.expectedMatches) {
          throw new Error(
            `Expected ${edit.expectedMatches} text matches but found ${matches}; no output was saved.`
          );
        }
        if (matches > 0) {
          changed.add(selected.part);
        }
      } else {
        this.setTableCell(
          selected.root,
          edit,
          revisionWriter,
          options.trackChanges
        );
        changed.add(selected.part);
      }
    }
    if (!changed.size) {
      throw new Error("No text changed; no output was saved.");
    }
    for (const part of changed) {
      this.archive.parts[part] = serializeXml(this.document(part));
    }
    return [...changed];
  }

  private document(part: string): ParsedXmlDocument {
    let document = this.documents.get(part);
    if (!document) {
      const bytes = this.archive.parts[part];
      if (!bytes) {
        throw new Error(`Office content part is missing: ${part}`);
      }
      document = parseXml(bytes, part);
      this.documents.set(part, document);
    }
    return document;
  }

  private select(selection: OfficeSelection) {
    const unit = this.units[(selection.unit ?? 1) - 1];
    if (!unit) {
      throw new Error("Selected document unit or slide does not exist.");
    }
    const part = selection.section === "notes" ? unit.notesPart : unit.part;
    if (!part) {
      throw new Error("Selected slide has no speaker notes.");
    }
    return { part, root: this.document(part).documentElement, unit };
  }

  private cellText(cell: Element): string {
    return elements(cell, "p", this.namespaces)
      .filter(
        (paragraph) =>
          nearestAncestor(paragraph, "tc", this.namespaces) === cell
      )
      .map((paragraph) => paragraphText(paragraph, this.namespaces))
      .join("\n");
  }

  private setTableCell(
    root: Element,
    edit: Extract<OfficeEdit, { kind: "set_table_cell" }>,
    revisions?: WordRevisionWriter,
    trackChanges = false
  ): void {
    requireSingleLine(edit.text);
    const table = elements(root, "tbl", this.namespaces)[edit.table - 1];
    const row = table
      ? rowsForTable(table, this.namespaces)[edit.row - 1]
      : undefined;
    const cell = row
      ? cellsForRow(row, this.namespaces)[edit.column - 1]
      : undefined;
    if (!cell || this.cellText(cell) !== edit.expectedText) {
      throw new Error(
        "Selected table cell does not exist or its text changed; no output was saved."
      );
    }
    const paragraphs = elements(cell, "p", this.namespaces).filter(
      (paragraph) => nearestAncestor(paragraph, "tc", this.namespaces) === cell
    );
    if (
      paragraphs.length !== 1 ||
      elements(cell, "tbl", this.namespaces).length ||
      (isMergedCell(cell, this.namespaces) &&
        (this.archive.format !== "pptx" || isMergeContinuation(cell)))
    ) {
      throw new Error(
        "Cell updates support one plain paragraph in an unmerged cell; use targeted paragraph replacements for complex cells."
      );
    }
    const paragraph = paragraphs[0]!;
    requireEditableParagraph(paragraph, this.namespaces);
    const atoms = textAtoms(paragraph, this.namespaces);
    if (atoms.some((atom) => !atom.element)) {
      throw new Error(
        "Cell contains structural breaks; use targeted paragraph replacements."
      );
    }
    if (
      atoms.some((atom) => atom.element && isInsertedText(atom.element)) ||
      trackChanges
    ) {
      if (!edit.expectedText) {
        throw new Error(
          "Tracked empty-cell edits require a targeted paragraph replacement."
        );
      }
      replaceInParagraph(
        paragraph,
        this.namespaces,
        edit.expectedText,
        edit.text,
        1,
        revisions ?? new WordRevisionWriter([root])
      );
      return;
    }
    if (atoms.length) {
      setText(atoms[0]!.element!, edit.text);
      for (const atom of atoms.slice(1)) {
        setText(atom.element!, "");
      }
      return;
    }
    const namespace = paragraph.namespaceURI!;
    const prefix = paragraph.prefix ? `${paragraph.prefix}:` : "";
    const owner = paragraph.ownerDocument;
    if (!owner) {
      throw new Error("Selected cell is detached from the document.");
    }
    const run = owner.createElementNS(namespace, `${prefix}r`);
    const text = owner.createElementNS(namespace, `${prefix}t`);
    setText(text, edit.text);
    run.appendChild(text);
    const end = elements(paragraph, "endParaRPr", this.namespaces)[0];
    paragraph.insertBefore(run, end ?? null);
  }

  private requireEditableDocument(): void {
    const settingsParts = new Set(
      (this.archive.relationships.get(this.archive.mainPart) ?? [])
        .filter(
          (relationship) =>
            !relationship.external && relationship.type.endsWith("/settings")
        )
        .map((relationship) => relationship.target)
    );
    for (const [part, bytes] of Object.entries(this.archive.parts)) {
      if (part.endsWith("/settings.xml") || settingsParts.has(part)) {
        const settings = parseXml(bytes, part);
        const protection = elements(
          settings.documentElement,
          "documentProtection",
          WORD_NAMESPACES
        );
        if (
          protection.some((element) =>
            ["true", "1", "on"].includes(attribute(element, "enforcement"))
          )
        ) {
          throw new Error("Editing a protected Word document is unsupported.");
        }
      }
    }
  }

  private warnings(): string[] {
    return [
      "Text coverage includes OOXML paragraphs and table cells. It does not include OCR, chart data, SmartArt, equations, or layout rendering.",
      "Replacements preserve existing package parts and use the first matched text run's formatting. Text inside insertions creates new Atlas revisions, retaining earlier author history. trackChanges records plain text edits too. Structural layout changes, tracked moves, fields, and multiline cell rewrites are unsupported.",
      "Table columns index the physical OOXML cells. PowerPoint merged-cell anchors support text-only updates; continuation cells and Word merged cells require targeted paragraph replacements.",
    ];
  }
}

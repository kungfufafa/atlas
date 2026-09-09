import type { Element, Node } from "@xmldom/xmldom";
import { WORD_NAMESPACES } from "./xml";

const MAX_TABLE_ANCESTRY = 32;
const MAX_LOCATION_SEGMENTS = 2000;

interface CellLocation {
  column: number;
  row: number;
  table: number;
}

interface RowLocation {
  cells: number;
  index: number;
  table: number;
}

interface TableLocation {
  index: number;
  rows: number;
}

interface WalkEntry {
  node: Node;
  row: RowLocation | null;
  table: TableLocation | null;
}

interface ReadbackSelection {
  paginationComplete: boolean;
  returnedLocationsComplete: boolean;
  returnedTextComplete: boolean;
  scope: "selected_table_cells" | "selected_unit_paragraphs";
}

const DIRECT_CONTAINERS = new Map([
  ["body", "body"],
  ["tc", "table_cell"],
  ["hdr", "header"],
  ["ftr", "footer"],
  ["footnote", "footnote"],
  ["endnote", "endnote"],
]);

/** Structural observations only: indexes refer to the selected OOXML part. */
export class WordReadback {
  private readonly cells = new Map<Node, CellLocation>();
  private remainingSegments = MAX_LOCATION_SEGMENTS;

  constructor(
    root: Element,
    private readonly part: string,
    private readonly unitKind: string,
    private readonly unitIndex: number,
    private readonly unitCount: number
  ) {
    // One traversal preserves descendant table/physical row/cell ordering,
    // avoiding repeated scans of every subtree in deeply nested documents.
    const pending: WalkEntry[] = [{ node: root, row: null, table: null }];
    let tableIndex = 0;
    while (pending.length) {
      const current = pending.pop()!;
      const node = current.node;
      let { row, table } = current;
      if (node !== root && node.nodeType === 1) {
        const element = node as Element;
        if (WORD_NAMESPACES.has(element.namespaceURI ?? "")) {
          if (element.localName === "tbl") {
            tableIndex += 1;
            table = { index: tableIndex, rows: 0 };
          } else if (element.localName === "tr" && table) {
            table.rows += 1;
            row = { cells: 0, index: table.rows, table: table.index };
          } else if (element.localName === "tc" && row) {
            row.cells += 1;
            this.cells.set(node, {
              column: row.cells,
              row: row.index,
              table: row.table,
            });
          }
        }
      }
      for (let child = node.lastChild; child; child = child.previousSibling) {
        pending.push({ node: child, row, table });
      }
    }
  }

  location(element: Element, cell = false) {
    const parent = cell ? element : element.parentNode;
    const parentElement = parent?.nodeType === 1 ? (parent as Element) : null;
    const container =
      parentElement && WORD_NAMESPACES.has(parentElement.namespaceURI ?? "")
        ? (DIRECT_CONTAINERS.get(parentElement.localName ?? "") ?? "other")
        : "other";
    const tables: CellLocation[] = [];
    const segmentLimit = Math.min(MAX_TABLE_ANCESTRY, this.remainingSegments);
    let total = 0;
    let unmappedCells = 0;
    for (
      let ancestor: Node | null = parent;
      ancestor;
      ancestor = ancestor.parentNode
    ) {
      const location = this.cells.get(ancestor);
      if (location) {
        total += 1;
        if (tables.length < segmentLimit) {
          tables.push({ ...location });
        }
      } else if (ancestor.nodeType === 1) {
        const candidate = ancestor as Element;
        if (
          candidate.localName === "tc" &&
          WORD_NAMESPACES.has(candidate.namespaceURI ?? "")
        ) {
          unmappedCells += 1;
        }
      }
    }
    this.remainingSegments -= tables.length;
    return {
      container,
      // Paragraph reads identify their parent; a selected cell identifies
      // itself. This is the inspected container, not always the XML parent.
      containerElement: parentElement?.localName ?? null,
      tables: tables.reverse(),
      tablesCoverage: {
        complete: tables.length === total && unmappedCells === 0,
        omittedOuter: total - tables.length,
        returned: tables.length,
        total,
        unmappedCells,
      },
    };
  }

  coverage(selection: ReadbackSelection) {
    return {
      coverage: {
        completeWithinSelection:
          selection.paginationComplete &&
          selection.returnedTextComplete &&
          selection.returnedLocationsComplete,
        paginationComplete: selection.paginationComplete,
        returnedLocationsComplete: selection.returnedLocationsComplete,
        returnedTextComplete: selection.returnedTextComplete,
      },
      exclusions: [
        "other_units",
        "unselected_package_parts",
        "visual_layout",
        "non_text_properties",
        "deleted_or_moved_from_text",
        ...(selection.scope === "selected_table_cells"
          ? ["nested_table_cell_text"]
          : []),
      ],
      indexing: {
        columns: "physical_cells",
        paragraphs: "all_descendant_paragraphs",
        tables: "all_descendant_tables",
      },
      limits: {
        locationSegments: MAX_LOCATION_SEGMENTS,
        tableAncestry: MAX_TABLE_ANCESTRY,
      },
      part: this.part,
      scope: selection.scope,
      unitKind: this.unitKind,
      units: {
        catalogScope: "main_and_supported_direct_relationships",
        otherUnitsIncluded: false,
        selected: this.unitIndex,
        total: this.unitCount,
      },
      version: 1,
    };
  }
}

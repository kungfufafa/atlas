import {
  ARTIFACT_EDIT_MAX_COLUMNS,
  ARTIFACT_EDIT_MAX_FILE_BYTES,
  ARTIFACT_EDIT_MAX_ROWS,
} from "@atlas/core/artifact-editing-limits";

const EDITABLE_ARTIFACT_PATTERN = /\.(?:md|markdown|csv|tsv)$/i;

export interface ArtifactEditOperationGate {
  begin: () => number;
  current: () => number;
  invalidate: () => number;
  isCurrent: (operation: number) => boolean;
}

export function createArtifactEditOperationGate(): ArtifactEditOperationGate {
  let generation = 0;
  const advance = () => {
    generation += 1;
    return generation;
  };

  return {
    begin: advance,
    current: () => generation,
    invalidate: advance,
    isCurrent: (operation) => operation === generation,
  };
}

export function isEditableArtifactFilename(filename: string): boolean {
  return EDITABLE_ARTIFACT_PATTERN.test(filename.trim());
}

export function knownArtifactEditLimitReason(
  sizeBytes: number | undefined
): string | null {
  if (sizeBytes !== undefined && sizeBytes > ARTIFACT_EDIT_MAX_FILE_BYTES) {
    return "This file is too large to edit in the dashboard.";
  }
  return null;
}

export function cloneEditableRows(rows: string[][] | undefined): string[][] {
  if (!rows || rows.length === 0) {
    return [[""]];
  }
  return rows.map((row) => [...row]);
}

export function updateEditableCell(
  rows: string[][],
  rowIndex: number,
  columnIndex: number,
  value: string
): string[][] {
  return rows.map((row, currentRowIndex) => {
    if (currentRowIndex !== rowIndex) {
      return row;
    }
    const nextRow = [...row];
    while (nextRow.length <= columnIndex) {
      nextRow.push("");
    }
    nextRow[columnIndex] = value;
    return nextRow;
  });
}

export function addEditableRow(rows: string[][]): string[][] {
  if (rows.length >= ARTIFACT_EDIT_MAX_ROWS) {
    return rows;
  }
  const columnCount = Math.max(1, ...rows.map((row) => row.length));
  return [...rows, Array.from({ length: columnCount }, () => "")];
}

export function addEditableColumn(rows: string[][]): string[][] {
  const columnCount = Math.max(0, ...rows.map((row) => row.length));
  if (columnCount >= ARTIFACT_EDIT_MAX_COLUMNS) {
    return rows;
  }
  return rows.map((row) => [...row, ""]);
}

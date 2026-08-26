import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_EDIT_MAX_COLUMNS,
  ARTIFACT_EDIT_MAX_FILE_BYTES,
  ARTIFACT_EDIT_MAX_ROWS,
} from "@atlas/core/artifact-editing-limits";
import {
  addEditableColumn,
  addEditableRow,
  cloneEditableRows,
  createArtifactEditOperationGate,
  isEditableArtifactFilename,
  knownArtifactEditLimitReason,
  updateEditableCell,
} from "./artifact-editing";

describe("artifact editing UI helpers", () => {
  test("only recognizes the server-supported file extensions", () => {
    expect(isEditableArtifactFilename("notes.md")).toBe(true);
    expect(isEditableArtifactFilename("REPORT.MARKDOWN")).toBe(true);
    expect(isEditableArtifactFilename("data.csv")).toBe(true);
    expect(isEditableArtifactFilename("data.tsv")).toBe(true);
    expect(isEditableArtifactFilename("book.xlsx")).toBe(false);
    expect(isEditableArtifactFilename("page.mdx")).toBe(false);
  });

  test("clones, updates, and grows rows without mutating the source", () => {
    const source = [["a", "b"]];
    const cloned = cloneEditableRows(source);
    const updated = updateEditableCell(cloned, 0, 1, "changed");
    const withRow = addEditableRow(updated);
    const withColumn = addEditableColumn(withRow);

    expect(source).toEqual([["a", "b"]]);
    expect(withColumn).toEqual([
      ["a", "changed", ""],
      ["", "", ""],
    ]);
  });

  test("does not grow a table beyond server limits", () => {
    const fullRows = Array.from({ length: ARTIFACT_EDIT_MAX_ROWS }, () => [
      "x",
    ]);
    const fullColumns = [
      Array.from({ length: ARTIFACT_EDIT_MAX_COLUMNS }, () => "x"),
    ];

    expect(addEditableRow(fullRows)).toBe(fullRows);
    expect(addEditableColumn(fullColumns)).toBe(fullColumns);
    expect(
      knownArtifactEditLimitReason(ARTIFACT_EDIT_MAX_FILE_BYTES + 1)
    ).toContain("too large");
  });

  test("invalidates a late save when a newer artifact operation begins", async () => {
    const gate = createArtifactEditOperationGate();
    const saveA = gate.begin();
    let releaseSave: () => void = () => undefined;
    const pendingSave = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const lateSaveMayFinalize = pendingSave.then(() => gate.isCurrent(saveA));

    const draftB = gate.begin();
    releaseSave();

    expect(await lateSaveMayFinalize).toBe(false);
    expect(gate.isCurrent(draftB)).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import { coerceDeliverableArtifactPath } from "./artifact-path";

describe("coerceDeliverableArtifactPath", () => {
  test("prefixes relative deliverables with artifacts/", () => {
    expect(coerceDeliverableArtifactPath("deck.pptx")).toBe(
      "artifacts/deck.pptx"
    );
    expect(coerceDeliverableArtifactPath("./sales.xlsx")).toBe(
      "artifacts/sales.xlsx"
    );
  });

  test("keeps paths that are already under artifacts/", () => {
    expect(coerceDeliverableArtifactPath("artifacts/weekly/report.docx")).toBe(
      "artifacts/weekly/report.docx"
    );
  });

  test("does not rewrite absolute filesystem paths", () => {
    expect(coerceDeliverableArtifactPath("/tmp/laporan.docx")).toBe(
      "/tmp/laporan.docx"
    );
  });
});

import { describe, expect, it } from "bun:test";
import {
  createArtifactRevision,
  filterArtifactCandidates,
  inferTargetTypeFromPrompt,
  resolveArtifactOrDisambiguate,
} from "./artifact-resolver";
import type { Artifact } from "./artifact-types";

describe("Artifact Resolution & Disambiguation", () => {
  const samplePptx: Artifact = {
    createdAt: new Date().toISOString(),
    filename: "q3_strategy.pptx",
    id: "art-1",
    metadata: { slideCount: 5 },
    mimeType:
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    path: "artifacts/q3_strategy.pptx",
    revision: 1,
    sessionId: "session-1",
    size: 15_000,
    type: "presentation",
  };

  const sampleXlsx: Artifact = {
    createdAt: new Date().toISOString(),
    filename: "sales_analysis.xlsx",
    id: "art-2",
    metadata: { sheetCount: 3 },
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    path: "artifacts/sales_analysis.xlsx",
    revision: 1,
    sessionId: "session-1",
    size: 25_000,
    type: "spreadsheet",
  };

  const sampleDocx: Artifact = {
    createdAt: new Date().toISOString(),
    filename: "annual_report.docx",
    id: "art-3",
    metadata: { wordCount: 1200 },
    mimeType:
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    path: "artifacts/annual_report.docx",
    revision: 1,
    sessionId: "session-1",
    size: 12_000,
    type: "document",
  };

  it("Hard filter: filters by session boundary and explicit filename", () => {
    const candidates = filterArtifactCandidates({
      artifacts: [
        samplePptx,
        sampleXlsx,
        { ...sampleDocx, sessionId: "other-session" },
      ],
      explicitFilename: "q3_strategy.pptx",
      prompt: "edit presentation",
      sessionId: "session-1",
    });

    expect(candidates.length).toBe(1);
    expect(candidates[0].filename).toBe("q3_strategy.pptx");
  });

  it("Prompt intent inference identifies presentations, spreadsheets, and documents", () => {
    expect(inferTargetTypeFromPrompt("edit slide 2")).toBe("presentation");
    expect(inferTargetTypeFromPrompt("ubah presentasi tadi")).toBe(
      "presentation"
    );
    expect(inferTargetTypeFromPrompt("ubah formula sheet kedua")).toBe(
      "spreadsheet"
    );
    expect(inferTargetTypeFromPrompt("update sales excel column")).toBe(
      "spreadsheet"
    );
    expect(inferTargetTypeFromPrompt("ubah laporan tadi")).toBe("document");
  });

  it("Safe Resolution: Uniquely resolves presentation for 'edit slide 2'", () => {
    const res = resolveArtifactOrDisambiguate({
      artifacts: [samplePptx, sampleXlsx],
      prompt: "edit slide 2 and make it simpler",
      sessionId: "session-1",
    });

    expect(res.disambiguationRequired).toBe(false);
    expect(res.resolvedArtifact?.id).toBe("art-1");
    expect(res.topConfidence).toBeGreaterThanOrEqual(0.85);
  });

  it("Safe Resolution: Uniquely resolves spreadsheet for 'update formula sheet kedua'", () => {
    const res = resolveArtifactOrDisambiguate({
      artifacts: [samplePptx, sampleXlsx],
      prompt: "update formula sheet kedua",
      sessionId: "session-1",
    });

    expect(res.disambiguationRequired).toBe(false);
    expect(res.resolvedArtifact?.id).toBe("art-2");
  });

  it("Ambiguity Guard: Prompts targeted clarification for ambiguous 'edit page 2' with 2 candidates", () => {
    const res = resolveArtifactOrDisambiguate({
      artifacts: [samplePptx, sampleXlsx],
      prompt: "edit page 2",
      sessionId: "session-1",
    });

    expect(res.disambiguationRequired).toBe(true);
    expect(res.resolvedArtifact).toBeUndefined();
    expect(res.clarificationMessage).toContain(
      "Which artifact would you like to edit?"
    );
    expect(res.clarificationMessage).toContain("q3_strategy.pptx");
    expect(res.clarificationMessage).toContain("sales_analysis.xlsx");
    expect(res.options?.length).toBe(2);
  });

  it("Artifact Lineage: Generates immutable revision chain (v1 -> v2)", () => {
    const v2 = createArtifactRevision(
      samplePptx,
      "art-1-v2",
      "artifacts/q3_strategy_v2.pptx",
      16_000
    );

    expect(v2.id).toBe("art-1-v2");
    expect(v2.parentArtifactId).toBe("art-1");
    expect(v2.rootArtifactId).toBe("art-1");
    expect(v2.revision).toBe(2);
    expect(v2.metadata?.previousRevision).toBe(1);

    const v3 = createArtifactRevision(
      v2,
      "art-1-v3",
      "artifacts/q3_strategy_v3.pptx",
      17_000
    );
    expect(v3.id).toBe("art-1-v3");
    expect(v3.parentArtifactId).toBe("art-1-v2");
    expect(v3.rootArtifactId).toBe("art-1");
    expect(v3.revision).toBe(3);
  });
});

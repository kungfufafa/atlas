import { describe, expect, test } from "bun:test";
import {
  isMermaidArtifactFilename,
  markdownForMermaidSource,
  mermaidPreviewError,
} from "./artifact-mermaid-preview";
import { MAX_MERMAID_PREVIEW_CHARS } from "./artifact-preview-limits";

describe("isMermaidArtifactFilename", () => {
  test("matches mermaid source extensions", () => {
    expect(isMermaidArtifactFilename("flow.mmd")).toBe(true);
    expect(isMermaidArtifactFilename("chart.MERMAID")).toBe(true);
    expect(isMermaidArtifactFilename("notes.md")).toBe(false);
  });
});

describe("markdownForMermaidSource", () => {
  test("wraps raw mermaid in a fence", () => {
    expect(markdownForMermaidSource("graph TD; A-->B")).toBe(
      "```mermaid\ngraph TD; A-->B\n```"
    );
  });

  test("leaves an existing mermaid fence alone", () => {
    const fenced = "```mermaid\ngraph TD; A-->B\n```";
    expect(markdownForMermaidSource(fenced)).toBe(fenced);
  });
});

describe("mermaidPreviewError", () => {
  test("rejects empty and oversized diagrams", () => {
    expect(mermaidPreviewError("   ")).toBe("This diagram is empty.");
    expect(mermaidPreviewError("a".repeat(MAX_MERMAID_PREVIEW_CHARS + 1))).toBe(
      "This diagram is too large to preview."
    );
    expect(mermaidPreviewError("graph TD; A-->B")).toBeNull();
  });
});

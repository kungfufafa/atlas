import { describe, expect, test } from "bun:test";
import {
  artifactCanvasId,
  artifactCanvasTypeLabel,
  chatRefFromStructuredArtifact,
  mergeTurnCanvasArtifacts,
} from "./artifact-canvas";
import type { ChatArtifactRef } from "./chat-artifacts";

const toolRef: ChatArtifactRef = {
  filename: "report.md",
  mimeType: "text/markdown",
  path: "report.md",
  savedAt: "2026-08-17T10:00:00.000Z",
  sizeBytes: 42,
};

describe("artifactCanvasId", () => {
  test("is stable for a path so streaming and chips share one canvas", () => {
    expect(artifactCanvasId("weekly/report.md")).toBe(
      "artifact:weekly/report.md"
    );
  });
});

describe("mergeTurnCanvasArtifacts", () => {
  test("dedupes structured paths that still include the artifacts prefix", () => {
    expect(
      mergeTurnCanvasArtifacts(
        [toolRef],
        [
          {
            createdAt: "2026-08-17T10:00:00.000Z",
            filename: "report.md",
            mimeType: "text/markdown",
            path: "artifacts/report.md",
            size: 99,
          },
        ]
      )
    ).toEqual([toolRef]);
  });

  test("prefers tool refs and adds structured artifacts with new paths", () => {
    expect(
      mergeTurnCanvasArtifacts(
        [toolRef],
        [
          {
            createdAt: "2026-08-17T10:00:00.000Z",
            filename: "report.md",
            mimeType: "text/markdown",
            path: "report.md",
            size: 99,
          },
          {
            createdAt: "2026-08-17T10:01:00.000Z",
            filename: "chart.html",
            mimeType: "text/html",
            path: "chart.html",
            size: 120,
          },
        ]
      )
    ).toEqual([
      toolRef,
      chatRefFromStructuredArtifact({
        createdAt: "2026-08-17T10:01:00.000Z",
        filename: "chart.html",
        mimeType: "text/html",
        path: "chart.html",
        size: 120,
      }),
    ]);
  });
});

describe("artifactCanvasTypeLabel", () => {
  test("labels common preview kinds", () => {
    expect(artifactCanvasTypeLabel("notes.md", "text/markdown")).toBe(
      "Markdown"
    );
    expect(artifactCanvasTypeLabel("app.html", "text/html")).toBe("HTML");
    expect(artifactCanvasTypeLabel("mark.svg", "image/svg+xml")).toBe("SVG");
    expect(artifactCanvasTypeLabel("flow.mmd", "text/plain")).toBe("Mermaid");
    expect(
      artifactCanvasTypeLabel("deck.pptx", "application/octet-stream")
    ).toBe("Slides");
  });
});

import { describe, expect, test } from "bun:test";
import type { ArtifactPreview, HtmlPreview, ImagePreview } from "@atlas/core";
import {
  artifactCanvasId,
  artifactCanvasSourceLanguage,
  artifactCanvasTypeLabel,
  artifactPreviewCanCopy,
  artifactPreviewUsesFetchedSource,
  artifactSupportsPreviewCodeToggle,
  chatRefFromStructuredArtifact,
  isSvgArtifactPreview,
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

describe("artifactSupportsPreviewCodeToggle", () => {
  test("is true for live canvases, not for documents or images", () => {
    expect(artifactSupportsPreviewCodeToggle("app.html", "text/html")).toBe(
      true
    );
    expect(artifactSupportsPreviewCodeToggle("Widget.jsx", "text/plain")).toBe(
      true
    );
    expect(artifactSupportsPreviewCodeToggle("mark.svg", "image/svg+xml")).toBe(
      true
    );
    expect(artifactSupportsPreviewCodeToggle("flow.mmd", "text/plain")).toBe(
      true
    );
    expect(artifactSupportsPreviewCodeToggle("notes.md", "text/markdown")).toBe(
      false
    );
    expect(artifactSupportsPreviewCodeToggle("photo.png", "image/png")).toBe(
      false
    );
  });
});

describe("artifactCanvasSourceLanguage", () => {
  test("picks a highlighter language for live canvases", () => {
    expect(artifactCanvasSourceLanguage("app.html", "text/html")).toBe("html");
    expect(artifactCanvasSourceLanguage("Widget.jsx", "text/plain")).toBe(
      "jsx"
    );
    expect(artifactCanvasSourceLanguage("mark.svg", "image/svg+xml")).toBe(
      "xml"
    );
    expect(artifactCanvasSourceLanguage("flow.mmd", "text/plain")).toBe(
      "mermaid"
    );
  });
});

function htmlPreview(): HtmlPreview {
  return {
    filename: "app.html",
    generatedAt: "2026-08-20T00:00:00.000Z",
    mimeType: "text/html",
    previewVersion: 1,
    safeHtml: "<p>safe</p>",
    sizeBytes: 8,
    status: "available",
    type: "html",
  };
}

function imagePreview(
  overrides: Partial<ImagePreview> & Pick<ImagePreview, "filename" | "format">
): ImagePreview {
  return {
    generatedAt: "2026-08-20T00:00:00.000Z",
    mimeType: "image/png",
    previewVersion: 1,
    sizeBytes: 12,
    status: "available",
    type: "image",
    url: "/preview.png",
    ...overrides,
  };
}

describe("artifact preview copy helpers", () => {
  test("treats HTML and SVG as fetched copy sources", () => {
    const html = htmlPreview();
    const svg = imagePreview({
      filename: "mark.svg",
      format: "svg",
      mimeType: "image/svg+xml",
    });
    const png = imagePreview({ filename: "photo.png", format: "png" });

    expect(artifactPreviewUsesFetchedSource(html)).toBe(true);
    expect(isSvgArtifactPreview(svg)).toBe(true);
    expect(artifactPreviewUsesFetchedSource(svg)).toBe(true);
    expect(artifactPreviewCanCopy(html)).toBe(true);
    expect(artifactPreviewCanCopy(svg)).toBe(true);
    expect(artifactPreviewCanCopy(png)).toBe(false);
    expect(isSvgArtifactPreview(png)).toBe(false);
  });

  test("allows copy for text-like previews", () => {
    const code = {
      content: "print(1)",
      filename: "main.py",
      generatedAt: "2026-08-20T00:00:00.000Z",
      language: "python",
      lineCount: 1,
      mimeType: "text/x-python",
      previewVersion: 1,
      sizeBytes: 8,
      status: "available",
      type: "code",
    } satisfies ArtifactPreview;

    expect(artifactPreviewCanCopy(code)).toBe(true);
    expect(artifactPreviewUsesFetchedSource(code)).toBe(false);
    expect(artifactPreviewCanCopy(null)).toBe(false);
  });
});

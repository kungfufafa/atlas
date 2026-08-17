import { describe, expect, test } from "bun:test";
import {
  artifactPanelBodyClassName,
  artifactPanelDefaultWidth,
  artifactPanelSubtitle,
} from "./artifact-attachment-panel-body.shared";

describe("artifactPanelDefaultWidth", () => {
  test("uses a wide canvas for documents and html", () => {
    expect(
      artifactPanelDefaultWidth("notes.md", "text/markdown")
    ).toBeGreaterThanOrEqual(512);
    expect(
      artifactPanelDefaultWidth("app.html", "text/html")
    ).toBeGreaterThanOrEqual(512);
  });

  test("keeps video narrower", () => {
    expect(artifactPanelDefaultWidth("clip.mp4", "video/mp4")).toBeLessThan(
      512
    );
  });
});

describe("artifactPanelSubtitle", () => {
  test("only shows a subtitle while the artifact is streaming", () => {
    expect(artifactPanelSubtitle({ streaming: true })).toBe("Writing…");
    expect(
      artifactPanelSubtitle({
        mimeType: "text/html",
        sizeBytes: 1200,
        streaming: false,
      })
    ).toBeNull();
  });
});

describe("artifactPanelBodyClassName", () => {
  test("makes html full-bleed and markdown a document page", () => {
    expect(
      artifactPanelBodyClassName({
        isHtml: true,
        isImage: false,
        isMarkdown: false,
      })
    ).toContain("p-0");
    expect(
      artifactPanelBodyClassName({
        isHtml: false,
        isImage: false,
        isMarkdown: true,
      })
    ).toContain("px-6");
  });
});

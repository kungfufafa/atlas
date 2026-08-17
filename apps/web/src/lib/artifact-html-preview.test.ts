import { describe, expect, test } from "bun:test";
import {
  ARTIFACT_HTML_IFRAME_CSP,
  ARTIFACT_HTML_IFRAME_SANDBOX,
  ARTIFACT_HTML_PREVIEW_MESSAGE_SOURCE,
  htmlForArtifactPreview,
  isTrustedArtifactPreviewMessage,
  prepareHtmlPreview,
} from "./artifact-html-preview";
import { MAX_HTML_PREVIEW_CHARS } from "./artifact-preview-limits";

describe("artifact HTML preview", () => {
  test("sandbox allows scripts without same-origin access to host", () => {
    expect(ARTIFACT_HTML_IFRAME_SANDBOX).toContain("allow-scripts");
    expect(ARTIFACT_HTML_IFRAME_SANDBOX).not.toContain("allow-same-origin");
  });

  test("csp blocks network and parent-document access", () => {
    expect(ARTIFACT_HTML_IFRAME_CSP).toContain("default-src 'none'");
    expect(ARTIFACT_HTML_IFRAME_CSP).toContain("connect-src 'none'");
    expect(ARTIFACT_HTML_IFRAME_CSP).not.toContain("allow-same-origin");
  });
});

describe("htmlForArtifactPreview", () => {
  test("injects scrollbar styles, csp, and preview bridge into head", () => {
    const html = "<html><head><title>Slides</title></head><body></body></html>";
    const prepared = htmlForArtifactPreview(html);
    expect(prepared).toContain("<head><style data-atlas-html-preview>");
    expect(prepared).toContain("Content-Security-Policy");
    expect(prepared).toContain(ARTIFACT_HTML_PREVIEW_MESSAGE_SOURCE);
  });

  test("wraps fragments with style tag", () => {
    expect(htmlForArtifactPreview("<div>slide</div>")).toStartWith(
      "<style data-atlas-html-preview>"
    );
  });
});

describe("prepareHtmlPreview", () => {
  test("accepts typical html and rejects oversized payloads", () => {
    expect(prepareHtmlPreview("<h1>ok</h1>").status).toBe("ok");
    expect(
      prepareHtmlPreview("a".repeat(MAX_HTML_PREVIEW_CHARS + 1)).status
    ).toBe("too_large");
  });
});

describe("isTrustedArtifactPreviewMessage", () => {
  test("rejects messages that are not from the preview iframe", () => {
    const iframe = { contentWindow: {} } as HTMLIFrameElement;
    expect(
      isTrustedArtifactPreviewMessage(
        {
          data: { source: ARTIFACT_HTML_PREVIEW_MESSAGE_SOURCE },
          origin: "https://evil.test",
          source: iframe.contentWindow,
        } as MessageEvent,
        iframe
      )
    ).toBe(false);
    expect(
      isTrustedArtifactPreviewMessage(
        {
          data: { source: "other" },
          origin: "null",
          source: iframe.contentWindow,
        } as MessageEvent,
        iframe
      )
    ).toBe(false);
  });

  test("accepts opaque-origin messages from the iframe window", () => {
    const iframe = { contentWindow: {} } as HTMLIFrameElement;
    expect(
      isTrustedArtifactPreviewMessage(
        {
          data: {
            event: "ready",
            source: ARTIFACT_HTML_PREVIEW_MESSAGE_SOURCE,
          },
          origin: "null",
          source: iframe.contentWindow,
        } as MessageEvent,
        iframe
      )
    ).toBe(true);
  });
});

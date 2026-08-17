import { describe, expect, test } from "bun:test";
import { MAX_SVG_PREVIEW_CHARS } from "./artifact-preview-limits";
import { prepareSvgPreview } from "./artifact-svg-preview";

describe("prepareSvgPreview", () => {
  test("sanitizes scripts and event handlers into a data url", () => {
    const result =
      prepareSvgPreview(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
      <script>alert("xss")</script>
      <circle cx="10" cy="10" r="5" />
    </svg>`);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }
    expect(result.sanitized).not.toContain("<script>");
    expect(result.sanitized).not.toContain("onload=");
    expect(result.sanitized).toContain("<circle");
    expect(result.dataUrl.startsWith("data:image/svg+xml")).toBe(true);
  });

  test("rejects payloads that are not svg", () => {
    expect(prepareSvgPreview("<div>nope</div>").status).toBe("invalid");
    expect(prepareSvgPreview("").status).toBe("invalid");
  });

  test("rejects oversized svg instead of rendering it", () => {
    const huge = `<svg>${"a".repeat(MAX_SVG_PREVIEW_CHARS)}</svg>`;
    expect(prepareSvgPreview(huge).status).toBe("too_large");
  });
});

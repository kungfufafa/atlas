import { describe, expect, test } from "bun:test";
import { resolveServedArtifactContentType } from "./signature";

describe("resolveServedArtifactContentType", () => {
  test("keeps declared text types when the payload is text", () => {
    expect(
      resolveServedArtifactContentType(
        "notes.md",
        "text/markdown",
        Buffer.from("# hello")
      )
    ).toBe("text/markdown");
  });

  test("does not serve a mismatched pdf as application/pdf", () => {
    expect(
      resolveServedArtifactContentType(
        "report.pdf",
        "application/pdf",
        Buffer.from("<html><body>nope</body></html>")
      )
    ).toBe("application/octet-stream");
  });

  test("sniffs a real pdf header", () => {
    expect(
      resolveServedArtifactContentType(
        "report.pdf",
        "application/pdf",
        Buffer.from("%PDF-1.7\n%")
      )
    ).toBe("application/pdf");
  });

  test("rejects executable payloads", () => {
    expect(
      resolveServedArtifactContentType(
        "notes.txt",
        "text/plain",
        Buffer.from([0x4d, 0x5a, 0x90, 0x00])
      )
    ).toBe("application/octet-stream");
  });
});

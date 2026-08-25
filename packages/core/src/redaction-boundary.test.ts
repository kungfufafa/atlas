import { describe, expect, test } from "bun:test";
import { applyRedactionBoundary } from "./redaction-boundary";
import { REDACTED_MARKER } from "./secret-redaction";

describe("redaction boundary", () => {
  test("redacts secrets before memory persist", () => {
    const redacted = applyRedactionBoundary(
      { apiKey: "secret", note: "token=sk-abcdefghijklmnopqrstuvwxyz" },
      "memory"
    );
    expect(redacted.apiKey).toBe(REDACTED_MARKER);
    expect(redacted.note).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  test("redacts outbound text", () => {
    const redacted = applyRedactionBoundary(
      "Authorization: Bearer super-secret-token-value",
      "outbound"
    );
    expect(redacted).toContain("[REDACTED]");
  });

  test("redacts private key blocks for audit sink", () => {
    const redacted = applyRedactionBoundary(
      "-----BEGIN RSA PRIVATE KEY-----\nABC\n-----END RSA PRIVATE KEY-----",
      "audit"
    );
    expect(redacted).toContain("REDACTED");
    expect(redacted).not.toContain("BEGIN RSA PRIVATE KEY");
  });
});

import { describe, expect, test } from "bun:test";
import { applyRedactionBoundary } from "./redaction-boundary";
import { REDACTED_MARKER } from "./secret-redaction";
import { SYNTHETIC_SECRET_FIXTURES } from "./testing/synthetic-secret-fixtures";

describe("redaction boundary", () => {
  test("redacts secrets before memory persist", () => {
    const redacted = applyRedactionBoundary(
      {
        apiKey: "secret",
        note: `token=${SYNTHETIC_SECRET_FIXTURES.openAiApiKey}`,
      },
      "memory"
    );
    expect(redacted.apiKey).toBe(REDACTED_MARKER);
    expect(redacted.note).not.toContain(SYNTHETIC_SECRET_FIXTURES.openAiApiKey);
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
      SYNTHETIC_SECRET_FIXTURES.rsaPrivateKey,
      "audit"
    );
    expect(redacted).toContain("REDACTED");
    expect(redacted).not.toContain("BEGIN RSA PRIVATE KEY");
  });
});

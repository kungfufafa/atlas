import { describe, expect, it } from "bun:test";
import {
  isSensitiveKeyName,
  REDACTED_MARKER,
  redactSensitiveData,
  redactStringValue,
} from "./secret-redaction";
import { SecretScanner } from "./secret-scanner";

describe("Secret Redaction & Scanner", () => {
  it("detects sensitive key names case-insensitively", () => {
    expect(isSensitiveKeyName("apiKey")).toBe(true);
    expect(isSensitiveKeyName("api_key")).toBe(true);
    expect(isSensitiveKeyName("API_KEY")).toBe(true);
    expect(isSensitiveKeyName("password")).toBe(true);
    expect(isSensitiveKeyName("passwordHash")).toBe(true);
    expect(isSensitiveKeyName("authorization")).toBe(true);
    expect(isSensitiveKeyName("clientSecret")).toBe(true);
    expect(isSensitiveKeyName("token")).toBe(true);
    expect(isSensitiveKeyName("refreshToken")).toBe(true);
    expect(isSensitiveKeyName("databaseUrl")).toBe(true);
    expect(isSensitiveKeyName("username")).toBe(false);
    expect(isSensitiveKeyName("sessionId")).toBe(false);
  });

  it("redacts sensitive fields in nested objects and arrays", () => {
    const rawData = {
      apiKey: "super-secret-tokenrouter-key-123456",
      config: {
        api_key: "nested-secret-key",
        baseUrl: "https://api.tokenrouter.com/v1",
        tokens: ["public-token", { secret: "inner-secret" }],
      },
      headers: {
        authorization: "Bearer my-secret-jwt-token",
        "content-type": "application/json",
      },
      provider: "TokenRouter",
    };

    const redacted = redactSensitiveData(rawData);

    expect(redacted.apiKey).toBe(REDACTED_MARKER);
    expect(redacted.config.api_key).toBe(REDACTED_MARKER);
    expect(redacted.config.baseUrl).toBe("https://api.tokenrouter.com/v1");
    expect(redacted.config.tokens[1].secret).toBe(REDACTED_MARKER);
    expect(redacted.headers.authorization).toBe(REDACTED_MARKER);
    expect(redacted.headers["content-type"]).toBe("application/json");
  });

  it("redacts string patterns like Bearer tokens and private keys", () => {
    const textWithBearer =
      "Request failed with header: Bearer abcdef1234567890xyz";
    expect(redactStringValue(textWithBearer)).toBe(
      "Request failed with header: Bearer [REDACTED]"
    );

    const textWithKey =
      "Connected to postgresql://user123:secretPassword456@db.prod.internal:5432/atlas";
    expect(redactStringValue(textWithKey)).toBe(
      "Connected to postgresql://user123:[REDACTED]@db.prod.internal:5432/atlas"
    );

    const privateKeyBlock =
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0...\n-----END RSA PRIVATE KEY-----";
    expect(redactStringValue(privateKeyBlock)).toBe("[REDACTED PRIVATE KEY]");
  });

  it("sanitizes Error objects including message, stack, and cause", () => {
    const innerError = new Error(
      "Failed connecting with password=secretPassword999"
    );
    const topError = new Error(
      "Provider rejected sk-abcdefghijklmnopqrstuvwxyz12345"
    );
    topError.cause = innerError;
    (topError as unknown as Record<string, unknown>).apiKey = "exposed-api-key";

    const sanitized = redactSensitiveData(topError);

    expect(sanitized.message).not.toContain(
      "sk-abcdefghijklmnopqrstuvwxyz12345"
    );
    expect(sanitized.message).toContain(REDACTED_MARKER);
    expect(sanitized.stack).not.toContain("sk-abcdefghijklmnopqrstuvwxyz12345");
    expect((sanitized as unknown as Record<string, unknown>).apiKey).toBe(
      REDACTED_MARKER
    );
    expect((sanitized.cause as Error).message).not.toContain(
      "secretPassword999"
    );
  });

  it("SecretScanner detects high-confidence leaked keys", () => {
    const scanner = new SecretScanner();

    const leakedContent = `
      export const config = {
        key: "sk-11223344556677889900aabbccddeeff",
        db: "postgresql://admin:superSecretPass@localhost:5432/db"
      };
    `;

    const findings = scanner.scanText(leakedContent, "test-file.ts");
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.redactedSnippet).not.toContain(
        "sk-11223344556677889900aabbccddeeff"
      );
      expect(finding.redactedSnippet).not.toContain("superSecretPass");
    }
  });
});

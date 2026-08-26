import { describe, expect, test } from "bun:test";
import { validateComposioOAuthRedirect } from "./composio-oauth";

describe("validateComposioOAuthRedirect", () => {
  test("accepts secure external and local development redirects", () => {
    expect(
      validateComposioOAuthRedirect("https://backend.composio.dev/connect?a=1")
    ).toBe("https://backend.composio.dev/connect?a=1");
    expect(validateComposioOAuthRedirect("http://localhost:4310/oauth")).toBe(
      "http://localhost:4310/oauth"
    );
  });

  test("rejects script, insecure remote, credentialed, and malformed URLs", () => {
    for (const value of [
      "javascript:alert(1)",
      "http://example.com/oauth",
      "https://user:pass@example.com/oauth",
      "not a url",
    ]) {
      expect(() => validateComposioOAuthRedirect(value)).toThrow();
    }
  });
});

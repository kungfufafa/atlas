import { describe, expect, test } from "bun:test";
import {
  applyCustomProviderPreset,
  matchCustomProviderPreset,
  normalizeCustomProviderBaseUrl,
} from "./custom-provider-presets";

describe("custom provider presets", () => {
  test("normalizes trailing slashes on base URLs", () => {
    expect(normalizeCustomProviderBaseUrl("http://localhost:1234/v1/")).toBe(
      "http://localhost:1234/v1"
    );
  });

  test("matches a known endpoint even with a trailing slash", () => {
    expect(matchCustomProviderPreset("http://localhost:1234/v1/")).toBe(
      "lmstudio"
    );
    expect(matchCustomProviderPreset("https://api.groq.com/openai/v1")).toBe(
      "groq"
    );
    expect(matchCustomProviderPreset("https://api.tokenrouter.com/v1/")).toBe(
      "tokenrouter"
    );
  });

  test("falls back to custom for unknown or empty URLs", () => {
    expect(matchCustomProviderPreset("")).toBe("custom");
    expect(matchCustomProviderPreset("https://example.com/v1")).toBe("custom");
  });

  test("applies name and URL for a known preset", () => {
    expect(applyCustomProviderPreset("together")).toEqual({
      baseUrl: "https://api.together.xyz/v1",
      name: "Together",
    });
    expect(applyCustomProviderPreset("tokenrouter")).toEqual({
      baseUrl: "https://api.tokenrouter.com/v1",
      name: "TokenRouter",
    });
  });

  test("does not apply values for the custom preset", () => {
    expect(applyCustomProviderPreset("custom")).toBeNull();
    expect(applyCustomProviderPreset("missing")).toBeNull();
  });
});

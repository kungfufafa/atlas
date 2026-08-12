import { describe, expect, test } from "bun:test";
import { validateProviderConnection } from "./provider-validation-service";

describe("validateProviderConnection", () => {
  test("throws error when API key is missing for key-required providers", async () => {
    await expect(
      validateProviderConnection({
        apiKey: "   ",
        type: "gemini",
      })
    ).rejects.toThrow("API key is required.");
  });

  test("throws error when API key is missing for Ollama Cloud mode", async () => {
    await expect(
      validateProviderConnection({
        apiKey: "",
        hostMode: "cloud",
        type: "ollama",
      })
    ).rejects.toThrow("API key is required for Ollama Cloud mode.");
  });

  test("validates provider API key failure gracefully", async () => {
    await expect(
      validateProviderConnection({
        apiKey: "invalid-key-12345",
        type: "openai",
      })
    ).rejects.toThrow(/API key or connection validation failed/);
  });
});

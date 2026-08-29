import { expect, test } from "bun:test";
import {
  isSimpleApiKeyProvider,
  mobileSetupProviders,
} from "./mobile-providers";

test("offers API-key providers and skips subscription and local hosts", () => {
  const ids = mobileSetupProviders().map((provider) => provider.id);

  expect(ids).toContain("openai");
  expect(ids).toContain("anthropic");
  expect(ids).toContain("openrouter");
  expect(ids).toContain("opencode_go");
  expect(ids).not.toContain("chatgpt");
  expect(ids).not.toContain("claude");
  expect(ids).not.toContain("ollama");
  expect(ids).not.toContain("openai_compatible");
  expect(ids).not.toContain("fireworks");
});

test("rejects providers that need a host URL", () => {
  expect(
    isSimpleApiKeyProvider({
      apiKey: { placeholder: "sk", requirement: "required" },
      apiKeyEnvVar: null,
      displayName: "Custom",
      fallbackModelId: "x",
      id: "openai_compatible",
      setup: { baseUrlRequired: true },
    })
  ).toBe(false);
});

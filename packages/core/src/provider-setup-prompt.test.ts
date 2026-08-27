import { describe, expect, test } from "bun:test";
import type { ProviderModelOption } from "./contract";
import { BUILTIN_PROVIDER_DEFINITIONS } from "./provider-catalog";
import { promptForProviderConfig } from "./provider-setup-prompt";

const CLOUDFLARE_MODEL: ProviderModelOption = {
  id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  name: "Llama 3.3 70B",
  provider: "cloudflare",
};

function promptOptions(answers: string[]) {
  const queue = [...answers];
  return {
    getDefaultModel: () => CLOUDFLARE_MODEL.id,
    getModelById: (modelId: string) =>
      modelId === CLOUDFLARE_MODEL.id ? CLOUDFLARE_MODEL : undefined,
    getModelsForProvider: (provider: string) =>
      provider === "cloudflare" ? [CLOUDFLARE_MODEL] : [],
    question: async () => queue.shift() ?? "",
    writeLine: () => undefined,
  };
}

describe("promptForProviderConfig", () => {
  test("renders provider choices from the catalog", async () => {
    const lines: string[] = [];
    await promptForProviderConfig({
      ...promptOptions(["cloudflare", "cf-key", "account-123", ""]),
      writeLine: (line) => lines.push(line),
    });

    for (const definition of BUILTIN_PROVIDER_DEFINITIONS) {
      expect(lines.some((line) => line.includes(definition.displayName))).toBe(
        true
      );
    }
  });

  test("accepts a free-form model for a catalog-declared custom-model provider", async () => {
    const config = await promptForProviderConfig(
      promptOptions(["openrouter", "router-key", "vendor/new-model"])
    );

    expect(config.providers[0]).toMatchObject({
      customModels: [{ default: true, id: "vendor/new-model" }],
      type: "openrouter",
    });
  });

  test("persists Responses mode for a custom endpoint", async () => {
    const config = await promptForProviderConfig(
      promptOptions([
        "openai_compatible",
        "My endpoint",
        "https://endpoint.test/v1/",
        "",
        "responses",
        "gpt-5.4, gpt-5.4-mini",
      ])
    );

    expect(config.providers[0]).toMatchObject({
      baseUrl: "https://endpoint.test/v1",
      customModels: [{ default: true, id: "gpt-5.4" }, { id: "gpt-5.4-mini" }],
      label: "My endpoint",
      type: "openai_compatible",
      wireApi: "responses",
    });
  });

  test("uses the regional xAI endpoint and saves entered models", async () => {
    const config = await promptForProviderConfig(
      promptOptions(["xai", "xai-key", "", "grok-4, grok-4-fast"])
    );

    expect(config.providers[0]).toMatchObject({
      apiKey: "xai-key",
      baseUrl: "https://api.x.ai/v1",
      customModels: [{ default: true, id: "grok-4" }, { id: "grok-4-fast" }],
      type: "xai",
    });
  });

  test("turns a Cloudflare account ID into its Workers AI endpoint", async () => {
    const config = await promptForProviderConfig(
      promptOptions(["cloudflare", "cf-key", "account-123", ""])
    );

    expect(config.providers[0]).toMatchObject({
      apiKey: "cf-key",
      baseUrl:
        "https://api.cloudflare.com/client/v4/accounts/account-123/ai/v1",
      type: "cloudflare",
    });
  });
});

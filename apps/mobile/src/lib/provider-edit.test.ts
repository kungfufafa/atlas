import { describe, expect, test } from "bun:test";
import type { ProviderInstanceSummary } from "@atlas/core/contract";
import {
  buildProviderTestRequest,
  buildProviderUpdateRequest,
  normalizeProviderBaseUrl,
  PROVIDER_BASE_URL_KEY_ERROR,
  validateProviderConnectionTest,
  validateProviderEdit,
} from "./provider-edit";

function provider(
  overrides: Partial<ProviderInstanceSummary> = {}
): ProviderInstanceSummary {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    hasApiKey: true,
    id: "provider-1",
    label: "OpenAI",
    modelCount: 1,
    type: "openai",
    ...overrides,
  };
}

describe("provider editing", () => {
  test("normalizes trailing slashes before comparing endpoints", () => {
    expect(normalizeProviderBaseUrl(" https://api.example.test/v1/// ")).toBe(
      "https://api.example.test/v1"
    );
    expect(
      validateProviderEdit(
        provider({ baseUrl: "https://api.example.test/v1" }),
        {
          apiKey: "",
          baseUrl: "https://api.example.test/v1/",
          label: "OpenAI",
        }
      )
    ).toBeNull();
  });

  test("requires the stored key to be re-entered for a new endpoint", () => {
    expect(
      validateProviderEdit(
        provider({ baseUrl: "https://trusted.example/v1" }),
        {
          apiKey: "",
          baseUrl: "https://different.example/v1",
          label: "OpenAI",
        }
      )
    ).toBe(PROVIDER_BASE_URL_KEY_ERROR);
  });

  test("builds a trimmed update without replacing a blank key", () => {
    expect(
      buildProviderUpdateRequest(
        provider({ baseUrl: "https://api.example.test/v1" }),
        {
          apiKey: "  replacement-key  ",
          baseUrl: " https://api.example.test/v2/ ",
          label: " Primary ",
        }
      )
    ).toEqual({
      apiKey: "replacement-key",
      baseUrl: "https://api.example.test/v2",
      label: "Primary",
    });
  });

  test("omits an unused optional endpoint", () => {
    expect(
      buildProviderUpdateRequest(provider({ baseUrl: null }), {
        apiKey: "",
        baseUrl: "",
        label: "Primary",
      })
    ).toEqual({ label: "Primary" });
  });

  test("asks for a key before testing a stored credential", () => {
    expect(
      validateProviderConnectionTest(provider(), {
        apiKey: "",
        baseUrl: "",
        label: "OpenAI",
      })
    ).toBe("Enter the API key to test this connection.");
  });

  test("builds a compatible-provider probe from the edited connection", () => {
    const compatible = provider({
      baseUrl: "https://old.example/v1",
      customModels: [{ default: true, id: "model-1" }],
      type: "openai_compatible",
      wireApi: "responses",
    });

    expect(
      buildProviderTestRequest(compatible, {
        apiKey: " new-key ",
        baseUrl: " https://new.example/v1/ ",
        label: "Compatible",
      })
    ).toEqual({
      apiKey: "new-key",
      baseUrl: "https://new.example/v1",
      customModels: [{ default: true, id: "model-1" }],
      type: "openai_compatible",
      wireApi: "responses",
    });
  });

  test("leaves subscription connection management to subscription auth", () => {
    const subscription = provider({
      hasApiKey: false,
      type: "chatgpt",
    });
    const draft = { apiKey: "", baseUrl: "", label: "ChatGPT" };

    expect(buildProviderTestRequest(subscription, draft)).toBeNull();
    expect(validateProviderConnectionTest(subscription, draft)).toBe(
      "Connection status is managed by subscription sign-in."
    );
  });
});

import { describe, expect, test } from "bun:test";
import {
  apiKeyEnvVarForProvider,
  parseProviderName,
  resolveProvider,
} from "./provider-resolution";

describe("parseProviderName", () => {
  test("accepts known providers", () => {
    expect(parseProviderName("openai")).toBe("openai");
    expect(parseProviderName("Anthropic")).toBe("anthropic");
    expect(parseProviderName(" GEMINI ")).toBe("gemini");
    expect(parseProviderName("openai_compatible")).toBe("openai_compatible");
    expect(parseProviderName("opencode_go")).toBe("opencode_go");
    expect(parseProviderName("deepseek")).toBe("deepseek");
    expect(parseProviderName("cerebras")).toBe("cerebras");
    expect(parseProviderName("fireworks")).toBe("fireworks");
    expect(parseProviderName("cloudflare")).toBe("cloudflare");
    expect(parseProviderName("minimax")).toBe("minimax");
    expect(parseProviderName("minimax_cn")).toBe("minimax_cn");
    expect(parseProviderName("xai")).toBe("xai");
    expect(parseProviderName("zhipu")).toBe("zhipu");
    expect(parseProviderName("zhipu_cn")).toBe("zhipu_cn");
  });

  test("rejects unknown values", () => {
    expect(parseProviderName("azure")).toBeNull();
    expect(parseProviderName("")).toBeNull();
  });
});

describe("native provider environment keys", () => {
  const cases = [
    ["cloudflare", "CLOUDFLARE_API_KEY"],
    ["minimax", "MINIMAX_API_KEY"],
    ["minimax_cn", "MINIMAX_CN_API_KEY"],
    ["xai", "XAI_API_KEY"],
    ["zhipu", "ZHIPU_API_KEY"],
    ["zhipu_cn", "ZHIPU_CN_API_KEY"],
  ] as const;

  test("maps each provider to an isolated key and resolves it", () => {
    for (const [provider, envName] of cases) {
      expect(apiKeyEnvVarForProvider(provider)).toBe(envName);
      expect(resolveProvider({ env: { [envName]: "test-key" } })).toBe(
        provider
      );
    }
  });
});

describe("resolveProvider", () => {
  test("prefers ATLAS_PROVIDER over env keys", () => {
    const provider = resolveProvider({
      env: {
        ATLAS_PROVIDER: "gemini",
        GEMINI_API_KEY: "test-key",
        OPENAI_API_KEY: "sk-test",
      },
    });

    expect(provider).toBe("gemini");
  });

  test("uses configured provider from user config", () => {
    const provider = resolveProvider({
      configuredProvider: "openrouter",
      env: {},
    });

    expect(provider).toBe("openrouter");
  });

  test("uses the only configured env API key", () => {
    const provider = resolveProvider({
      env: {
        GEMINI_API_KEY: "test-key",
      },
    });

    expect(provider).toBe("gemini");
  });

  test("returns null when multiple env API keys are set", () => {
    const provider = resolveProvider({
      env: {
        OPENAI_API_KEY: "sk-test",
        OPENROUTER_API_KEY: "sk-or-test",
      },
    });

    expect(provider).toBeNull();
  });

  test("returns null when provider is not configured", () => {
    expect(resolveProvider({ env: {} })).toBeNull();
  });
});

describe("resolveProvider deepseek", () => {
  test("does not auto-resolve DeepSeek from env API key", () => {
    const provider = resolveProvider({
      env: {
        DEEPSEEK_API_KEY: "sk-test",
      },
    });

    expect(provider).toBeNull();
  });
});

describe("resolveProvider cerebras", () => {
  test("auto-resolves Cerebras when it is the only env API key", () => {
    const provider = resolveProvider({
      env: {
        CEREBRAS_API_KEY: "sk-test",
      },
    });

    expect(provider).toBe("cerebras");
  });
});

describe("resolveProvider fireworks", () => {
  test("auto-resolves Fireworks when it is the only env API key", () => {
    const provider = resolveProvider({
      env: {
        FIREWORKS_API_KEY: "fw-test",
      },
    });

    expect(provider).toBe("fireworks");
  });
});

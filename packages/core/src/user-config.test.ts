import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtlasApiError } from "./api-error";
import { pathExists } from "./fs";
import { BUILTIN_PROVIDER_DEFINITIONS } from "./provider-catalog";
import {
  createProviderInstanceId,
  ensureUserConfigDir,
  getUserConfigDir,
  getUserConfigPath,
  loadUserConfig,
  loadUserWebPublicUrl,
  normalizeProviderInstanceLabel,
  runWithUserConfigDir,
  saveUserConfig,
  saveUserTimezone,
  saveUserWebPublicUrl,
  validateProviderApiKeyFormat,
} from "./user-config";

describe("validateProviderApiKeyFormat", () => {
  test("rejects malformed keys for providers with documented formats", () => {
    expect(() =>
      validateProviderApiKeyFormat("sk-junk-qa-123", "openai")
    ).toThrow(/valid OpenAI API key/i);
    expect(() =>
      validateProviderApiKeyFormat(`AIza${"a".repeat(40)}`, "anthropic")
    ).toThrow(/valid Anthropic API key/i);
  });

  test("accepts valid and opaque provider key formats", () => {
    const openAiKey = `sk-${"a".repeat(48)}`;
    expect(validateProviderApiKeyFormat(openAiKey, "openai")).toBe(openAiKey);
    expect(validateProviderApiKeyFormat("short", "fireworks")).toBe("short");
    expect(validateProviderApiKeyFormat("short", "openai_compatible")).toBe(
      "short"
    );
  });
});

describe("saveUserTimezone", () => {
  // readJson casts the body without validating it, so timezone can arrive
  // undefined however the contract types it.
  test("names the missing field and answers 400, not a TypeError at 500", async () => {
    const cases = [
      [undefined, "Timezone is required."],
      ["  ", "Timezone is required."],
      ["Not/AZone", "Invalid timezone: Not/AZone"],
    ] as const;

    for (const [value, message] of cases) {
      try {
        await saveUserTimezone(value);
        throw new Error("expected a rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(AtlasApiError);
        expect((error as AtlasApiError).message).toBe(message);
        expect((error as AtlasApiError).status).toBe(400);
      }
    }
  });
});

describe("ensureUserConfigDir", () => {
  let configDir = "";

  afterEach(async () => {
    if (configDir) {
      await rm(configDir, { force: true, recursive: true });
      configDir = "";
    }

    delete process.env.ATLAS_CONFIG_DIR;
  });

  test("creates the config directory when missing", async () => {
    configDir = join(tmpdir(), `atlas-config-${Date.now()}`);
    process.env.ATLAS_CONFIG_DIR = configDir;

    expect(await pathExists(configDir)).toBe(false);
    await expect(ensureUserConfigDir()).resolves.toBe(configDir);
    expect(await pathExists(configDir)).toBe(true);
  });

  test("async store overrides ATLAS_CONFIG_DIR for the current call", async () => {
    const envDir = join(tmpdir(), `atlas-config-env-${Date.now()}`);
    const storeDir = join(tmpdir(), `atlas-config-store-${Date.now()}`);
    process.env.ATLAS_CONFIG_DIR = envDir;

    expect(getUserConfigDir()).toBe(envDir);
    expect(runWithUserConfigDir(storeDir, () => getUserConfigDir())).toBe(
      storeDir
    );
    expect(getUserConfigDir()).toBe(envDir);
  });
});

describe("user config multi-provider", () => {
  let configDir = "";

  afterEach(async () => {
    if (configDir) {
      await rm(configDir, { force: true, recursive: true });
      configDir = "";
    }

    delete process.env.ATLAS_CONFIG_DIR;
  });

  test("round-trips multiple provider instances", async () => {
    configDir = await mkdtemp(join(tmpdir(), "atlas-config-"));
    process.env.ATLAS_CONFIG_DIR = configDir;

    const openaiId = createProviderInstanceId();
    const compatibleId = createProviderInstanceId();

    await saveUserConfig({
      defaultProviderId: openaiId,
      providers: [
        {
          apiKey: "sk-test",
          createdAt: "2026-06-07T10:00:00.000Z",
          id: openaiId,
          label: "Work OpenAI",
          type: "openai",
        },
        {
          apiKey: "",
          baseUrl: "http://localhost:11434/v1",
          createdAt: "2026-06-07T11:00:00.000Z",
          customModels: [
            {
              default: true,
              id: "llama3.2",
              name: "Llama 3.2",
              supportsThinking: true,
            },
          ],
          id: compatibleId,
          label: "Ollama",
          type: "openai_compatible",
          wireApi: "responses",
        },
      ],
      thinkingEffort: "medium",
      thinkingEnabled: true,
      timezone: "UTC",
    });

    const raw = await readFile(getUserConfigPath(), "utf8");
    expect(raw).toContain(`[provider.${openaiId}]`);
    expect(raw).toContain("label=Ollama");
    expect(raw).toContain("default_provider_id=");

    const loaded = await loadUserConfig();
    expect(loaded?.providers).toHaveLength(2);
    expect(loaded?.defaultProviderId).toBe(openaiId);
    expect(loaded?.providers[1]?.baseUrl).toBe("http://localhost:11434/v1");
    expect(loaded?.providers[1]?.customModels?.[0]?.id).toBe("llama3.2");
    expect(loaded?.providers[1]?.customModels?.[0]?.supportsThinking).toBe(
      true
    );
    expect(loaded?.providers[1]?.wireApi).toBe("responses");
  });

  test("persists custom models for every provider that opts in via setup metadata", async () => {
    configDir = await mkdtemp(join(tmpdir(), "atlas-config-"));
    process.env.ATLAS_CONFIG_DIR = configDir;
    const definitions = BUILTIN_PROVIDER_DEFINITIONS.filter(
      (definition) => definition.setup?.customModels === true
    );
    const providers = definitions.map((definition, index) => ({
      apiKey: `key-${definition.id}`,
      createdAt: new Date(index).toISOString(),
      customModels: [
        { default: true, id: `model-${definition.id}`, name: "Custom model" },
      ],
      id: `provider-${definition.id}`,
      label: definition.displayName,
      type: definition.id,
    }));

    await saveUserConfig({
      defaultProviderId: providers[0]?.id ?? null,
      providers,
    });

    const loaded = await loadUserConfig();
    expect(loaded?.providers).toHaveLength(definitions.length);
    for (const provider of loaded?.providers ?? []) {
      expect(provider.customModels).toEqual([
        {
          default: true,
          id: `model-${provider.type}`,
          name: "Custom model",
        },
      ]);
    }
  });

  test("round-trips capability mappings and provider overrides", async () => {
    configDir = await mkdtemp(join(tmpdir(), "atlas-config-"));
    process.env.ATLAS_CONFIG_DIR = configDir;
    const providerId = createProviderInstanceId();

    await saveUserConfig({
      capabilityConfig: {
        bindings: {
          "audio.transcription": {
            contractVersion: 1,
            enabled: true,
            fallbacks: [],
            mode: "manual",
            primary: { modelId: "custom-asr", providerId },
          },
        },
        schemaVersion: 1,
      },
      defaultProviderId: providerId,
      providers: [
        {
          apiKey: "test-key",
          capabilityOverrides: {
            "audio.transcription": {
              source: "admin-override",
              status: "supported",
              verified: false,
            },
          },
          createdAt: "2026-08-27T00:00:00.000Z",
          id: providerId,
          label: "Custom ASR",
          type: "openai",
        },
      ],
    });

    const loaded = await loadUserConfig();
    expect(
      loaded?.capabilityConfig?.bindings["audio.transcription"]?.primary
    ).toEqual({ modelId: "custom-asr", providerId });
    expect(
      loaded?.providers[0]?.capabilityOverrides?.["audio.transcription"]
    ).toEqual({
      source: "admin-override",
      status: "supported",
      verified: false,
    });
  });

  test("rejects a future capability config version on load", async () => {
    configDir = await mkdtemp(join(tmpdir(), "atlas-config-"));
    process.env.ATLAS_CONFIG_DIR = configDir;
    await writeFile(
      getUserConfigPath(),
      'capability_config={"schemaVersion":2,"bindings":{}}\n',
      "utf8"
    );

    await expect(loadUserConfig()).rejects.toThrow(
      "capability config schema version 2 is not supported."
    );
  });

  test("round-trips cerebras models_json with capability flags", async () => {
    configDir = await mkdtemp(join(tmpdir(), "atlas-config-"));
    process.env.ATLAS_CONFIG_DIR = configDir;

    const cerebrasId = createProviderInstanceId();

    await saveUserConfig({
      defaultProviderId: cerebrasId,
      providers: [
        {
          apiKey: "csk-test",
          createdAt: "2026-07-16T10:00:00.000Z",
          customModels: [
            {
              default: true,
              id: "gpt-oss-120b",
              inputPerMillionUsd: 0.25,
              name: "GPT OSS 120B",
              outputPerMillionUsd: 0.69,
              supportsThinking: true,
              supportsVision: false,
            },
          ],
          id: cerebrasId,
          label: "Cerebras",
          type: "cerebras",
        },
      ],
    });

    const loaded = await loadUserConfig();
    expect(loaded?.providers[0]?.type).toBe("cerebras");
    expect(loaded?.providers[0]?.customModels?.[0]?.id).toBe("gpt-oss-120b");
    expect(loaded?.providers[0]?.customModels?.[0]?.supportsThinking).toBe(
      true
    );
    expect(loaded?.providers[0]?.customModels?.[0]?.inputPerMillionUsd).toBe(
      0.25
    );
  });

  test("round-trips server-owned subscription model snapshots", async () => {
    configDir = await mkdtemp(join(tmpdir(), "atlas-config-"));
    process.env.ATLAS_CONFIG_DIR = configDir;

    const providerId = createProviderInstanceId();
    await saveUserConfig({
      defaultProviderId: providerId,
      providers: [
        {
          apiKey: "",
          createdAt: "2026-08-27T00:00:00.000Z",
          customModels: [
            {
              default: true,
              id: "gpt-runtime-only",
              name: "GPT Runtime Only",
            },
          ],
          id: providerId,
          label: "ChatGPT",
          type: "chatgpt",
        },
      ],
    });

    const loaded = await loadUserConfig();
    expect(loaded?.providers[0]?.customModels).toEqual([
      {
        default: true,
        id: "gpt-runtime-only",
        name: "GPT Runtime Only",
      },
    ]);
  });

  test("round-trips fireworks models_json with capability flags", async () => {
    configDir = await mkdtemp(join(tmpdir(), "atlas-config-"));
    process.env.ATLAS_CONFIG_DIR = configDir;

    const fireworksId = createProviderInstanceId();

    await saveUserConfig({
      defaultProviderId: fireworksId,
      providers: [
        {
          apiKey: "fw-test",
          createdAt: "2026-07-24T10:00:00.000Z",
          customModels: [
            {
              default: true,
              id: "accounts/fireworks/models/kimi-k2p6",
              inputPerMillionUsd: 0.6,
              name: "Kimi K2.6",
              outputPerMillionUsd: 2.5,
              supportsThinking: true,
              supportsVision: false,
            },
          ],
          id: fireworksId,
          label: "Fireworks",
          type: "fireworks",
        },
      ],
    });

    const loaded = await loadUserConfig();
    expect(loaded?.providers[0]?.type).toBe("fireworks");
    expect(loaded?.providers[0]?.customModels?.[0]?.id).toBe(
      "accounts/fireworks/models/kimi-k2p6"
    );
    expect(loaded?.providers[0]?.customModels?.[0]?.supportsThinking).toBe(
      true
    );
    expect(loaded?.providers[0]?.customModels?.[0]?.inputPerMillionUsd).toBe(
      0.6
    );
  });

  test("repairs literal undefined label on load", async () => {
    configDir = await mkdtemp(join(tmpdir(), "atlas-config-"));
    process.env.ATLAS_CONFIG_DIR = configDir;

    const id = createProviderInstanceId();

    await writeFile(
      getUserConfigPath(),
      `[provider.${id}]
type=opencode_go
label=undefined
api_key=test-key
created_at=2026-06-15T00:00:00.000Z
`,
      "utf8"
    );

    const loaded = await loadUserConfig();
    expect(loaded?.providers[0]?.label).toBe("OpenCode Go");
  });

  test("normalizeProviderInstanceLabel rejects undefined string", () => {
    expect(normalizeProviderInstanceLabel("openrouter", "undefined", [])).toBe(
      "OpenRouter"
    );
  });

  test("saveUserWebPublicUrl preserves path segments", async () => {
    configDir = await mkdtemp(join(tmpdir(), "atlas-config-"));
    process.env.ATLAS_CONFIG_DIR = configDir;

    await expect(
      saveUserWebPublicUrl("https://gateway.devscale.id/v1/")
    ).resolves.toBe("https://gateway.devscale.id/v1");
    await expect(loadUserWebPublicUrl()).resolves.toBe(
      "https://gateway.devscale.id/v1"
    );
  });
});

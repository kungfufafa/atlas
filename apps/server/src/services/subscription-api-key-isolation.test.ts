import { describe, expect, test } from "bun:test";
import {
  AtlasApiError,
  type CapabilityConfigV1,
  type CapabilityTarget,
  PROVIDER_CAPABILITY_CONFIG_SCHEMA_VERSION,
  PROVIDER_CAPABILITY_CONTRACT_VERSION,
  PROVIDER_CAPABILITY_IDS,
  type ProviderInstance,
  type UserConfig,
} from "@atlas/core";
import { builtinProviderAdapterRegistry } from "../providers/capabilities/builtin-adapters";
import { ProviderCapabilityError } from "../providers/capabilities/errors";
import { resolveConfiguredCapability } from "../providers/capabilities/runtime";
import { readApiKeyForInstance } from "../providers/create";
import { resolveCodingAgentProviderRouting } from "./coding-agent-provider-routing";
import { buildSpawnEnvForHarness } from "./coding-agent-spawn-env";
import { resolveProfileProviderSelection } from "./provider-instance-helpers";

const OPENAI_KEY = "sk-openai-isolation-test";
const ANTHROPIC_KEY = "sk-ant-isolation-test";
const SUBSCRIPTION_CHAT_MODEL = "gpt-5.4-codex";
const SUBSCRIPTION_IMAGE_MODEL = "gpt-image-2-subscription";
const CLAUDE_CHAT_MODEL = "claude-sonnet-4-6";

function makeInstance(
  overrides: Pick<ProviderInstance, "id" | "label" | "type"> &
    Partial<ProviderInstance>
): ProviderInstance {
  return {
    apiKey: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

const chatgptInstance = makeInstance({
  customModels: [
    { default: true, id: SUBSCRIPTION_CHAT_MODEL },
    {
      capabilities: {
        [PROVIDER_CAPABILITY_IDS.imageGeneration]: {
          source: "provider-discovery",
          status: "supported",
          verified: true,
        },
      },
      id: SUBSCRIPTION_IMAGE_MODEL,
    },
  ],
  id: "prov-chatgpt",
  label: "ChatGPT",
  type: "chatgpt",
});

const claudeInstance = makeInstance({
  customModels: [{ default: true, id: CLAUDE_CHAT_MODEL }],
  id: "prov-claude",
  label: "Claude",
  type: "claude",
});

const openaiInstance = makeInstance({
  apiKey: OPENAI_KEY,
  id: "prov-openai",
  label: "OpenAI",
  type: "openai",
});

const anthropicInstance = makeInstance({
  apiKey: ANTHROPIC_KEY,
  // Explicit fixture configuration; transport support is not model evidence.
  customModels: [{ id: CLAUDE_CHAT_MODEL, supportsVision: true }],
  id: "prov-anthropic",
  label: "Anthropic",
  type: "anthropic",
});

function binding(
  primary: CapabilityTarget,
  fallbacks: CapabilityTarget[] = []
) {
  return {
    contractVersion: PROVIDER_CAPABILITY_CONTRACT_VERSION,
    enabled: true,
    fallbacks,
    mode: "manual" as const,
    primary,
  };
}

function makeConfig(options: {
  providers: ProviderInstance[];
  defaultProviderId?: string | null;
  bindings?: CapabilityConfigV1["bindings"];
}): UserConfig {
  return {
    ...(options.bindings
      ? {
          capabilityConfig: {
            bindings: options.bindings,
            schemaVersion: PROVIDER_CAPABILITY_CONFIG_SCHEMA_VERSION,
          },
        }
      : {}),
    defaultProviderId: options.defaultProviderId ?? null,
    providers: options.providers,
  };
}

function resolveCapability(
  capabilityId: string,
  config: UserConfig,
  env: Record<string, string | undefined> = {}
) {
  return resolveConfiguredCapability({
    capabilityId,
    config,
    readApiKey: (instance) => readApiKeyForInstance(instance, env),
    registry: builtinProviderAdapterRegistry,
  });
}

describe("credential source isolation", () => {
  test("subscription instances never read API-key env vars", () => {
    const env = {
      ANTHROPIC_API_KEY: "sk-ant-from-env",
      OPENAI_API_KEY: "sk-openai-from-env",
    };
    expect(readApiKeyForInstance(chatgptInstance, env)).toBeUndefined();
    expect(readApiKeyForInstance(claudeInstance, env)).toBeUndefined();
  });

  test("API-key instances still read their env vars alongside subscriptions", () => {
    const env = { OPENAI_API_KEY: "sk-openai-from-env" };
    const keylessOpenai = makeInstance({
      id: "prov-openai-env",
      label: "OpenAI",
      type: "openai",
    });
    expect(readApiKeyForInstance(keylessOpenai, env)).toBe(
      "sk-openai-from-env"
    );
    expect(readApiKeyForInstance(openaiInstance, env)).toBe(OPENAI_KEY);
  });
});

describe("chat selection with mixed credentials", () => {
  test("an explicit ChatGPT subscription selection is not hijacked by an OpenAI API key", () => {
    const resolved = resolveProfileProviderSelection({
      defaultProviderId: openaiInstance.id,
      profileModel: `${chatgptInstance.id}::${SUBSCRIPTION_CHAT_MODEL}`,
      providers: [openaiInstance, chatgptInstance],
    });
    expect(resolved?.instance.id).toBe(chatgptInstance.id);
    expect(resolved?.model).toBe(SUBSCRIPTION_CHAT_MODEL);
  });

  test("an explicit Claude subscription selection is not hijacked by an Anthropic API key", () => {
    const resolved = resolveProfileProviderSelection({
      defaultProviderId: anthropicInstance.id,
      profileModel: `${claudeInstance.id}::${CLAUDE_CHAT_MODEL}`,
      providers: [anthropicInstance, claudeInstance],
    });
    expect(resolved?.instance.id).toBe(claudeInstance.id);
    expect(resolved?.model).toBe(CLAUDE_CHAT_MODEL);
  });

  test("an explicit API-key selection is not hijacked by a connected subscription", () => {
    const resolved = resolveProfileProviderSelection({
      defaultProviderId: chatgptInstance.id,
      profileModel: `${openaiInstance.id}::gpt-5.4`,
      providers: [chatgptInstance, openaiInstance],
    });
    expect(resolved?.instance.id).toBe(openaiInstance.id);
  });

  test("a stale subscription model selection fails explicitly instead of rerouting", () => {
    expect(() =>
      resolveProfileProviderSelection({
        defaultProviderId: chatgptInstance.id,
        profileModel: `${chatgptInstance.id}::model-that-left-the-plan`,
        providers: [chatgptInstance, openaiInstance],
      })
    ).toThrow(AtlasApiError);
  });
});

describe("capability routing with mixed credentials", () => {
  const mixedBindings: CapabilityConfigV1["bindings"] = {
    [PROVIDER_CAPABILITY_IDS.audioTranscription]: binding({
      modelId: "whisper-1",
      providerId: openaiInstance.id,
    }),
    [PROVIDER_CAPABILITY_IDS.imageGeneration]: binding({
      modelId: "gpt-image-2",
      providerId: openaiInstance.id,
    }),
    [PROVIDER_CAPABILITY_IDS.imageUnderstanding]: binding({
      modelId: "gpt-5.4",
      providerId: openaiInstance.id,
    }),
  };

  test.each([
    [PROVIDER_CAPABILITY_IDS.imageGeneration],
    [PROVIDER_CAPABILITY_IDS.audioTranscription],
    [PROVIDER_CAPABILITY_IDS.imageUnderstanding],
  ])(
    "%s keeps using the OpenAI API key while chat runs on the ChatGPT subscription",
    (capabilityId) => {
      const config = makeConfig({
        bindings: mixedBindings,
        defaultProviderId: chatgptInstance.id,
        providers: [chatgptInstance, openaiInstance],
      });
      const selection = resolveCapability(capabilityId, config);
      expect(selection.instance.id).toBe(openaiInstance.id);
      expect(selection.apiKey).toBe(OPENAI_KEY);
    }
  );

  test("Anthropic API vision coexists with ChatGPT subscription chat", () => {
    const config = makeConfig({
      bindings: {
        [PROVIDER_CAPABILITY_IDS.imageUnderstanding]: binding({
          modelId: CLAUDE_CHAT_MODEL,
          providerId: anthropicInstance.id,
        }),
      },
      defaultProviderId: chatgptInstance.id,
      providers: [chatgptInstance, anthropicInstance],
    });
    const selection = resolveCapability(
      PROVIDER_CAPABILITY_IDS.imageUnderstanding,
      config
    );
    expect(selection.instance.id).toBe(anthropicInstance.id);
    expect(selection.model).toBe(CLAUDE_CHAT_MODEL);
    expect(selection.apiKey).toBe(ANTHROPIC_KEY);
  });

  test.each([
    {
      code: "CAPABILITY_UNKNOWN",
      customModels: undefined,
      reason: "model-unknown",
      scenario: "missing model metadata",
    },
    {
      code: "CAPABILITY_UNKNOWN",
      customModels: [{ id: CLAUDE_CHAT_MODEL }],
      reason: "model-unknown",
      scenario: "id-only model metadata",
    },
    {
      code: "CAPABILITY_UNSUPPORTED",
      customModels: [{ id: CLAUDE_CHAT_MODEL, supportsVision: false }],
      reason: "model-unsupported",
      scenario: "explicitly disabled vision",
    },
  ])(
    "rejects Anthropic vision with $scenario on the selected instance",
    ({ code, customModels, reason }) => {
      const selectedInstance = {
        ...anthropicInstance,
        customModels,
        id: "prov-anthropic-unverified",
      };
      const config = makeConfig({
        bindings: {
          [PROVIDER_CAPABILITY_IDS.imageUnderstanding]: binding({
            modelId: CLAUDE_CHAT_MODEL,
            providerId: selectedInstance.id,
          }),
        },
        defaultProviderId: chatgptInstance.id,
        providers: [chatgptInstance, anthropicInstance, selectedInstance],
      });

      try {
        resolveCapability(PROVIDER_CAPABILITY_IDS.imageUnderstanding, config);
        throw new Error("expected image understanding resolution to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderCapabilityError);
        expect(error).toMatchObject({
          attempts: [
            {
              modelId: CLAUDE_CHAT_MODEL,
              providerId: selectedInstance.id,
              reasons: [reason],
            },
          ],
          code,
        });
      }
    }
  );

  test("subscription image generation resolves without any API key", () => {
    const config = makeConfig({
      bindings: {
        [PROVIDER_CAPABILITY_IDS.imageGeneration]: binding({
          modelId: SUBSCRIPTION_IMAGE_MODEL,
          providerId: chatgptInstance.id,
        }),
      },
      defaultProviderId: chatgptInstance.id,
      providers: [chatgptInstance, openaiInstance],
    });
    const selection = resolveCapability(
      PROVIDER_CAPABILITY_IDS.imageGeneration,
      config,
      { OPENAI_API_KEY: "sk-openai-from-env" }
    );
    expect(selection.instance.id).toBe(chatgptInstance.id);
    expect(selection.apiKey).toBe("");
  });

  test("capability fallback only moves along explicitly configured targets", () => {
    const config = makeConfig({
      bindings: {
        [PROVIDER_CAPABILITY_IDS.imageGeneration]: binding(
          {
            modelId: "model-without-image-claims",
            providerId: chatgptInstance.id,
          },
          [{ modelId: "gpt-image-2", providerId: openaiInstance.id }]
        ),
      },
      defaultProviderId: chatgptInstance.id,
      providers: [chatgptInstance, openaiInstance],
    });
    const selection = resolveCapability(
      PROVIDER_CAPABILITY_IDS.imageGeneration,
      config
    );
    expect(selection.instance.id).toBe(openaiInstance.id);
    expect(selection.apiKey).toBe(OPENAI_KEY);
    expect(selection.fallbackIndex).toBe(1);
  });

  test("a subscription-only workspace degrades transcription explicitly", () => {
    const config = makeConfig({
      bindings: {
        [PROVIDER_CAPABILITY_IDS.audioTranscription]: binding({
          modelId: SUBSCRIPTION_CHAT_MODEL,
          providerId: chatgptInstance.id,
        }),
      },
      defaultProviderId: chatgptInstance.id,
      providers: [chatgptInstance],
    });
    expect(() =>
      resolveCapability(PROVIDER_CAPABILITY_IDS.audioTranscription, config)
    ).toThrow(ProviderCapabilityError);
  });

  test("a Claude-only workspace degrades vision and image generation explicitly", () => {
    const config = makeConfig({
      bindings: {
        [PROVIDER_CAPABILITY_IDS.imageGeneration]: binding({
          modelId: CLAUDE_CHAT_MODEL,
          providerId: claudeInstance.id,
        }),
        [PROVIDER_CAPABILITY_IDS.imageUnderstanding]: binding({
          modelId: CLAUDE_CHAT_MODEL,
          providerId: claudeInstance.id,
        }),
      },
      defaultProviderId: claudeInstance.id,
      providers: [claudeInstance],
    });
    expect(() =>
      resolveCapability(PROVIDER_CAPABILITY_IDS.imageUnderstanding, config)
    ).toThrow(ProviderCapabilityError);
    expect(() =>
      resolveCapability(PROVIDER_CAPABILITY_IDS.imageGeneration, config)
    ).toThrow(ProviderCapabilityError);
  });
});

describe("coding-agent spawn credentials with mixed credentials", () => {
  test("Claude subscription chat never leaks the Anthropic API key into Claude Code", async () => {
    const routing = resolveCodingAgentProviderRouting({
      env: {},
      harnessKind: "claude_code",
      profileModel: `${claudeInstance.id}::${CLAUDE_CHAT_MODEL}`,
      userConfig: makeConfig({
        defaultProviderId: claudeInstance.id,
        providers: [claudeInstance, anthropicInstance],
      }),
    });
    expect(routing.active).toBe(false);
    expect(routing.apiKey).toBeNull();

    const spawn = await buildSpawnEnvForHarness(
      "claude_code",
      routing,
      routing.providerType ?? "anthropic"
    );
    expect(spawn.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(Object.keys(spawn.env)).toHaveLength(0);
  });

  test("ChatGPT subscription chat never leaks the OpenAI API key into Codex", async () => {
    const routing = resolveCodingAgentProviderRouting({
      env: {},
      harnessKind: "codex",
      profileModel: `${chatgptInstance.id}::${SUBSCRIPTION_CHAT_MODEL}`,
      userConfig: makeConfig({
        defaultProviderId: chatgptInstance.id,
        providers: [chatgptInstance, openaiInstance],
      }),
    });
    expect(routing.active).toBe(false);
    expect(routing.apiKey).toBeNull();

    const spawn = await buildSpawnEnvForHarness(
      "codex",
      routing,
      routing.providerType ?? "openai"
    );
    expect(spawn.env.OPENAI_API_KEY).toBeUndefined();
    expect(Object.keys(spawn.env)).toHaveLength(0);
  });

  test("an Anthropic API selection still activates Claude Code passthrough", async () => {
    const routing = resolveCodingAgentProviderRouting({
      env: {},
      harnessKind: "claude_code",
      profileModel: `${anthropicInstance.id}::${CLAUDE_CHAT_MODEL}`,
      userConfig: makeConfig({
        defaultProviderId: anthropicInstance.id,
        providers: [anthropicInstance, claudeInstance],
      }),
    });
    expect(routing.active).toBe(true);
    expect(routing.apiKey).toBe(ANTHROPIC_KEY);

    const spawn = await buildSpawnEnvForHarness(
      "claude_code",
      routing,
      routing.providerType ?? "anthropic"
    );
    expect(spawn.env.ANTHROPIC_API_KEY).toBe(ANTHROPIC_KEY);
  });
});

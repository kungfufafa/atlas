import { resolveCloudflareAccountInput } from "./cloudflare-provider-config";
import {
  isValidBaseUrl,
  normalizeBaseUrl,
  validateCustomModels,
  validateDisplayName,
} from "./compatible-provider-config";
import type { ProviderModelOption, WireApi } from "./contract";
import {
  defaultDiscoveryBaseUrl,
  isDiscoveryModelProvider,
} from "./discovery-providers";
import {
  defaultOllamaBaseUrl,
  defaultOllamaLabel,
  type OllamaHostMode,
  ollamaRequiresApiKey,
} from "./ollama-provider-config";
import {
  BUILTIN_PROVIDER_DEFINITIONS,
  type BuiltinProviderDefinition,
  getBuiltinProviderDefinition,
  providerApiKeyIsRequired,
  validateProviderCustomModelId,
} from "./provider-catalog";
import {
  createProviderInstanceId,
  defaultProviderLabel,
  type ProviderInstance,
  parseProviderName,
  type UserConfig,
  type UserProviderName,
} from "./user-config";

export interface ProviderSetupPromptOptions {
  getDefaultModel: (provider: UserProviderName) => string;
  getModelById: (modelId: string) => ProviderModelOption | undefined;
  getModelsForProvider: (provider: UserProviderName) => ProviderModelOption[];
  question: (prompt: string) => Promise<string>;
  writeLine: (line: string) => void;
}

const PROVIDER_CHOICES: Array<{ id: UserProviderName; label: string }> =
  BUILTIN_PROVIDER_DEFINITIONS.map((definition) => ({
    id: definition.id,
    label: definition.displayName,
  }));

export async function promptForProviderConfig(
  options: ProviderSetupPromptOptions
): Promise<UserConfig> {
  const {
    question,
    writeLine,
    getModelsForProvider,
    getDefaultModel,
    getModelById,
  } = options;

  while (true) {
    writeLine("\nChoose a provider:");
    for (const [index, choice] of PROVIDER_CHOICES.entries()) {
      writeLine(`  ${index + 1}) ${choice.label}`);
    }

    const providerInput = (await question("\nProvider: ")).trim();
    const provider = resolveProviderChoice(providerInput);

    if (!provider) {
      writeLine("Enter a provider number or name.\n");
      continue;
    }

    const definition = getBuiltinProviderDefinition(provider);
    if (!definition) {
      writeLine("Provider metadata is unavailable.\n");
      continue;
    }

    if (definition.setup?.displayName) {
      const instance = await promptForEndpointProviderInstance(
        provider,
        definition,
        question,
        writeLine
      );
      return buildUserConfigFromInstance(instance);
    }

    if (definition.setup?.hostMode === "ollama") {
      const instance = await promptForOllamaProviderInstance(
        provider,
        question,
        writeLine
      );
      return buildUserConfigFromInstance(instance);
    }

    if (definition.setup?.subscriptionAuth) {
      writeLine(
        `\n${definition.displayName} uses a subscription runtime, not an API key.`
      );
      writeLine(
        provider === "chatgpt"
          ? "Codex is bundled with Atlas. Atlas will start device sign-in next."
          : "Claude is bundled with Atlas. Atlas will show the host login command next."
      );
      await question("Start sign-in: ");
      const instance: ProviderInstance = {
        apiKey: "",
        createdAt: new Date().toISOString(),
        id: createProviderInstanceId(),
        label: defaultProviderLabel(provider, []),
        type: provider,
      };
      return buildUserConfigFromInstance(instance);
    }

    const apiKeyRequired = providerApiKeyIsRequired(definition.apiKey);
    const apiKey = (
      await question(apiKeyRequired ? "API key: " : "API key (optional): ")
    ).trim();

    if (apiKeyRequired && !apiKey) {
      writeLine("API key is required.\n");
      continue;
    }

    if (definition.discoveryModels && isDiscoveryModelProvider(provider)) {
      const instance = await promptForDiscoveryProviderInstance(
        provider,
        apiKey,
        question,
        writeLine
      );
      if (instance) {
        return buildUserConfigFromInstance(instance);
      }
      continue;
    }

    const configuredBaseUrl =
      definition.setup?.baseUrlInput === "cloudflare-account"
        ? resolveCloudflareAccountInput(
            await question("Cloudflare account ID or Workers AI URL: ")
          )
        : null;
    if (
      definition.setup?.baseUrlInput === "cloudflare-account" &&
      !configuredBaseUrl
    ) {
      writeLine("Enter a valid Cloudflare account ID or Workers AI URL.\n");
      continue;
    }

    const models = getModelsForProvider(provider);
    writeLine(`\nSelected provider: ${provider}`);
    writeLine("\nAvailable models:");

    for (const [index, model] of models.entries()) {
      const suffix = model.default ? " (default)" : "";
      writeLine(`  ${index + 1}) ${model.name}${suffix}`);
    }

    const modelInput = (await question("\nModel (optional): ")).trim();
    const selectedModel = resolveModelChoice(modelInput, provider, {
      getDefaultModel,
      getModelById,
      getModelsForProvider,
    });

    const catalogModel = getModelById(selectedModel);
    const modelIdError = validateProviderCustomModelId(provider, selectedModel);
    if (modelIdError) {
      writeLine(`${modelIdError}\n`);
      continue;
    }
    const customModels =
      definition.setup?.customModels &&
      (!catalogModel || definition.setup.catalogSelectionAsCustomModel)
        ? [
            {
              default: true,
              id: selectedModel,
              ...(catalogModel?.supportsThinking === undefined
                ? {}
                : { supportsThinking: catalogModel.supportsThinking }),
              ...(catalogModel?.supportsVision === undefined
                ? {}
                : { supportsVision: catalogModel.supportsVision }),
              ...(catalogModel?.inputPerMillionUsd === undefined
                ? {}
                : { inputPerMillionUsd: catalogModel.inputPerMillionUsd }),
              ...(catalogModel?.outputPerMillionUsd === undefined
                ? {}
                : { outputPerMillionUsd: catalogModel.outputPerMillionUsd }),
            },
          ]
        : undefined;

    const instance: ProviderInstance = {
      apiKey,
      createdAt: new Date().toISOString(),
      id: createProviderInstanceId(),
      label: defaultProviderLabel(provider, []),
      type: getModelById(selectedModel)?.provider ?? provider,
      ...(configuredBaseUrl ? { baseUrl: configuredBaseUrl } : {}),
      ...(customModels ? { customModels } : {}),
    };

    return buildUserConfigFromInstance(instance);
  }
}

function buildUserConfigFromInstance(instance: ProviderInstance): UserConfig {
  return {
    defaultProviderId: instance.id,
    providers: [instance],
  };
}

function resolveProviderChoice(input: string): UserProviderName | null {
  const normalized = input.trim().toLowerCase();
  const namedProvider = parseProviderName(normalized);
  if (namedProvider) {
    return namedProvider;
  }

  const numeric = Number(input);

  if (
    Number.isInteger(numeric) &&
    numeric >= 1 &&
    numeric <= PROVIDER_CHOICES.length
  ) {
    return PROVIDER_CHOICES[numeric - 1]!.id;
  }

  return null;
}

function resolveModelChoice(
  input: string,
  provider: UserProviderName,
  options: Pick<
    ProviderSetupPromptOptions,
    "getDefaultModel" | "getModelById" | "getModelsForProvider"
  >
): string {
  if (!input) {
    return options.getDefaultModel(provider);
  }

  const match = options.getModelById(input);

  if (match && match.provider === provider) {
    return match.id;
  }

  const numeric = Number(input);
  const models = options.getModelsForProvider(provider);

  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= models.length) {
    return models[numeric - 1]!.id;
  }

  const definition = getBuiltinProviderDefinition(provider);
  if (
    definition?.setup?.customModels ||
    definition?.modelIdPolicy === "passthrough" ||
    definition?.modelIdPolicy === "provider-qualified"
  ) {
    return input;
  }

  return options.getDefaultModel(provider);
}

async function promptForOllamaProviderInstance(
  provider: UserProviderName,
  question: (prompt: string) => Promise<string>,
  writeLine: (line: string) => void
): Promise<ProviderInstance> {
  while (true) {
    writeLine("\nOllama host: 1) Local  2) Cloud");
    const hostInput = (await question("Host [1]: ")).trim().toLowerCase();
    const hostMode: OllamaHostMode =
      hostInput === "2" || hostInput === "cloud" ? "cloud" : "local";
    const defaultBaseUrl = defaultOllamaBaseUrl(hostMode);
    const baseUrl = normalizeBaseUrl(
      (await question(`Base URL (${defaultBaseUrl}): `)).trim() ||
        defaultBaseUrl
    );

    if (!isValidBaseUrl(baseUrl)) {
      writeLine("Enter a valid http(s) base URL.\n");
      continue;
    }

    const apiKey = (
      await question(
        ollamaRequiresApiKey(hostMode) ? "API key: " : "API key (optional): "
      )
    ).trim();

    if (ollamaRequiresApiKey(hostMode) && !apiKey) {
      writeLine("API key is required for Ollama Cloud.\n");
      continue;
    }

    const modelIds = (await question("Model IDs (comma-separated): "))
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    if (modelIds.length === 0) {
      writeLine("Enter at least one model id.\n");
      continue;
    }

    return {
      apiKey,
      baseUrl,
      createdAt: new Date().toISOString(),
      customModels: validateCustomModels(
        modelIds.map((id, index) => ({
          id,
          ...(index === 0 ? { default: true } : {}),
        }))
      ),
      hostMode,
      id: createProviderInstanceId(),
      label: defaultOllamaLabel(hostMode),
      type: provider,
    };
  }
}

async function promptForEndpointProviderInstance(
  provider: UserProviderName,
  definition: BuiltinProviderDefinition,
  question: (prompt: string) => Promise<string>,
  writeLine: (line: string) => void
): Promise<ProviderInstance> {
  while (true) {
    const displayName = definition.setup?.displayName
      ? validateDisplayName(await question("Provider name: "))
      : definition.displayName;
    const baseUrlInput = (await question("Base URL: ")).trim();

    if (!isValidBaseUrl(baseUrlInput)) {
      writeLine("Enter a valid http(s) base URL.\n");
      continue;
    }

    const baseUrl = normalizeBaseUrl(baseUrlInput);
    const apiKeyRequired = providerApiKeyIsRequired(definition.apiKey);
    const apiKey = (
      await question(apiKeyRequired ? "API key: " : "API key (optional): ")
    ).trim();
    if (apiKeyRequired && !apiKey) {
      writeLine("API key is required.\n");
      continue;
    }

    const wireInput = definition.setup?.wireApi
      ? (await question("API [chat/responses] (chat): ")).trim().toLowerCase()
      : "chat";
    const wireApi: WireApi = wireInput === "responses" ? "responses" : "chat";
    const modelIds = (await question("Model IDs (comma-separated): "))
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);

    if (modelIds.length === 0) {
      writeLine("Enter at least one model id.\n");
      continue;
    }

    const customModels = validateCustomModels(
      modelIds.map((id, index) => ({
        id,
        ...(index === 0 ? { default: true } : {}),
      }))
    );

    return {
      apiKey,
      baseUrl,
      createdAt: new Date().toISOString(),
      customModels,
      id: createProviderInstanceId(),
      label: displayName,
      type: provider,
      ...(definition.setup?.wireApi ? { wireApi } : {}),
    };
  }
}

async function promptForDiscoveryProviderInstance(
  provider: UserProviderName,
  apiKey: string,
  question: (prompt: string) => Promise<string>,
  writeLine: (line: string) => void
): Promise<ProviderInstance | null> {
  const defaultBaseUrl = defaultDiscoveryBaseUrl(provider);
  if (!defaultBaseUrl) {
    return null;
  }

  const baseUrlInput = (
    await question(`Base URL (${defaultBaseUrl}): `)
  ).trim();
  const baseUrl = normalizeBaseUrl(baseUrlInput || defaultBaseUrl);
  if (!isValidBaseUrl(baseUrl)) {
    writeLine("Enter a valid http(s) base URL.\n");
    return null;
  }

  const modelIds = (await question("Model IDs (comma-separated): "))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (modelIds.length === 0) {
    writeLine("Enter at least one model id.\n");
    return null;
  }

  return {
    apiKey,
    baseUrl,
    createdAt: new Date().toISOString(),
    customModels: validateCustomModels(
      modelIds.map((id, index) => ({
        id,
        ...(index === 0 ? { default: true } : {}),
      }))
    ),
    id: createProviderInstanceId(),
    label: defaultProviderLabel(provider, []),
    type: provider,
  };
}

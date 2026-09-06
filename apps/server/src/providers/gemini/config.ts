import type {
  CustomModelEntry,
  GenerateChatInput,
  LlmToolDefinition,
  ProviderChatOptions,
} from "@atlas/core";
import {
  type GenerateContentConfig,
  ThinkingLevel,
  type Tool,
} from "@google/genai";
import {
  modelSupportsReasoning,
  resolveModelThinkingEffort,
} from "../reasoning-metadata";

export function buildGeminiGenerateConfig(options: {
  system: string;
  tools?: LlmToolDefinition[];
  providerOptions?: ProviderChatOptions;
  model: string;
  customModels?: CustomModelEntry[];
  responseMimeType?: string;
}): GenerateContentConfig {
  const tools = buildGeminiTools(
    options.tools,
    options.providerOptions?.webSearch ?? false
  );
  const thinkingConfig = buildGeminiThinkingConfig(
    options.model,
    options.providerOptions,
    options.customModels
  );

  return {
    systemInstruction: options.system,
    ...(options.responseMimeType
      ? { responseMimeType: options.responseMimeType }
      : {}),
    ...(tools ? { tools } : {}),
    ...(thinkingConfig ? { thinkingConfig } : {}),
  };
}

const DISALLOWED_GEMINI_SCHEMA_KEYS = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "additionalProperties",
  "unevaluatedProperties",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "allOf",
  "oneOf",
  "not",
  "const",
  "multipleOf",
  "uniqueItems",
  "readOnly",
  "writeOnly",
  "prefixItems",
]);

export function sanitizeGeminiSchema(
  obj: unknown
): Record<string, unknown> | undefined {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return;
  }

  const record = obj as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(record)) {
    if (key === "exclusiveMinimum") {
      if (typeof value === "number" && !("minimum" in record)) {
        result.minimum = record.type === "integer" ? value + 1 : value;
      }
      continue;
    }

    if (key === "exclusiveMaximum") {
      if (typeof value === "number" && !("maximum" in record)) {
        result.maximum = record.type === "integer" ? value - 1 : value;
      }
      continue;
    }

    if (DISALLOWED_GEMINI_SCHEMA_KEYS.has(key)) {
      continue;
    }

    if (key === "type" && Array.isArray(value)) {
      const nonNullType = value.find(
        (item) => typeof item === "string" && item !== "null"
      );
      if (value.includes("null")) {
        result.nullable = true;
      }
      if (typeof nonNullType === "string") {
        result.type = nonNullType;
      }
      continue;
    }

    if (value && typeof value === "object") {
      if (Array.isArray(value)) {
        result[key] = value
          .map((item) =>
            typeof item === "object" && item !== null
              ? sanitizeGeminiSchema(item)
              : item
          )
          .filter((item) => item !== undefined);
      } else {
        result[key] = sanitizeGeminiSchema(value);
      }
    } else {
      result[key] = value;
    }
  }

  return result;
}

function buildGeminiTools(
  tools: LlmToolDefinition[] | undefined,
  webSearch: boolean
): Tool[] | undefined {
  const result: Tool[] = [];

  if (webSearch) {
    result.push({ googleSearch: {} });
  }

  if (tools?.length) {
    result.push({
      functionDeclarations: tools.map((tool) => ({
        description: tool.description,
        name: tool.name,
        parameters: (sanitizeGeminiSchema(tool.parameters) as Record<
          string,
          unknown
        >) ?? {
          properties: {},
          type: "OBJECT",
        },
      })),
    });
  }

  return result.length > 0 ? result : undefined;
}

// https://ai.google.dev/gemini-api/docs/generate-content/thinking
// Named levels are sent only when advertised; legacy 2.5 budgets stay provider-managed.
const GEMINI_THINKING_LEVELS: Record<string, ThinkingLevel> = {
  high: ThinkingLevel.HIGH,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  minimal: ThinkingLevel.MINIMAL,
};

function buildGeminiThinkingConfig(
  model: string,
  providerOptions: ProviderChatOptions | undefined,
  customModels?: CustomModelEntry[]
): GenerateContentConfig["thinkingConfig"] {
  if (
    !(
      providerOptions?.thinking?.enabled &&
      modelSupportsReasoning(model, customModels)
    )
  ) {
    return;
  }
  const effort = resolveModelThinkingEffort(
    model,
    providerOptions.thinking.effort,
    customModels
  );
  const thinkingLevel = effort ? GEMINI_THINKING_LEVELS[effort] : undefined;
  return {
    includeThoughts: true,
    ...(thinkingLevel ? { thinkingLevel } : {}),
  };
}

export function buildGeminiChatConfig(
  input: Pick<GenerateChatInput, "tools" | "providerOptions">,
  system: string,
  model: string,
  customModels?: CustomModelEntry[]
): GenerateContentConfig {
  return buildGeminiGenerateConfig({
    customModels,
    model,
    providerOptions: input.providerOptions,
    system,
    tools: input.tools,
  });
}

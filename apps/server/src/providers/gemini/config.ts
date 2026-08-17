import type {
  GenerateChatInput,
  LlmToolDefinition,
  ProviderChatOptions,
  ThinkingEffort,
} from "@atlas/core";
import {
  type GenerateContentConfig,
  ThinkingLevel,
  type Tool,
} from "@google/genai";
import { resolveThinkingEffort } from "../shared";

export function buildGeminiGenerateConfig(options: {
  system: string;
  tools?: LlmToolDefinition[];
  providerOptions?: ProviderChatOptions;
  model: string;
  responseMimeType?: string;
}): GenerateContentConfig {
  const tools = buildGeminiTools(
    options.tools,
    options.providerOptions?.webSearch ?? false
  );
  const thinkingConfig = buildGeminiThinkingConfig(
    options.model,
    options.providerOptions
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

function buildGeminiThinkingConfig(
  model: string,
  providerOptions: ProviderChatOptions | undefined
): GenerateContentConfig["thinkingConfig"] {
  const enabled = providerOptions?.thinking?.enabled ?? false;

  if (!enabled) {
    if (model.includes("flash")) {
      return { thinkingBudget: 0 };
    }

    return;
  }

  const effort = resolveThinkingEffort(providerOptions?.thinking?.effort);

  if (model.includes("gemini-3") || model.includes("3-")) {
    return {
      includeThoughts: true,
      thinkingLevel: mapEffortToThinkingLevel(effort),
    };
  }

  return {
    includeThoughts: true,
    thinkingBudget: mapEffortToThinkingBudget(effort),
  };
}

function mapEffortToThinkingLevel(effort: ThinkingEffort): ThinkingLevel {
  const resolved = resolveThinkingEffort(effort);
  if (resolved === "low") {
    return ThinkingLevel.LOW;
  }

  if (resolved === "high" || resolved === "xhigh" || resolved === "max") {
    return ThinkingLevel.HIGH;
  }

  return ThinkingLevel.MEDIUM;
}

function mapEffortToThinkingBudget(effort: ThinkingEffort): number {
  const resolved = resolveThinkingEffort(effort);
  if (resolved === "low") {
    return 1024;
  }

  if (resolved === "high" || resolved === "xhigh" || resolved === "max") {
    return 8192;
  }

  return 4096;
}

export function buildGeminiChatConfig(
  input: Pick<GenerateChatInput, "tools" | "providerOptions">,
  system: string,
  model: string
): GenerateContentConfig {
  return buildGeminiGenerateConfig({
    model,
    providerOptions: input.providerOptions,
    system,
    tools: input.tools,
  });
}

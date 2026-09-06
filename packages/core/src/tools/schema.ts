import Ajv, { type Options, type ValidateFunction } from "ajv";
import Ajv2019 from "ajv/dist/2019";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { z } from "zod";
import type {
  JsonSchema,
  LlmToolDefinition,
  ToolDefinition,
} from "../contract";
import { DEFAULT_MAX_RESULTS, MAX_RESULTS_LIMIT } from "./ripgrep";

const toolArgumentValidators = new WeakMap<
  JsonSchema,
  ValidateFunction | Error
>();
const validatorOptions: Options = {
  addUsedSchema: false,
  allErrors: false,
  allowMatchingProperties: true,
  coerceTypes: false,
  ownProperties: true,
  removeAdditional: false,
  strictRequired: false,
  strictSchema: true,
  strictTuples: false,
  strictTypes: false,
  useDefaults: false,
};
const schemaCompilers = {
  "draft-7": addFormats(new Ajv(validatorOptions)),
  "draft-2019-09": addFormats(new Ajv2019(validatorOptions)),
  "draft-2020-12": addFormats(new Ajv2020(validatorOptions)),
};

function compileToolArguments(parameters: JsonSchema): ValidateFunction {
  const dialect: unknown = Reflect.get(parameters, "$schema");
  let compiler = schemaCompilers["draft-2020-12"];
  if (dialect === "http://json-schema.org/draft-07/schema#") {
    compiler = schemaCompilers["draft-7"];
  } else if (dialect === "https://json-schema.org/draft/2019-09/schema") {
    compiler = schemaCompilers["draft-2019-09"];
  } else if (
    dialect !== undefined &&
    dialect !== "https://json-schema.org/draft/2020-12/schema"
  ) {
    throw new Error(`Unsupported JSON Schema dialect: ${String(dialect)}`);
  }
  try {
    const validator = compiler.compile(parameters);
    if (Reflect.get(validator, "$async") === true) {
      throw new Error("Asynchronous tool parameter schemas are not supported.");
    }
    return validator;
  } finally {
    // Tool schemas and their local refs stay scoped to that tool, and the weak
    // validator cache must not retain every ephemeral session schema via Ajv.
    compiler.removeSchema(parameters);
  }
}

/** Validate advertised JSON schemas without coercing or changing the call arguments. */
export function validateToolArguments(
  parameters: JsonSchema | undefined,
  input: unknown
): void {
  if (!parameters) {
    return;
  }
  let validator = toolArgumentValidators.get(parameters);
  if (validator === undefined) {
    try {
      validator = compileToolArguments(parameters);
    } catch (error) {
      validator = Object.assign(
        new Error(
          `Tool parameter schema cannot be validated: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        ),
        { code: "INVALID_ARGUMENT" }
      );
    }
    toolArgumentValidators.set(parameters, validator);
  }
  if (validator instanceof Error) {
    throw validator;
  }
  if (validator(input)) {
    return;
  }
  const details = (validator.errors ?? []).map((issue) => ({
    keyword: issue.keyword,
    message: issue.message,
    path: issue.instancePath,
  }));
  const summary = details
    .slice(0, 3)
    .map((issue) => `${issue.path || "input"}: ${issue.message}`)
    .join("; ");
  throw Object.assign(new Error(`Invalid tool input: ${summary}`), {
    code: "INVALID_ARGUMENT",
    details,
  });
}

export function emptyObjectSchema(): JsonSchema {
  return {
    additionalProperties: false,
    properties: {},
    type: "object",
  };
}

export function permissiveObjectSchema(): JsonSchema {
  return {
    additionalProperties: true,
    type: "object",
  };
}

export function toLlmToolDefinition(tool: ToolDefinition): LlmToolDefinition {
  return {
    description: tool.description,
    name: tool.name,
    parameters: tool.parameters ?? emptyObjectSchema(),
  };
}

export function toLlmToolDefinitions(
  tools: ToolDefinition[]
): LlmToolDefinition[] {
  return tools.map(toLlmToolDefinition);
}

export function jsonSchemaFromZod(schema: z.ZodType): JsonSchema {
  const { $schema, ...jsonSchema } = schema.toJSONSchema();
  return jsonSchema as JsonSchema;
}

export function parseToolInput<T>(schema: z.ZodType<T>, input: unknown): T {
  try {
    return schema.parse(input);
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new Error(err.issues[0]?.message ?? "Invalid tool input.");
    }
    throw err;
  }
}

export function requiredTrimmedString(field: string) {
  return z
    .string({ error: `${field} is required.` })
    .trim()
    .min(1, `${field} is required.`);
}

export const trimmedOptionalString = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined,
  z.string().optional()
);

export const maxResultsSchema = z.preprocess((value) => {
  if (value === undefined) {
    return DEFAULT_MAX_RESULTS;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_RESULTS;
  }
  const normalized = Math.floor(value);
  if (normalized <= 0) {
    return DEFAULT_MAX_RESULTS;
  }
  return Math.min(normalized, MAX_RESULTS_LIMIT);
}, z.number().int().positive().max(MAX_RESULTS_LIMIT));

export const optionalRegexFlag = z.preprocess(
  (value) => (typeof value === "boolean" ? value : undefined),
  z.boolean().optional().default(true)
);

export const readFileOffsetSchema = z.preprocess((value) => {
  if (value === undefined) {
    return 1;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return 1;
  }
  return value;
}, z.number().int().positive());

export const readFileLimitSchema = z.preprocess((value) => {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return;
  }
  return value;
}, z.number().int().positive().optional());

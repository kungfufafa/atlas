import { describe, expect, test } from "bun:test";
import type { JsonSchema, ToolDefinition } from "../contract";
import { executeProtectedTool } from "./execution";

describe("tool argument validation boundary", () => {
  test("blocks invalid nested, required, enum, and array inputs before any handler side effect", async () => {
    let attempts = 0;
    const tool: ToolDefinition = {
      description: "Validates a nested mutation request",
      name: "validated_custom_tool",
      parameters: {
        additionalProperties: false,
        properties: {
          mode: { enum: ["read", "preview"] },
          records: {
            items: {
              additionalProperties: false,
              properties: { id: { type: "integer" } },
              required: ["id"],
              type: "object",
            },
            type: "array",
          },
        },
        required: ["mode", "records"],
        type: "object",
      },
      retryPolicy: { initialDelayMs: 0, maxRetries: 2 },
      async run() {
        attempts += 1;
        return { ok: true };
      },
    };

    for (const input of [
      { records: [{ id: 1 }] },
      { mode: "write", records: [{ id: 1 }] },
      { mode: "read", records: [{ id: "1" }] },
      { mode: "read", records: [{}] },
      { mode: "read", records: [{ id: 1, secret: true }] },
      { mode: "read", records: {} },
      null,
    ]) {
      const result = await executeProtectedTool(tool, input, {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_ARGUMENT");
    }
    expect(attempts).toBe(0);
  });

  test("accepts schema unions without coercing values or inserting defaults into execution input", async () => {
    let received: unknown;
    const parameters = {
      additionalProperties: false,
      properties: {
        limit: { default: 10, type: "integer" },
        selector: {
          anyOf: [{ type: "integer" }, { type: "string" }],
        },
      },
      required: ["selector"],
      type: "object",
    };
    const input = { selector: "0123" };
    const tool: ToolDefinition = {
      description: "Preserves the model's valid input",
      name: "schema_union",
      parameters,
      async run(value) {
        received = value;
        return value;
      },
    };

    const result = await executeProtectedTool(tool, input, {});

    expect(result.success).toBe(true);
    expect(received).toBe(input);
    expect(received).toEqual({ selector: "0123" });
    expect(input).not.toHaveProperty("limit");
  });

  test("enforces conditional requirements from the declared JSON Schema dialect", async () => {
    let attempts = 0;
    const tool: ToolDefinition = {
      description: "Validates a conditional schema before execution",
      name: "conditional_schema",
      parameters: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        dependentRequired: { write: ["path"] },
        type: "object",
      } as JsonSchema,
      async run() {
        attempts += 1;
        return { ok: true };
      },
    };

    const result = await executeProtectedTool(tool, { write: true }, {});

    expect(attempts).toBe(0);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe("INVALID_ARGUMENT");
    expect(
      (
        await executeProtectedTool(
          tool,
          { path: "report.txt", write: true },
          {}
        )
      ).success
    ).toBe(true);
    expect(attempts).toBe(1);
  });

  test("rejects missing required arguments even when defaults or no property schema are advertised", async () => {
    for (const parameters of [
      {
        properties: { path: { default: "report.txt", type: "string" } },
        required: ["path"],
        type: "object",
      },
      { required: ["path"], type: "object" },
      { properties: { count: { minimum: 1 } }, required: ["count"] },
    ]) {
      let attempts = 0;
      const tool: ToolDefinition = {
        description: "Requires the original arguments to satisfy the schema",
        name: "required_arguments",
        parameters,
        async run() {
          attempts += 1;
        },
      };
      const result = await executeProtectedTool(tool, { count: 0 }, {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe("INVALID_ARGUMENT");
      expect(attempts).toBe(0);
    }
  });

  test("fails closed for invalid, unknown, external, and asynchronous schemas before side effects", async () => {
    for (const parameters of [
      { $schema: "https://example.invalid/schema", type: "object" },
      { $ref: "https://example.invalid/tool-input.json", type: "object" },
      { type: "invalid" },
      { type: "object", unknownConstraint: true },
      {
        properties: { path: { format: "unknown-format", type: "string" } },
        type: "object",
      },
      { $async: true, type: "object" },
    ]) {
      let attempts = 0;
      const tool: ToolDefinition = {
        description: "Has an unsupported parameter schema",
        name: "unsupported_schema",
        parameters,
        retryPolicy: { initialDelayMs: 0, maxRetries: 2 },
        async run() {
          attempts += 1;
          return { ok: true };
        },
      };
      for (const _attempt of [1, 2]) {
        const result = await executeProtectedTool(
          tool,
          { path: "report.txt" },
          {}
        );
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe("INVALID_ARGUMENT");
      }
      expect(attempts).toBe(0);
    }
  });

  test("uses exact draft semantics and keeps local reference IDs scoped to each tool", async () => {
    for (const dialect of [
      "http://json-schema.org/draft-07/schema#",
      "https://json-schema.org/draft/2019-09/schema",
      "https://json-schema.org/draft/2020-12/schema",
    ]) {
      for (const expected of ["first", "second"]) {
        const tool: ToolDefinition = {
          description: "Uses a local reference",
          name: "local_schema",
          parameters: {
            $defs: { value: { const: expected } },
            $id: "https://atlas.invalid/reused-tool-schema",
            $schema: dialect,
            properties: { value: { $ref: "#/$defs/value" } },
            required: ["value"],
            type: "object",
          } as JsonSchema,
          run: async (input) => input,
        };
        expect(
          (await executeProtectedTool(tool, { value: expected }, {})).success
        ).toBe(true);
        expect(
          (await executeProtectedTool(tool, { value: "other" }, {})).success
        ).toBe(false);
      }
    }
  });
});

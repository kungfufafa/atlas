import { expect, test } from "bun:test";
import { officeDocumentTool } from "../../../../packages/core/src/tools/office-document";
import { validateToolArguments } from "../../../../packages/core/src/tools/schema";
import { buildAnthropicTools } from "./anthropic/web-search";
import { buildGeminiGenerateConfig } from "./gemini/config";
import { toOpenAITools } from "./openai";

test("Office declarations stay root objects through OpenAI, Anthropic and Gemini serialization", () => {
  const tools = [officeDocumentTool];
  const openai = toOpenAITools(tools)![0]!.function.parameters;
  const anthropic = buildAnthropicTools(tools, false)![0] as {
    input_schema: unknown;
  };
  const gemini = buildGeminiGenerateConfig({
    model: "configured-model",
    system: "",
    tools,
  }).tools![0]!.functionDeclarations![0]!.parameters;
  for (const schema of [openai, anthropic.input_schema, gemini]) {
    expect(schema).toMatchObject({ type: "object" });
    expect(Reflect.get(schema as object, "required")).toContain("operation");
    expect(Reflect.get(schema as object, "required")).toContain("documentRef");
    expect(Reflect.get(schema as object, "anyOf")).toBeUndefined();
    expect(Reflect.get(schema as object, "oneOf")).toBeUndefined();
    expect(schema).toMatchObject({
      properties: {
        edits: {
          items: {
            properties: { kind: { enum: ["replace_text", "set_table_cell"] } },
            type: "object",
          },
        },
      },
    });
  }
  expect(() =>
    validateToolArguments(officeDocumentTool.parameters, {
      documentRef: "original.docx",
      edits: [
        {
          expectedMatches: 1,
          find: "Before",
          kind: "replace_text",
          replace: "After",
        },
      ],
      operation: "edit",
    })
  ).not.toThrow();
});

test("the portable declaration does not let cross-operation fields or incomplete edits reach file I/O", async () => {
  let loads = 0;
  const context = {
    loadAttachment: async () => {
      loads++;
      throw new Error("File must not be loaded");
    },
  };
  for (const input of [
    {
      documentRef: "att_document",
      edits: [
        {
          expectedMatches: 1,
          find: "Before",
          kind: "replace_text",
          replace: "After",
        },
      ],
      limit: 10,
      operation: "edit",
    },
    {
      documentRef: "att_document",
      edits: [
        {
          expectedMatches: 1,
          find: "Before",
          kind: "replace_text",
          replace: "After",
        },
      ],
      operation: "read",
    },
    { documentRef: "att_document", operation: "edit" },
  ]) {
    await expect(
      officeDocumentTool.run(input as never, context)
    ).rejects.toThrow();
  }
  expect(loads).toBe(0);
});

import { expect, test } from "bun:test";
import { channelActionTool } from "../../../../packages/core/src/tools/channel-action";
import { validateToolArguments } from "../../../../packages/core/src/tools/schema";
import { buildAnthropicTools } from "./anthropic/web-search";
import { buildGeminiGenerateConfig } from "./gemini/config";
import { toOpenAITools } from "./openai";

test("native channel declaration retains an object root across actual API provider serializers", () => {
  const { description, name, parameters } = channelActionTool;
  if (!parameters) {
    throw new Error("Native channel tool must declare its parameters");
  }
  const tools = [{ description, name, parameters }];
  const openai = toOpenAITools(tools)![0]!.function.parameters;
  const anthropicTool = buildAnthropicTools(tools, false)?.[0];
  if (!(anthropicTool && "input_schema" in anthropicTool)) {
    throw new Error("Anthropic must receive a custom tool declaration");
  }
  const anthropic = anthropicTool.input_schema;
  const geminiTool = buildGeminiGenerateConfig({
    model: "explicit-fixture-model",
    system: "",
    tools,
  }).tools?.[0];
  if (!(geminiTool && "functionDeclarations" in geminiTool)) {
    throw new Error("Gemini must receive a function declaration");
  }
  const gemini = geminiTool.functionDeclarations?.[0]?.parameters;
  for (const schema of [openai, anthropic, gemini]) {
    if (typeof schema !== "object" || schema === null) {
      throw new Error("Every serializer must retain the tool schema");
    }
    expect(schema).toMatchObject({ required: ["kind"], type: "object" });
    expect(Reflect.get(schema, "oneOf")).toBeUndefined();
    expect(Reflect.get(schema, "anyOf")).toBeUndefined();
    expect(schema).toMatchObject({
      properties: {
        kind: {
          enum: [
            "react",
            "poll",
            "edit",
            "delete",
            "pin",
            "unpin",
            "topic_create",
            "topic_edit",
            "thread_create",
            "send_media",
          ],
        },
      },
    });
  }
});

test("portable declaration cannot dispatch incomplete, cross-action or destination-injected calls", async () => {
  let requests = 0;
  const context = {
    requestChannelAction: async () => {
      requests += 1;
      return { status: "accepted" as const };
    },
  };
  for (const input of [
    { kind: "poll", question: "Incomplete" },
    { emoji: "✅", kind: "react", path: "file.txt" },
    { kind: "topic_edit" },
    { channelChatId: "foreign-room", kind: "delete", messageId: "1" },
  ]) {
    await expect(channelActionTool.run(input, context)).rejects.toThrow();
  }
  expect(requests).toBe(0);
  for (const input of [
    { emoji: "", kind: "react" },
    {
      allowMultiple: false,
      kind: "poll",
      options: ["A", "B"],
      question: "Choice",
    },
    { kind: "edit", messageId: "1", text: "Updated" },
    { kind: "delete", messageId: "1" },
    { kind: "pin", messageId: "1" },
    { kind: "unpin", messageId: "1" },
    { kind: "topic_create", name: "Topic" },
    { closed: false, kind: "topic_edit" },
    { kind: "thread_create", name: "Thread" },
    { kind: "send_media", mode: "voice", path: "artifacts/voice.ogg" },
  ]) {
    expect(() =>
      validateToolArguments(channelActionTool.parameters, input)
    ).not.toThrow();
    await expect(channelActionTool.run(input, context)).resolves.toEqual({
      status: "accepted",
    });
  }
  expect(requests).toBe(10);
});

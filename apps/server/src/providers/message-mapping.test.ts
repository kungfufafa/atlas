import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@atlas/core";
import { toAnthropicMessages } from "./anthropic";
import { toGeminiContents } from "./gemini";
import { toOpenAIMessages, toResponsesInput } from "./openai";

const tinyPngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const multimodalUserMessage: ChatMessage = {
  content: [
    { text: "What is this?", type: "text" },
    { data: tinyPngBase64, mediaType: "image/png", type: "image" },
  ],
  role: "user",
};

const documentUserMessage: ChatMessage = {
  content: [
    { text: "Summarize this file", type: "text" },
    {
      data: "JVBERi0=",
      filename: "report.pdf",
      mediaType: "application/pdf",
      type: "document",
    },
  ],
  role: "user",
};

describe("provider user content mapping", () => {
  test("toAnthropicMessages maps image parts", async () => {
    const result = await toAnthropicMessages([multimodalUserMessage]);
    const user = result[0];

    expect(user?.role).toBe("user");
    expect(Array.isArray(user?.content)).toBe(true);

    const blocks = user?.content as Array<Record<string, unknown>>;
    expect(blocks[0]).toEqual({ text: "What is this?", type: "text" });
    expect(blocks[1]).toEqual({
      source: {
        data: tinyPngBase64,
        media_type: "image/png",
        type: "base64",
      },
      type: "image",
    });
  });

  test("toAnthropicMessages maps document parts", async () => {
    const result = await toAnthropicMessages([documentUserMessage]);
    const user = result[0];
    const blocks = user?.content as Array<Record<string, unknown>>;

    expect(blocks[1]).toEqual({
      source: {
        data: "JVBERi0=",
        media_type: "application/pdf",
        type: "base64",
      },
      type: "document",
    });
  });

  test("toAnthropicMessages keeps only assistant tool calls that have immediate tool results", async () => {
    const result = await toAnthropicMessages([
      { content: "Look this up", role: "user" },
      {
        content: "",
        role: "assistant",
        toolCalls: [
          { arguments: { q: "keep" }, id: "call_keep", name: "lookup" },
          { arguments: { q: "drop" }, id: "call_drop", name: "lookup" },
        ],
      },
      {
        content: '{"result":"ok"}',
        role: "tool",
        toolCallId: "call_keep",
      },
      { content: "Summarize", role: "user" },
    ]);

    expect(result).toHaveLength(4);
    const assistant = result.find((message) => message.role === "assistant");
    expect(Array.isArray(assistant?.content)).toBe(true);

    const blocks = assistant?.content as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      id: "call_keep",
      input: { q: "keep" },
      name: "lookup",
      type: "tool_use",
    });

    const toolResult = result.find(
      (message, index) => message.role === "user" && index > 1
    );
    expect(toolResult?.content).toEqual([
      {
        content: '{"result":"ok"}',
        tool_use_id: "call_keep",
        type: "tool_result",
      },
    ]);
  });

  test("toAnthropicMessages drops assistant tool_use without tool results", async () => {
    const result = await toAnthropicMessages([
      { content: "Look this up", role: "user" },
      {
        content: "",
        role: "assistant",
        toolCalls: [
          { arguments: { q: "x" }, id: "call_orphan", name: "lookup" },
        ],
      },
      { content: "What did you find?", role: "user" },
    ]);

    expect(result).toEqual([
      { content: "Look this up", role: "user" },
      { content: "What did you find?", role: "user" },
    ]);
  });

  test("toAnthropicMessages inlines text/plain documents for opencode_go", async () => {
    const text = "alpha beta gamma";
    const data = Buffer.from(text, "utf8").toString("base64");
    const message: ChatMessage = {
      content: [
        { text: "Summarize", type: "text" },
        {
          data,
          filename: "Pasted text (3 words).txt",
          mediaType: "text/plain",
          type: "document",
        },
      ],
      role: "user",
    };

    const result = await toAnthropicMessages([message], "opencode_go");
    const user = result[0];
    const blocks = user?.content as Array<Record<string, unknown>>;

    expect(blocks[0]).toEqual({ text: "Summarize", type: "text" });
    expect(blocks[1]).toEqual({
      text: "[File: Pasted text (3 words).txt]\nalpha beta gamma",
      type: "text",
    });
  });

  test("toGeminiContents maps image and document parts", async () => {
    const imageResult = await toGeminiContents([multimodalUserMessage]);
    expect(imageResult[0]?.parts?.[0]?.text).toBe("What is this?");
    expect(imageResult[0]?.parts?.[1]?.inlineData).toEqual({
      data: tinyPngBase64,
      mimeType: "image/png",
    });

    const docResult = await toGeminiContents([documentUserMessage]);
    expect(docResult[0]?.parts?.[1]?.inlineData).toEqual({
      data: "JVBERi0=",
      mimeType: "application/pdf",
    });
  });

  test("toOpenAIMessages maps image parts", async () => {
    const result = await toOpenAIMessages("system", [multimodalUserMessage]);
    const user = result.find((message) => message.role === "user");

    expect(Array.isArray(user?.content)).toBe(true);

    const parts = user?.content as Array<Record<string, unknown>>;
    const imagePart = parts[1];
    expect(parts[0]).toEqual({ text: "What is this?", type: "text" });
    expect(imagePart?.type).toBe("image_url");
    expect(
      (imagePart?.image_url as { url: string } | undefined)?.url
    ).toStartWith("data:image/png;base64,");
  });

  test("toResponsesInput maps image parts", async () => {
    const result = await toResponsesInput([multimodalUserMessage]);
    const user = result[0] as {
      type?: string;
      role: string;
      content: Array<Record<string, unknown>>;
    };

    expect(user.type).toBe("message");
    expect(user.role).toBe("user");
    expect(user.content[0]).toEqual({
      text: "What is this?",
      type: "input_text",
    });
    expect(user.content[1]?.type).toBe("input_image");
    expect(user.content[1]?.image_url).toStartWith("data:image/png;base64,");
  });

  test("toOpenAIMessages maps document parts", async () => {
    const result = await toOpenAIMessages("system", [documentUserMessage]);
    const user = result.find((message) => message.role === "user");
    const parts = user?.content as Array<Record<string, unknown>>;

    expect(parts[1]).toEqual({
      file_data: "data:application/pdf;base64,JVBERi0=",
      filename: "report.pdf",
      type: "input_file",
    });
  });

  test("toOpenAIMessages inlines text/plain documents for opencode_go", async () => {
    const text = "alpha beta gamma";
    const data = Buffer.from(text, "utf8").toString("base64");
    const message: ChatMessage = {
      content: [
        { text: "Summarize", type: "text" },
        {
          data,
          filename: "Pasted text (3 words).txt",
          mediaType: "text/plain",
          type: "document",
        },
      ],
      role: "user",
    };

    const result = await toOpenAIMessages("system", [message], "opencode_go");
    const user = result.find((entry) => entry.role === "user");
    const parts = user?.content as Array<Record<string, unknown>>;

    expect(parts[0]).toEqual({ text: "Summarize", type: "text" });
    expect(parts[1]).toEqual({
      text: "[File: Pasted text (3 words).txt]\nalpha beta gamma",
      type: "text",
    });
  });

  test("toOpenAIMessages does not send null content without tool_calls", async () => {
    const result = await toOpenAIMessages(
      "system",
      [
        { content: "hi", role: "user" },
        { content: "", role: "assistant", thinking: "plan" },
      ],
      "opencode_go"
    );
    const assistant = result.find((entry) => entry.role === "assistant");

    expect(assistant).toEqual({
      content: "",
      reasoning_content: "plan",
      role: "assistant",
    });
  });

  test("toResponsesInput maps document parts", async () => {
    const result = await toResponsesInput([documentUserMessage]);
    const user = result[0] as {
      type?: string;
      role: string;
      content: Array<Record<string, unknown>>;
    };

    expect(user.content[1]).toEqual({
      file_data: "data:application/pdf;base64,JVBERi0=",
      filename: "report.pdf",
      type: "input_file",
    });
  });

  test("toResponsesInput extracts documents for compatible endpoints", async () => {
    const textDocumentMessage: ChatMessage = {
      content: [
        { text: "Summarize", type: "text" },
        {
          data: Buffer.from("alpha beta", "utf8").toString("base64"),
          filename: "notes.txt",
          mediaType: "text/plain",
          type: "document",
        },
      ],
      role: "user",
    };
    const result = await toResponsesInput(
      [textDocumentMessage],
      "openai_compatible"
    );
    const user = result[0] as {
      content: Array<Record<string, unknown>>;
    };

    expect(user.content.some((part) => part.type === "input_file")).toBe(false);
    expect(user.content.some((part) => part.type === "input_text")).toBe(true);
  });

  test("toResponsesInput aligns function_call ids with tool outputs", async () => {
    const result = (await toResponsesInput([
      { content: "run my digest", role: "user" },
      {
        content: "",
        providerContent: [
          {
            arguments: '{"automationId":"automation_1"}',
            call_id: "fc_internal_id",
            id: "fc_internal_id",
            name: "run_automation",
            type: "function_call",
          },
        ],
        role: "assistant",
        toolCalls: [
          {
            arguments: { automationId: "automation_1" },
            id: "call_tool_id",
            name: "run_automation",
          },
        ],
      },
      {
        content: '{"status":"completed","output":"done"}',
        name: "run_automation",
        role: "tool",
        toolCallId: "call_tool_id",
      },
    ])) as Array<Record<string, unknown>>;

    expect(result).toEqual([
      { content: "run my digest", role: "user" },
      {
        arguments: '{"automationId":"automation_1"}',
        call_id: "call_tool_id",
        name: "run_automation",
        type: "function_call",
      },
      {
        call_id: "call_tool_id",
        output: '{"status":"completed","output":"done"}',
        type: "function_call_output",
      },
    ]);
  });
});

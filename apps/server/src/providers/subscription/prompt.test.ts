import { describe, expect, test } from "bun:test";
import type { GenerateChatInput } from "@atlas/core";
import { formatSubscriptionPrompt, parseSubscriptionResponse } from "./prompt";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("subscription prompt mapping", () => {
  test("keeps Atlas as the tool executor", async () => {
    const formatted = await formatSubscriptionPrompt(
      {
        messages: [{ content: "Search docs", role: "user" }],
        system: "You are Atlas.",
        tools: [
          {
            description: "Search the knowledge base",
            name: "knowledge_base_search",
            parameters: { type: "object" },
          },
        ],
      },
      "chatgpt"
    );

    expect(formatted.developerInstructions).toContain("You are Atlas.");
    expect(formatted.developerInstructions).toContain("atlas-tool-call");
    expect(formatted.developerInstructions).toContain("knowledge_base_search");
    expect(formatted.latestTurn).toContain("Search docs");
  });

  test("keeps Atlas write tools outside both native runtime permission boundaries", async () => {
    const input: GenerateChatInput = {
      messages: [{ content: "Create a presentation", role: "user" }],
      system: "You are Atlas.",
      tools: [
        {
          description: "Create a PowerPoint presentation",
          name: "write_pptx",
          parameters: { type: "object" },
        },
      ],
    };
    const [chatgpt, claude] = await Promise.all([
      formatSubscriptionPrompt(input, "chatgpt"),
      formatSubscriptionPrompt(input, "claude"),
    ]);

    for (const formatted of [chatgpt, claude]) {
      expect(formatted.developerInstructions).toMatch(
        /Atlas, not this subscription runtime, executes every tool listed below/
      );
      expect(formatted.developerInstructions).toMatch(
        /native sandbox, filesystem, approval, and permission settings do not restrict Atlas tools/
      );
      expect(formatted.developerInstructions).toMatch(
        /including creating or modifying files/
      );
      expect(formatted.developerInstructions).toMatch(
        /still enforce their own schemas, authorization, approval, and runtime checks/
      );
      expect(formatted.developerInstructions).toMatch(
        /Do not refuse because this runtime cannot perform the same action natively/
      );
      expect(formatted.developerInstructions).toContain("write_pptx");
    }
    expect(chatgpt.developerInstructions).toMatch(
      /read-only sandbox applies only to Codex-native shell and filesystem actions/
    );
    expect(claude.developerInstructions).toMatch(
      /empty native tool set and dontAsk permission mode apply only to Claude-native actions/
    );
  });

  test("extracts documents into the subscription transcript", async () => {
    const formatted = await formatSubscriptionPrompt(
      {
        messages: [
          {
            content: [
              { text: "Summarize this file.", type: "text" },
              {
                data: Buffer.from("Quarterly revenue grew 12%.").toString(
                  "base64"
                ),
                filename: "report.txt",
                mediaType: "text/plain",
                type: "document",
              },
            ],
            role: "user",
          },
        ],
        system: "You are Atlas.",
      },
      "claude"
    );

    expect(formatted.transcript).toContain("Summarize this file.");
    expect(formatted.transcript).toContain("Quarterly revenue grew 12%.");
    expect(formatted.transcript).toContain("report.txt");
  });

  test("resumes with only messages Atlas added after the native boundary", async () => {
    const first = await formatSubscriptionPrompt(
      {
        messages: [{ content: "Find the record", role: "user" }],
        system: "You are Atlas.",
      },
      "chatgpt"
    );
    const resumed = await formatSubscriptionPrompt(
      {
        messages: [
          { content: "Find the record", role: "user" },
          {
            content: "",
            role: "assistant",
            toolCalls: [
              {
                arguments: { query: "record" },
                id: "call-1",
                name: "knowledge_base_search",
              },
            ],
          },
          {
            content: "The record is 42.",
            name: "knowledge_base_search",
            role: "tool",
            toolCallId: "call-1",
          },
        ],
        system: "You are Atlas.",
      },
      "chatgpt",
      1
    );

    expect(resumed.previousHistoryFingerprint).toBe(first.historyFingerprint);
    expect(resumed.continuation).toBe(
      "Tool result (knowledge_base_search):\nThe record is 42."
    );
    expect(resumed.continuation).not.toContain("Find the record");
  });

  test("preserves images in first-turn and continuation inputs", async () => {
    const first = await formatSubscriptionPrompt(
      {
        messages: [
          {
            content: [
              { text: "Read this", type: "text" },
              {
                data: TINY_PNG_BASE64,
                mediaType: "image/png",
                type: "image",
              },
            ],
            role: "user",
          },
        ],
        system: "You are Atlas.",
      },
      "chatgpt"
    );
    const resumed = await formatSubscriptionPrompt(
      {
        messages: [
          {
            content: [
              { text: "Read this", type: "text" },
              {
                data: TINY_PNG_BASE64,
                mediaType: "image/png",
                type: "image",
              },
            ],
            role: "user",
          },
          { content: "It is a pixel.", role: "assistant" },
          {
            content: [
              { text: "Now compare this", type: "text" },
              {
                data: TINY_PNG_BASE64,
                mediaType: "image/png",
                type: "image",
              },
            ],
            role: "user",
          },
        ],
        system: "You are Atlas.",
      },
      "chatgpt",
      1
    );

    expect(first.transcriptInput).toEqual([
      { text: "User:\nRead this", type: "text" },
      {
        data: TINY_PNG_BASE64,
        mediaType: "image/png",
        type: "image",
      },
    ]);
    expect(resumed.continuationInput).toEqual([
      { text: "User:\nNow compare this", type: "text" },
      {
        data: TINY_PNG_BASE64,
        mediaType: "image/png",
        type: "image",
      },
    ]);
    expect(resumed.previousHistoryFingerprint).toBe(first.historyFingerprint);
  });

  test("preserves interleaved text and image order", async () => {
    const formatted = await formatSubscriptionPrompt(
      {
        messages: [
          {
            content: [
              { text: "First image:", type: "text" },
              {
                data: TINY_PNG_BASE64,
                mediaType: "image/png",
                type: "image",
              },
              { text: "Second image:", type: "text" },
              {
                data: "aW1hZ2UtdHdv",
                mediaType: "image/jpeg",
                type: "image",
              },
              { text: "Compare them.", type: "text" },
            ],
            role: "user",
          },
        ],
        system: "You are Atlas.",
      },
      "chatgpt"
    );

    expect(formatted.transcriptInput).toEqual([
      { text: "User:\nFirst image:", type: "text" },
      {
        data: TINY_PNG_BASE64,
        mediaType: "image/png",
        type: "image",
      },
      { text: "Second image:", type: "text" },
      {
        data: "aW1hZ2UtdHdv",
        mediaType: "image/jpeg",
        type: "image",
      },
      { text: "Compare them.", type: "text" },
    ]);
  });

  test("fingerprints image bytes as part of native history", async () => {
    const formatWithImage = (data: string) =>
      formatSubscriptionPrompt(
        {
          messages: [
            {
              content: [
                { text: "Same text", type: "text" },
                { data, mediaType: "image/png", type: "image" },
              ],
              role: "user",
            },
          ],
          system: "You are Atlas.",
        },
        "chatgpt"
      );

    const first = await formatWithImage(TINY_PNG_BASE64);
    const second = await formatWithImage(
      Buffer.from("different image bytes").toString("base64")
    );

    expect(first.transcript).toBe(second.transcript);
    expect(first.historyFingerprint).not.toBe(second.historyFingerprint);
  });

  test("parses fenced tool calls out of assistant text", () => {
    const result = parseSubscriptionResponse(
      [
        "I will search.",
        "```atlas-tool-call",
        '{"name":"knowledge_base_search","arguments":{"query":"docs"}}',
        "```",
      ].join("\n")
    );

    expect(result.content).toBe("I will search.");
    expect(result.toolCalls).toEqual([
      {
        arguments: { query: "docs" },
        id: expect.any(String),
        name: "knowledge_base_search",
      },
    ]);
  });
});

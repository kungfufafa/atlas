import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "@atlas/core";
import { toAnthropicMessages } from "./anthropic";
import { toGeminiContents } from "./gemini";
import { toResponsesInput } from "./openai";

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

const NORMALIZED_TOOL_CALL = {
  arguments: { query: "atlas" },
  id: "call_1",
  name: "search",
};

describe("provider content provenance", () => {
  test("reconstructs Gemini content when switching to Responses without dropping tool calls", async () => {
    const messages: ChatMessage[] = [
      {
        content: "normalized answer",
        providerContent: [
          {
            functionCall: { args: { query: "atlas" }, name: "search" },
            thoughtSignature: "gemini-secret-signature",
          },
        ],
        providerContentProvenance: {
          modelId: "gemini-model",
          protocol: "gemini-content",
          provider: "gemini",
          providerInstanceId: "gemini-1",
          providerReplayRevision: "revision-gemini",
        },
        role: "assistant",
        toolCalls: [NORMALIZED_TOOL_CALL],
      },
      {
        content: "tool result",
        name: "search",
        role: "tool",
        toolCallId: "call_1",
      },
    ];

    const mapped = await toResponsesInput(
      messages,
      "openai_compatible",
      "compatible-1",
      "responses-model",
      "revision-compatible"
    );

    expect(serialized(mapped)).not.toContain("gemini-secret-signature");
    expect(serialized(mapped)).toContain("normalized answer");
    expect(mapped).toContainEqual({
      arguments: '{"query":"atlas"}',
      call_id: "call_1",
      name: "search",
      type: "function_call",
    });
  });

  test("reconstructs Responses content when switching to Anthropic", async () => {
    const messages: ChatMessage[] = [
      {
        content: "normalized answer",
        providerContent: [
          {
            id: "endpoint-bound-response-id",
            summary: [{ text: "opaque reasoning" }],
            type: "reasoning",
          },
        ],
        providerContentProvenance: {
          modelId: "responses-a",
          protocol: "openai-responses",
          provider: "openai_compatible",
          providerInstanceId: "compatible-1",
          providerReplayRevision: "revision-a",
        },
        role: "assistant",
        toolCalls: [NORMALIZED_TOOL_CALL],
      },
      {
        content: "tool result",
        name: "search",
        role: "tool",
        toolCallId: "call_1",
      },
    ];

    const mapped = await toAnthropicMessages(
      messages,
      "anthropic",
      "anthropic-1",
      "claude-model",
      "revision-anthropic"
    );
    const content = mapped[0]?.content;

    expect(serialized(content)).not.toContain("endpoint-bound-response-id");
    expect(content).toEqual([
      { text: "normalized answer", type: "text" },
      {
        id: "call_1",
        input: { query: "atlas" },
        name: "search",
        type: "tool_use",
      },
    ]);
  });

  test("requires exact instance, model, and replay revision for Responses opaque content", async () => {
    const message: ChatMessage = {
      content: "safe normalized answer",
      providerContent: [
        {
          content: [{ text: "opaque endpoint answer", type: "output_text" }],
          id: "msg-bound-to-a",
          role: "assistant",
          type: "message",
        },
      ],
      providerContentProvenance: {
        modelId: "model-a",
        protocol: "openai-responses",
        provider: "openai_compatible",
        providerInstanceId: "instance-a",
        providerReplayRevision: "revision-a",
      },
      role: "assistant",
    };

    for (const active of [
      { instance: "instance-b", model: "model-a", revision: "revision-a" },
      { instance: "instance-a", model: "model-b", revision: "revision-a" },
      { instance: "instance-a", model: "model-a", revision: "revision-b" },
    ]) {
      const mapped = await toResponsesInput(
        [message],
        "openai_compatible",
        active.instance,
        active.model,
        active.revision
      );
      expect(serialized(mapped)).not.toContain("msg-bound-to-a");
      expect(serialized(mapped)).toContain("safe normalized answer");
    }

    const exact = await toResponsesInput(
      [message],
      "openai_compatible",
      "instance-a",
      "model-a",
      "revision-a"
    );
    expect(serialized(exact)).toContain("msg-bound-to-a");
  });

  test("keeps conservative pre-provenance Gemini and Anthropic replay", async () => {
    const geminiRaw = {
      functionCall: { args: { query: "atlas" }, name: "search" },
      thoughtSignature: "legacy-gemini-signature",
    };
    const gemini = await toGeminiContents([
      {
        content: "",
        providerContent: [geminiRaw],
        role: "assistant",
        toolCalls: [NORMALIZED_TOOL_CALL],
      },
    ]);
    expect(gemini[0]?.parts).toEqual([geminiRaw]);

    const anthropicRaw = {
      id: NORMALIZED_TOOL_CALL.id,
      input: { query: "atlas" },
      name: "search",
      type: "tool_use",
    };
    const anthropic = await toAnthropicMessages([
      {
        content: "",
        providerContent: [anthropicRaw],
        role: "assistant",
        toolCalls: [NORMALIZED_TOOL_CALL],
      },
      {
        content: "tool result",
        name: "search",
        role: "tool",
        toolCallId: NORMALIZED_TOOL_CALL.id,
      },
    ]);
    expect(anthropic[0]?.content).toEqual([anthropicRaw]);
  });

  test("reconstructs legacy opaque content when the active endpoint is identified", async () => {
    const gemini = await toGeminiContents(
      [
        {
          content: "normalized Gemini answer",
          providerContent: [
            {
              thought: true,
              thoughtSignature: "legacy-gemini-signature",
            },
          ],
          role: "assistant",
        },
      ],
      "gemini-instance",
      "gemini-model",
      "gemini-revision"
    );
    expect(serialized(gemini)).not.toContain("legacy-gemini-signature");
    expect(serialized(gemini)).toContain("normalized Gemini answer");

    const anthropic = await toAnthropicMessages(
      [
        {
          content: "normalized Anthropic answer",
          providerContent: [
            {
              signature: "legacy-anthropic-signature",
              thinking: "opaque",
              type: "thinking",
            },
          ],
          role: "assistant",
        },
      ],
      "anthropic",
      "anthropic-instance",
      "claude-model",
      "anthropic-revision"
    );
    expect(serialized(anthropic)).not.toContain("legacy-anthropic-signature");
    expect(serialized(anthropic)).toContain("normalized Anthropic answer");
  });

  test("never trusts legacy untagged Responses items", async () => {
    const mapped = await toResponsesInput([
      {
        content: "normalized",
        providerContent: [
          { id: "legacy-response-id", role: "assistant", type: "message" },
        ],
        role: "assistant",
      },
    ]);

    expect(serialized(mapped)).not.toContain("legacy-response-id");
    expect(serialized(mapped)).toContain("normalized");
  });
});

describe("Responses tool history sanitization", () => {
  test("drops orphan assistant calls and orphan outputs but keeps intact pairs", async () => {
    const orphanAssistant = await toResponsesInput([
      { content: "before", role: "user" },
      {
        content: "",
        role: "assistant",
        toolCalls: [NORMALIZED_TOOL_CALL],
      },
    ]);
    const orphanOutput = await toResponsesInput([
      {
        content: "result",
        name: "search",
        role: "tool",
        toolCallId: "call_1",
      },
    ]);
    const intact = await toResponsesInput([
      {
        content: "",
        role: "assistant",
        toolCalls: [NORMALIZED_TOOL_CALL],
      },
      {
        content: "result",
        name: "search",
        role: "tool",
        toolCallId: "call_1",
      },
    ]);

    expect(serialized(orphanAssistant)).not.toContain("function_call");
    expect(serialized(orphanOutput)).not.toContain("function_call_output");
    expect(serialized(intact)).toContain("function_call");
    expect(serialized(intact)).toContain("function_call_output");
  });
});

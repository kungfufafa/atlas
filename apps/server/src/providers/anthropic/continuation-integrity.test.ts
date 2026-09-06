import { expect, test } from "bun:test";
import type { GenerateChatInput } from "@atlas/core";
import { createAnthropicProvider } from "./index";

const input: GenerateChatInput = {
  messages: [{ content: "Research the topic", role: "user" }],
  system: "Use the available information.",
};

function response(text: string, pause: boolean, stream: boolean): Response {
  const stopReason = pause ? "pause_turn" : "end_turn";
  const usage = { input_tokens: 2, output_tokens: 1 };
  if (!stream) {
    return Response.json({
      content: [{ text, type: "text" }],
      stop_reason: stopReason,
      usage,
    });
  }
  const events = [
    { message: { usage }, type: "message_start" },
    {
      content_block: { text: "", type: "text" },
      index: 0,
      type: "content_block_start",
    },
    {
      delta: { text, type: "text_delta" },
      index: 0,
      type: "content_block_delta",
    },
    { index: 0, type: "content_block_stop" },
    { delta: { stop_reason: stopReason }, type: "message_delta", usage },
    { type: "message_stop" },
  ];
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } }
  );
}

for (const stream of [false, true]) {
  test(`Anthropic ${stream ? "streaming" : "JSON"} pause continuations replay each prior block exactly once`, async () => {
    const requests: Array<{
      messages: Array<{ role: string; content: unknown }>;
    }> = [];
    const fetcher = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));
      const turn = requests.length;
      return response(`Stage ${turn}`, turn < 3, stream);
    }) as typeof fetch;
    const provider = createAnthropicProvider({
      apiKey: "fixture",
      fetch: fetcher,
      model: "fixture",
    });
    const result = stream
      ? await provider.streamChat(input, { onChunk: () => {} })
      : await provider.generateChat(input);
    const replay = requests[2]?.messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.content);
    expect(requests).toHaveLength(3);
    expect(replay).toEqual([
      expect.objectContaining({ text: "Stage 1", type: "text" }),
      expect.objectContaining({ text: "Stage 2", type: "text" }),
    ]);
    expect(result.content).toContain("Stage 3");
  });

  test(`Anthropic ${stream ? "streaming" : "JSON"} rejects exhausted pause continuations`, async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return response("Still researching", true, stream);
    }) as typeof fetch;
    const provider = createAnthropicProvider({
      apiKey: "fixture",
      fetch: fetcher,
      model: "fixture",
    });
    await expect(
      stream
        ? provider.streamChat(input, { onChunk: () => {} })
        : provider.generateChat(input)
    ).rejects.toThrow();
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThan(10);
  });
}

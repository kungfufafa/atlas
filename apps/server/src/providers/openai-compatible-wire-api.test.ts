import { afterEach, describe, expect, mock, test } from "bun:test";
import { LLM_FETCH_TIMEOUT_MS } from "@atlas/core";
import { createOpenAICompatibleProvider } from "./openai-compatible";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const RESPONSE_PAYLOAD = {
  output: [
    {
      content: [{ text: "ok", type: "output_text" }],
      id: "msg_1",
      role: "assistant",
      status: "completed",
      type: "message",
    },
  ],
  usage: { input_tokens: 1, output_tokens: 1 },
};

function stubFetch(payload: unknown) {
  const calls: Array<{
    body: Record<string, unknown>;
    init?: RequestInit & { idleTimeout?: number };
    url: string;
  }> = [];

  globalThis.fetch = mock(async (url: unknown, init?: RequestInit) => {
    calls.push({
      body: JSON.parse(String(init?.body ?? "{}")),
      init,
      url: String(url),
    });

    return Response.json(payload);
  }) as unknown as typeof fetch;

  return calls;
}

function stubSseFetch(events: unknown[]) {
  const calls: Array<{ body: Record<string, unknown>; url: string }> = [];
  const sse = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");

  globalThis.fetch = mock(async (url: unknown, init?: RequestInit) => {
    calls.push({
      body: JSON.parse(String(init?.body ?? "{}")),
      url: String(url),
    });

    return new Response(sse, {
      headers: { "Content-Type": "text/event-stream" },
      status: 200,
    });
  }) as unknown as typeof fetch;

  return calls;
}

const CHAT_INPUT = {
  messages: [{ content: "hi", role: "user" as const }],
  providerOptions: {
    thinking: { effort: "medium" as const, enabled: true },
  },
  system: "s",
  tools: [
    {
      description: "Search",
      name: "search",
      parameters: { type: "object" as const },
    },
  ],
};

describe("OpenAI-compatible wire API", () => {
  test("Responses mode posts tools and reasoning to /responses", async () => {
    const calls = stubFetch(RESPONSE_PAYLOAD);
    const provider = createOpenAICompatibleProvider({
      apiKey: "k",
      baseUrl: "https://endpoint.test/v1",
      displayName: "Endpoint",
      model: "gpt-5.4",
      supportsThinking: true,
      wireApi: "responses",
    });

    await provider.generateChat(CHAT_INPUT);

    expect(calls[0]?.url).toBe("https://endpoint.test/v1/responses");
    expect(calls[0]?.body.reasoning).toEqual({
      effort: "medium",
      summary: "auto",
    });
    expect(calls[0]?.body.reasoning_effort).toBeUndefined();
    expect(calls[0]?.body.tools).toHaveLength(1);
  });

  test("Responses mode disables Bun idle timeout and composes caller abort with its deadline", async () => {
    const calls = stubFetch(RESPONSE_PAYLOAD);
    const caller = new AbortController();
    const provider = createOpenAICompatibleProvider({
      apiKey: "k",
      baseUrl: "https://endpoint.test/v1",
      displayName: "Endpoint",
      model: "gpt-5.4",
      supportsThinking: true,
      wireApi: "responses",
    });

    await provider.generateChat({ ...CHAT_INPUT, signal: caller.signal });

    const requestSignal = calls[0]?.init?.signal;
    expect(calls[0]?.init?.idleTimeout).toBe(0);
    expect(LLM_FETCH_TIMEOUT_MS).toBe(600_000);
    expect(requestSignal).toBeInstanceOf(AbortSignal);
    expect(requestSignal).not.toBe(caller.signal);
    expect(requestSignal?.aborted).toBe(false);
    caller.abort();
    expect(requestSignal?.aborted).toBe(true);
  });

  test("Responses mode streams from the configured endpoint", async () => {
    const calls = stubSseFetch([
      { delta: "ok", type: "response.output_text.delta" },
      {
        item: {
          content: [{ text: "ok", type: "output_text" }],
          role: "assistant",
          type: "message",
        },
        type: "response.output_item.done",
      },
      {
        response: {
          output: [
            {
              content: [{ text: "ok", type: "output_text" }],
              role: "assistant",
              type: "message",
            },
          ],
          status: "completed",
        },
        type: "response.completed",
      },
    ]);
    const provider = createOpenAICompatibleProvider({
      apiKey: "k",
      baseUrl: "https://endpoint.test/v1",
      displayName: "Endpoint",
      model: "gpt-5.4",
      supportsThinking: true,
      wireApi: "responses",
    });

    const chunks: string[] = [];
    await provider.streamChat(CHAT_INPUT, {
      onChunk: (chunk) => chunks.push(chunk),
    });

    expect(calls[0]?.url).toBe("https://endpoint.test/v1/responses");
    expect(calls[0]?.body.stream).toBe(true);
    expect(chunks).toEqual(["ok"]);
  });

  test("defaults to Chat Completions when wireApi is omitted", async () => {
    const calls = stubFetch({
      choices: [{ message: { content: "ok", role: "assistant" } }],
      usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
    });
    const provider = createOpenAICompatibleProvider({
      apiKey: "k",
      baseUrl: "https://endpoint.test/v1",
      displayName: "Endpoint",
      model: "gpt-5.4",
      supportsThinking: true,
    });

    await provider.generateChat(CHAT_INPUT);

    expect(calls[0]?.url).toContain("/chat/completions");
    expect(calls[0]?.body.reasoning).toBeUndefined();
    expect(calls[0]?.init?.idleTimeout).toBe(0);
  });

  test("preserves configured xhigh reasoning effort on the Responses wire", async () => {
    const calls = stubFetch(RESPONSE_PAYLOAD);
    const provider = createOpenAICompatibleProvider({
      apiKey: "k",
      baseUrl: "https://endpoint.test/v1",
      displayName: "Endpoint",
      model: "reasoning-model",
      reasoningEffortValues: ["low", "medium", "high", "xhigh"],
      supportsThinking: true,
      wireApi: "responses",
    });

    await provider.generateChat({
      ...CHAT_INPUT,
      providerOptions: { thinking: { effort: "xhigh", enabled: true } },
    });

    expect(calls[0]?.body.reasoning).toEqual({
      effort: "xhigh",
      summary: "auto",
    });
  });

  test("adds the text-only instruction for Responses generateText", async () => {
    const calls = stubFetch(RESPONSE_PAYLOAD);
    const provider = createOpenAICompatibleProvider({
      apiKey: "k",
      baseUrl: "https://endpoint.test/v1",
      displayName: "Endpoint",
      model: "text-model",
      supportsThinking: false,
      wireApi: "responses",
    });

    await provider.generateText({
      format: "text",
      prompt: "Write a title",
      system: "Be concise.",
    });

    expect(calls[0]?.body.instructions).toContain(
      "Return only the requested text"
    );
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { createOpenCodeGoProvider } from "./index";

const ORIGINAL_FETCH = globalThis.fetch;

function mockFetch(
  handler: (request: Request) => Promise<Response> | Response
): void {
  const mockFn: typeof fetch = (input, init?) => {
    const request = new Request(input, init);
    return Promise.resolve(handler(request));
  };
  globalThis.fetch = mockFn;
}

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("createOpenCodeGoProvider", () => {
  test("routes chat-completions models to the OpenAI-compatible endpoint", async () => {
    let capturedUrl: string | null = null;
    let capturedBody: Record<string, unknown> | null = null;

    mockFetch(async (request) => {
      capturedUrl = request.url;
      capturedBody = (await request.json()) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "Hello from OpenCode Go" } }],
        }),
        { headers: { "Content-Type": "application/json" }, status: 200 }
      );
    });

    const provider = createOpenCodeGoProvider({
      apiKey: "test",
      model: "opencode-go/kimi-k2.7-code",
    });

    const result = await provider.generateChat({
      messages: [{ content: "Hi", role: "user" }],
      system: "You are a helpful assistant.",
    });

    expect(capturedUrl).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    expect(capturedBody?.model).toBe("kimi-k2.7-code");
    expect(result.content).toBe("Hello from OpenCode Go");
  });

  test("sends x-opencode-session on chat completions", async () => {
    let capturedSession: string | null = null;

    mockFetch((request) => {
      capturedSession = request.headers.get("x-opencode-session");
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
        }),
        { headers: { "Content-Type": "application/json" }, status: 200 }
      );
    });

    const provider = createOpenCodeGoProvider({
      apiKey: "test",
      model: "opencode-go/kimi-k2.7-code",
      providerInstanceId: "harness-eval",
    });

    await provider.generateChat({
      messages: [{ content: "Hi", role: "user" }],
      system: "You are a helpful assistant.",
    });

    expect(capturedSession).toBe("atlas-opencode-go-harness-eval");
  });

  test("uses the Atlas conversation id as the OpenCode session", async () => {
    let capturedSession: string | null = null;

    mockFetch((request) => {
      capturedSession = request.headers.get("x-opencode-session");
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
        }),
        { headers: { "Content-Type": "application/json" }, status: 200 }
      );
    });

    const provider = createOpenCodeGoProvider({
      apiKey: "test",
      model: "opencode-go/kimi-k2.7-code",
    });

    await provider.generateChat({
      conversationId: "sess_live_turn",
      messages: [{ content: "Hi", role: "user" }],
      system: "You are a helpful assistant.",
    });

    expect(capturedSession).toBe("sess_live_turn");
  });

  test("sends x-opencode-session on the Anthropic-style messages path", async () => {
    let capturedSession: string | null = null;

    mockFetch((request) => {
      capturedSession = request.headers.get("x-opencode-session");
      return new Response(
        JSON.stringify({
          content: [{ text: "ok", type: "text" }],
          id: "msg_test",
          model: "qwen3.8-max",
          role: "assistant",
          stop_reason: "end_turn",
          type: "message",
        }),
        { headers: { "Content-Type": "application/json" }, status: 200 }
      );
    });

    const provider = createOpenCodeGoProvider({
      apiKey: "test",
      model: "opencode-go/qwen3.8-max",
    });

    await provider.generateChat({
      messages: [{ content: "Hi", role: "user" }],
      system: "You are a helpful assistant.",
    });

    expect(capturedSession).toBe("atlas-opencode-go");
  });

  test("sends x-opencode-session on the Responses path", async () => {
    let capturedSession: string | null = null;

    mockFetch((request) => {
      capturedSession = request.headers.get("x-opencode-session");
      return new Response(
        JSON.stringify({
          output: [
            {
              content: [{ text: "ok", type: "output_text" }],
              type: "message",
            },
          ],
        }),
        { headers: { "Content-Type": "application/json" }, status: 200 }
      );
    });

    const provider = createOpenCodeGoProvider({
      apiKey: "test",
      model: "opencode-go/grok-4.5",
    });

    await provider.generateChat({
      messages: [{ content: "Hi", role: "user" }],
      system: "You are a helpful assistant.",
    });

    expect(capturedSession).toBe("atlas-opencode-go");
  });

  test("does not copy upstream DeepSeek reasoning assumptions into the Go gateway", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    mockFetch(async (request) => {
      capturedBody = (await request.json()) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
        }),
        { headers: { "Content-Type": "application/json" }, status: 200 }
      );
    });

    const provider = createOpenCodeGoProvider({
      apiKey: "test",
      model: "opencode-go/deepseek-v4-flash",
    });

    await provider.generateChat({
      messages: [{ content: "Hi", role: "user" }],
      providerOptions: { thinking: { effort: "high", enabled: true } },
      system: "You are a helpful assistant.",
      tools: [
        {
          description: "Ping",
          name: "ping",
          parameters: { properties: {}, type: "object" },
        },
      ],
    });

    expect(capturedBody?.thinking).toBeUndefined();
    expect(capturedBody?.reasoning_effort).toBeUndefined();
    expect(capturedBody?.tools).toEqual([
      {
        function: {
          description: "Ping",
          name: "ping",
          parameters: { properties: {}, type: "object" },
        },
        type: "function",
      },
    ]);
  });

  test("does not send DeepSeek thinking on other OpenCode Go chat models", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    mockFetch(async (request) => {
      capturedBody = (await request.json()) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
        }),
        { headers: { "Content-Type": "application/json" }, status: 200 }
      );
    });

    const provider = createOpenCodeGoProvider({
      apiKey: "test",
      model: "opencode-go/kimi-k2.7-code",
    });

    await provider.generateChat({
      messages: [{ content: "Hi", role: "user" }],
      providerOptions: { thinking: { effort: "high", enabled: true } },
      system: "You are a helpful assistant.",
    });

    expect(capturedBody?.thinking).toBeUndefined();
    expect(capturedBody?.reasoning_effort).toBeUndefined();
  });

  test("strips the catalog prefix from already-bare chat model ids", async () => {
    let capturedBody: Record<string, unknown> | null = null;

    mockFetch(async (request) => {
      capturedBody = (await request.json()) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
        }),
        { headers: { "Content-Type": "application/json" }, status: 200 }
      );
    });

    const provider = createOpenCodeGoProvider({
      apiKey: "test",
      model: "kimi-k2.7-code",
    });

    await provider.generateChat({
      messages: [{ content: "Hi", role: "user" }],
      system: "You are a helpful assistant.",
    });

    expect(capturedBody?.model).toBe("kimi-k2.7-code");
  });

  test("routes messages models to the Anthropic-style endpoint", async () => {
    let capturedUrl: string | null = null;
    let capturedBody: Record<string, unknown> | null = null;

    mockFetch(async (request) => {
      capturedUrl = request.url;
      capturedBody = (await request.json()) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          content: [{ text: "Hello from messages", type: "text" }],
          id: "msg_test",
          model: "qwen3.7-max",
          role: "assistant",
          stop_reason: "end_turn",
          type: "message",
        }),
        { headers: { "Content-Type": "application/json" }, status: 200 }
      );
    });

    const provider = createOpenCodeGoProvider({
      apiKey: "test",
      model: "opencode-go/qwen3.7-max",
    });

    const result = await provider.generateChat({
      messages: [{ content: "Hi", role: "user" }],
      system: "You are a helpful assistant.",
    });

    expect(capturedUrl).toBe("https://opencode.ai/zen/go/v1/messages");
    expect(capturedBody?.model).toBe("qwen3.7-max");
    expect(result.content).toBe("Hello from messages");
  });

  test("routes qwen3.8-max to the Anthropic-style endpoint", async () => {
    let capturedUrl: string | null = null;

    mockFetch((request) => {
      capturedUrl = request.url;
      return new Response(
        JSON.stringify({
          content: [{ text: "ok", type: "text" }],
          id: "msg_test",
          model: "qwen3.8-max",
          role: "assistant",
          stop_reason: "end_turn",
          type: "message",
        }),
        { headers: { "Content-Type": "application/json" }, status: 200 }
      );
    });

    const provider = createOpenCodeGoProvider({
      apiKey: "test",
      model: "opencode-go/qwen3.8-max",
    });

    await provider.generateChat({
      messages: [{ content: "Hi", role: "user" }],
      system: "You are a helpful assistant.",
    });

    expect(capturedUrl).toBe("https://opencode.ai/zen/go/v1/messages");
  });

  test("routes Responses models to the OpenAI-style responses endpoint", async () => {
    let capturedUrl: string | null = null;
    let capturedBody: Record<string, unknown> | null = null;

    mockFetch(async (request) => {
      capturedUrl = request.url;
      capturedBody = (await request.json()) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          output: [
            {
              content: [{ text: "Hello from responses", type: "output_text" }],
              type: "message",
            },
          ],
        }),
        { headers: { "Content-Type": "application/json" }, status: 200 }
      );
    });

    const provider = createOpenCodeGoProvider({
      apiKey: "test",
      model: "opencode-go/grok-4.5",
    });

    const result = await provider.generateChat({
      messages: [{ content: "Hi", role: "user" }],
      system: "You are a helpful assistant.",
    });

    expect(capturedUrl).toBe("https://opencode.ai/zen/go/v1/responses");
    expect(capturedBody?.model).toBe("grok-4.5");
    expect(result.content).toBe("Hello from responses");
  });
});

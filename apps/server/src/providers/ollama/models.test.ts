import { afterEach, describe, expect, mock, test } from "bun:test";
import { fetchOllamaModels, parseOllamaModelDetails } from "./models";

const ORIGINAL_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("fetchOllamaModels", () => {
  test("uses /v1/models when available", async () => {
    const fetchMock = mock(async (input: string | URL) => {
      const url = String(input);

      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "llama3" }] }), {
          status: 200,
        });
      }

      throw new Error(`unexpected fetch: ${url}`);
    });

    globalThis.fetch = fetchMock as typeof fetch;

    const models = await fetchOllamaModels("http://localhost:11434/v1", "", {
      hostMode: "local",
    });

    expect(models).toEqual([{ id: "llama3", name: "llama3" }]);
  });

  test("falls back to /api/tags when /v1/models fails", async () => {
    const fetchMock = mock(async (input: string | URL) => {
      const url = String(input);

      if (url.endsWith("/models")) {
        return new Response("fail", { status: 500 });
      }

      if (url.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({
            models: [{ name: "gemma3:latest" }, { model: "llama3" }],
          }),
          { status: 200 }
        );
      }

      throw new Error(`unexpected fetch: ${url}`);
    });

    globalThis.fetch = fetchMock as typeof fetch;

    const models = await fetchOllamaModels("http://localhost:11434/v1", "", {
      hostMode: "local",
    });

    expect(models).toEqual([
      { id: "gemma3:latest", name: "gemma3:latest" },
      { id: "llama3", name: "llama3" },
    ]);
  });

  test("sends Authorization header to /api/tags when apiKey is set", async () => {
    const seen: string[] = [];
    const fetchMock = mock(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith("/models")) {
        return new Response("fail", { status: 500 });
      }

      if (url.endsWith("/api/tags")) {
        seen.push(
          String((init?.headers as Record<string, string>)?.Authorization ?? "")
        );
        return new Response(
          JSON.stringify({ models: [{ name: "gpt-oss:120b" }] }),
          {
            status: 200,
          }
        );
      }

      throw new Error(`unexpected fetch: ${url}`);
    });

    globalThis.fetch = fetchMock as typeof fetch;

    await fetchOllamaModels("https://8.8.8.8/v1", "secret-key", {
      hostMode: "cloud",
    });

    expect(seen).toEqual(["Bearer secret-key"]);
  });
});

describe("Ollama native metadata", () => {
  test("uses configured context and advertised capabilities without trained-window assumptions", () => {
    expect(
      parseOllamaModelDetails("custom", {
        capabilities: ["completion", "thinking", "tools"],
        model_info: {
          "general.architecture": "qwen",
          "qwen.context_length": 131_072,
        },
        parameters: "temperature 0.7\n num_ctx 8192\nnum_predict 512",
      })
    ).toMatchObject({
      capabilities: { "chat.tool-use": { status: "supported" } },
      contextWindow: 8192,
      supportsThinking: true,
      supportsVision: false,
    });
    const unknown = parseOllamaModelDetails("qwen-thinking-vision", {
      model_info: { "qwen.context_length": 131_072 },
    });
    expect(unknown).toEqual({ id: "qwen-thinking-vision" });
  });

  test("enriches compatible model rows with running context and native capabilities", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const models = await fetchOllamaModels("http://localhost:11434/v1", "", {
      fetch: async (input, init) => {
        const url = String(input);
        requests.push({ init, url });
        if (url.endsWith("/v1/models")) {
          return Response.json({ data: [{ id: "custom" }] });
        }
        if (url.endsWith("/api/ps")) {
          return Response.json({
            models: [{ context_length: 16_384, name: "custom" }],
          });
        }
        return Response.json({
          capabilities: ["completion", "vision"],
          parameters: "num_ctx 8192",
        });
      },
      hostMode: "local",
    });
    expect(models[0]).toMatchObject({
      contextWindow: 16_384,
      supportsThinking: false,
      supportsVision: true,
    });
    const show = requests.find((request) => request.url.endsWith("/api/show"));
    expect(show?.init?.method).toBe("POST");
    expect(JSON.parse(String(show?.init?.body))).toEqual({ model: "custom" });
  });

  test("keeps compatible metadata when native endpoints are unavailable", async () => {
    const models = await fetchOllamaModels("http://localhost:11434/v1", "", {
      fetch: async (input) =>
        String(input).endsWith("/v1/models")
          ? Response.json({
              data: [
                {
                  context_length: 32_768,
                  id: "custom",
                  supports_reasoning: false,
                },
              ],
            })
          : new Response("Unavailable", { status: 404 }),
      hostMode: "local",
    });
    expect(models[0]).toMatchObject({
      contextWindow: 32_768,
      supportsThinking: false,
    });
  });

  test("does not swallow cancellation during metadata discovery", async () => {
    const controller = new AbortController();
    await expect(
      fetchOllamaModels("http://localhost:11434/v1", "", {
        fetch: async (input) => {
          if (String(input).endsWith("/v1/models")) {
            return Response.json({ data: [{ id: "custom" }] });
          }
          controller.abort();
          throw controller.signal.reason;
        },
        hostMode: "local",
        signal: controller.signal,
      })
    ).rejects.toThrow();
  });
});

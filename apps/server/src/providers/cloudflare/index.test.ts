import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  CLOUDFLARE_API_ROOT,
  createCloudflareProvider,
  resolveCloudflareBaseUrl,
} from "./index";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("Cloudflare Workers AI provider", () => {
  test("uses the account endpoint and bearer auth and parses tool calls", async () => {
    const fetchMock = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1/chat/completions"
        );
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          "Bearer test-key"
        );

        const body = JSON.parse(String(init?.body ?? "{}")) as {
          messages?: Array<{ content: string; role: string }>;
          model?: string;
          tools?: Array<{ function?: { name?: string } }>;
        };
        expect(body.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
        expect(body.messages?.[0]).toEqual({
          content: "You are helpful.",
          role: "system",
        });
        expect(body.tools?.[0]?.function?.name).toBe("lookup_weather");

        return Response.json({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    function: {
                      arguments: '{"city":"Jakarta"}',
                      name: "lookup_weather",
                    },
                    id: "call_cf_1",
                    type: "function",
                  },
                ],
              },
            },
          ],
          usage: { completion_tokens: 3, prompt_tokens: 5 },
        });
      }
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = createCloudflareProvider({
      accountId: "abc123",
      apiKey: "test-key",
      model: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    });
    const result = await provider.generateChat({
      messages: [{ content: "Check the weather", role: "user" }],
      system: "You are helpful.",
      tools: [
        {
          description: "Look up weather",
          name: "lookup_weather",
          parameters: {
            properties: { city: { type: "string" } },
            required: ["city"],
            type: "object",
          },
        },
      ],
    });

    expect(result.toolCalls).toEqual([
      {
        arguments: { city: "Jakarta" },
        id: "call_cf_1",
        name: "lookup_weather",
      },
    ]);
    expect(result.usage).toEqual({
      inputTokens: 5,
      outputTokens: 3,
      totalTokens: 8,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("prefers a provider instance URL over the environment account", () => {
    expect(
      resolveCloudflareBaseUrl("env-account", {
        apiKey: "key",
        baseUrl: `${CLOUDFLARE_API_ROOT}/stored-account/ai/v1`,
        createdAt: new Date(0).toISOString(),
        id: "cf-1",
        label: "Cloudflare Workers AI",
        type: "cloudflare",
      })
    ).toBe(`${CLOUDFLARE_API_ROOT}/stored-account/ai/v1`);
  });

  test("falls back to the environment account ID", () => {
    expect(resolveCloudflareBaseUrl("env-account")).toBe(
      `${CLOUDFLARE_API_ROOT}/env-account/ai/v1`
    );
  });

  test("rejects missing account configuration and API keys", () => {
    expect(() => resolveCloudflareBaseUrl("")).toThrow(/account ID/i);
    expect(() =>
      createCloudflareProvider({
        accountId: "abc123",
        apiKey: "",
        model: "@cf/meta/llama-3.1-8b-instruct",
      })
    ).toThrow(/API key/i);
  });
});

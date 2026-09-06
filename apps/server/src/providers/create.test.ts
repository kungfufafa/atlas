import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ProviderInstance, ProviderName } from "@atlas/core";
import { applyProviderInstanceUpdate } from "../services/provider-instance-helpers";
import { createProviderForInstance } from "./create";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const DISCOVERY_PROVIDERS: Array<{
  model: string;
  type: Extract<
    ProviderName,
    "minimax" | "minimax_cn" | "xai" | "zhipu" | "zhipu_cn"
  >;
}> = [
  { model: "MiniMax-M3", type: "minimax" },
  { model: "MiniMax-M3", type: "minimax_cn" },
  { model: "grok-4", type: "xai" },
  { model: "glm-5", type: "zhipu" },
  { model: "glm-5", type: "zhipu_cn" },
];

describe("createProviderForInstance discovery-provider routing", () => {
  test("uses each configured endpoint, API key, and model", async () => {
    const requests: Array<{
      authorization: string;
      idleTimeout?: number;
      model: string;
      path: string;
    }> = [];
    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          model?: string;
        };
        requests.push({
          authorization: new Headers(init?.headers).get("authorization") ?? "",
          idleTimeout: (init as RequestInit & { idleTimeout?: number })
            ?.idleTimeout,
          model: body.model ?? "",
          path: new URL(String(input)).pathname,
        });
        return Response.json({
          choices: [
            {
              finish_reason: "stop",
              index: 0,
              message: { content: "ok", role: "assistant" },
            },
          ],
          created: 1,
          id: "mock",
          model: body.model,
          object: "chat.completion",
          usage: {
            completion_tokens: 1,
            prompt_tokens: 1,
            total_tokens: 2,
          },
        });
      }
    ) as unknown as typeof fetch;

    for (const entry of DISCOVERY_PROVIDERS) {
      const instance: ProviderInstance = {
        apiKey: `key-${entry.type}`,
        baseUrl: `https://endpoint.test/${entry.type}/v1`,
        createdAt: new Date(0).toISOString(),
        customModels: [{ default: true, id: entry.model }],
        id: `instance-${entry.type}`,
        label: entry.type,
        type: entry.type,
      };
      const provider = createProviderForInstance(instance, entry.model);

      expect(provider?.name).toBe(entry.type);
      expect(
        await provider?.generateChat({
          messages: [{ content: "ping", role: "user" }],
        })
      ).toMatchObject({ content: "ok" });
    }

    expect(requests).toEqual(
      DISCOVERY_PROVIDERS.map((entry) => ({
        authorization: `Bearer key-${entry.type}`,
        idleTimeout: 0,
        model: entry.model,
        path: `/${entry.type}/v1/chat/completions`,
      }))
    );
  });

  test("does not reuse a stored replay revision for an environment-sourced key", async () => {
    globalThis.fetch = mock(async () =>
      Response.json({
        output: [
          {
            content: [{ text: "ok", type: "output_text" }],
            role: "assistant",
            type: "message",
          },
        ],
        status: "completed",
      })
    ) as unknown as typeof fetch;
    const instance: ProviderInstance = {
      apiKey: "",
      createdAt: "2026-08-26T00:00:00.000Z",
      id: "openai-env",
      label: "OpenAI",
      replayRevision: "persisted-revision",
      type: "openai",
    };
    const provider = createProviderForInstance(instance, "gpt-5.3-codex", {
      OPENAI_API_KEY: "environment-key",
    });

    const result = await provider!.generateChat({
      messages: [{ content: "ping", role: "user" }],
      system: "system",
    });
    const rotatedProvider = createProviderForInstance(
      instance,
      "gpt-5.3-codex",
      {
        OPENAI_API_KEY: "rotated-environment-key",
      }
    );
    const rotatedResult = await rotatedProvider!.generateChat({
      messages: [{ content: "ping", role: "user" }],
      system: "system",
    });

    expect(
      result.assistantMessage.providerContentProvenance?.providerReplayRevision
    ).not.toBe("persisted-revision");
    expect(
      rotatedResult.assistantMessage.providerContentProvenance
        ?.providerReplayRevision
    ).not.toBe(
      result.assistantMessage.providerContentProvenance?.providerReplayRevision
    );
  });

  test("rotates replay provenance when an environment-backed endpoint changes", async () => {
    const requestBodies: string[] = [];
    globalThis.fetch = mock(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBodies.push(String(init?.body ?? ""));
        return Response.json({
          output: [
            {
              content: [{ text: "ok", type: "output_text" }],
              id: `endpoint-item-${requestBodies.length}`,
              role: "assistant",
              type: "message",
            },
          ],
          status: "completed",
        });
      }
    ) as unknown as typeof fetch;
    const original: ProviderInstance = {
      apiKey: "",
      baseUrl: "https://endpoint-a.example/v1",
      createdAt: "2026-08-26T00:00:00.000Z",
      customModels: [{ default: true, id: "responses-model" }],
      id: "compatible-env",
      label: "Compatible env",
      replayRevision: "stored-revision-a",
      type: "openai_compatible",
      wireApi: "responses",
    };
    const updated = applyProviderInstanceUpdate(original, {
      baseUrl: "https://endpoint-b.example/v1",
    });
    const env = { OPENAI_COMPATIBLE_API_KEY: "environment-key" };
    const firstProvider = createProviderForInstance(
      original,
      "responses-model",
      env
    );
    const first = await firstProvider!.generateChat({
      messages: [{ content: "first", role: "user" }],
    });
    const secondProvider = createProviderForInstance(
      updated,
      "responses-model",
      env
    );
    const second = await secondProvider!.generateChat({
      messages: [
        { content: "first", role: "user" },
        first.assistantMessage,
        { content: "continue", role: "user" },
      ],
    });

    expect(
      first.assistantMessage.providerContentProvenance?.providerReplayRevision
    ).not.toBe(
      second.assistantMessage.providerContentProvenance?.providerReplayRevision
    );
    expect(requestBodies[1]).not.toContain("endpoint-item-1");
  });
});

test.each([
  { baseUrl: "https://api.openai.com/v1", expectedEffort: "high" },
  { baseUrl: "https://proxy.example.com/v1", expectedEffort: undefined },
])(
  "provider factory keeps official metadata scoped to the exact endpoint: %j",
  async ({ baseUrl, expectedEffort }) => {
    let requestBody: Record<string, unknown> | undefined;
    globalThis.fetch = mock(
      async (_request: RequestInfo | URL, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body ?? "{}"));
        return Response.json({
          choices: [{ message: { content: "Done" } }],
          output: [
            {
              content: [{ text: "Done", type: "output_text" }],
              role: "assistant",
              type: "message",
            },
          ],
        });
      }
    ) as unknown as typeof fetch;
    const instance: ProviderInstance = {
      apiKey: "fixture",
      baseUrl,
      createdAt: "2026-09-06T00:00:00.000Z",
      customModels: [{ id: "gpt-5.4" }],
      id: "factory-metadata",
      label: "Configured endpoint",
      type: "openai",
    };
    const provider = createProviderForInstance(instance, "gpt-5.4");
    expect(provider).not.toBeNull();
    await provider!.generateChat({
      messages: [{ content: "Hi", role: "user" }],
      providerOptions: { thinking: { effort: "high", enabled: true } },
      system: "Answer",
    });
    expect(
      (requestBody?.reasoning as { effort?: string } | undefined)?.effort
    ).toBe(expectedEffort);
    expect(requestBody?.reasoning_effort).toBeUndefined();
  }
);

import { expect, test } from "bun:test";
import { canonicalSubscriptionModelSnapshot } from "../services/provider-validation-service";
import {
  fetchAnthropicModels,
  fetchGeminiModels,
  parseAnthropicModel,
  parseGeminiModel,
} from "./native-models";
import type { ProviderDiscoveryDnsResolver } from "./provider-discovery-safety";

const publicDns: ProviderDiscoveryDnsResolver = async () => [
  { address: "203.0.114.10", family: 4 },
];

test("Anthropic model metadata keeps native limits and exact thinking controls through save", () => {
  const entry = parseAnthropicModel({
    capabilities: {
      effort: {
        high: { supported: true },
        low: { supported: true },
        max: { supported: true },
        medium: { supported: true },
        supported: true,
        xhigh: { supported: false },
      },
      image_input: { supported: false },
      thinking: {
        supported: true,
        types: { adaptive: { supported: true }, enabled: { supported: false } },
      },
    },
    display_name: "Native model",
    id: "claude-native-model",
    max_input_tokens: 1_000_000,
    max_tokens: 64_000,
  });
  expect(entry).toMatchObject({
    capabilities: {
      "chat.reasoning": {
        constraints: { supportedValues: { "thinking.type": ["adaptive"] } },
      },
    },
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    reasoningEffortValues: ["low", "medium", "high", "max"],
    supportsThinking: true,
    supportsVision: false,
  });
  if (!entry) {
    throw new Error("Expected a model");
  }
  const [saved] = canonicalSubscriptionModelSnapshot([
    { ...entry, name: entry.name ?? entry.id, provider: "anthropic" },
  ]);
  expect(saved).toMatchObject(entry);
  expect(saved?.defaultReasoningEffort).toBeUndefined();
});

test("explicit unsupported effort survives normalization and persistence", () => {
  const entry = parseAnthropicModel({
    capabilities: {
      effort: { supported: false },
      thinking: { supported: false },
    },
    id: "claude-future",
  });
  if (!entry) {
    throw new Error("Expected a model");
  }
  expect(
    canonicalSubscriptionModelSnapshot([
      { ...entry, name: entry.id, provider: "anthropic" },
    ])[0]
  ).toMatchObject({
    reasoningEffortValues: [],
    supportsThinking: false,
  });
});

test("native APIs never fill absent or invalid limits from a recognizable model name", () => {
  expect(
    parseAnthropicModel({
      id: "claude-opus-4-6",
      max_input_tokens: -1,
      max_tokens: 0,
    })
  ).toEqual({ id: "claude-opus-4-6", name: "claude-opus-4-6" });
  const gemini = parseGeminiModel({
    inputTokenLimit: "1048576",
    name: "models/gemini-2.5-pro",
    outputTokenLimit: 1.5,
    supportedGenerationMethods: ["generateContent"],
  });
  expect(gemini?.contextWindow).toBeUndefined();
  expect(gemini?.maxOutputTokens).toBeUndefined();
  expect(gemini?.supportsThinking).toBeUndefined();
  expect(gemini?.reasoningEffortValues).toBeUndefined();
});

test("Gemini reports model limits and thinking without inventing effort levels", () => {
  const entry = parseGeminiModel({
    displayName: "Future",
    inputTokenLimit: 1_048_576,
    name: "models/gemini-future",
    outputTokenLimit: 65_536,
    supportedGenerationMethods: ["countTokens", "generateContent"],
    thinking: true,
  });
  expect(entry).toMatchObject({
    contextWindow: 1_048_576,
    id: "gemini-future",
    maxOutputTokens: 65_536,
    supportsThinking: true,
  });
  expect(entry?.reasoningEffortValues).toBeUndefined();
  expect(entry?.defaultReasoningEffort).toBeUndefined();
  expect(entry?.supportsVision).toBeUndefined();
  expect(
    parseGeminiModel({
      name: "models/embedding",
      supportedGenerationMethods: ["embedContent"],
    })
  ).toBeNull();
});

test("Anthropic discovery paginates with native auth and retains both model records", async () => {
  const requests: string[] = [];
  const models = await fetchAnthropicModels(
    "https://anthropic.example.test",
    "test-key",
    {
      fetch: async (input, init) => {
        const url = new URL(String(input));
        requests.push(url.toString());
        const headers = new Headers(init?.headers);
        expect(headers.get("x-api-key")).toBe("test-key");
        expect(headers.get("anthropic-version")).toBe("2023-06-01");
        expect(headers.has("authorization")).toBe(false);
        return Response.json(
          requests.length === 1
            ? {
                data: [{ id: "one", max_input_tokens: 1000 }],
                has_more: true,
                last_id: "one",
              }
            : { data: [{ id: "two", max_input_tokens: 2000 }], has_more: false }
        );
      },
      resolveDns: publicDns,
    }
  );
  expect(requests).toEqual([
    "https://anthropic.example.test/v1/models",
    "https://anthropic.example.test/v1/models?after_id=one",
  ]);
  expect(models.map((entry) => [entry.id, entry.contextWindow])).toEqual([
    ["one", 1000],
    ["two", 2000],
  ]);
});

test("Gemini discovery follows nextPageToken and does not expose keys in URL", async () => {
  let calls = 0;
  const models = await fetchGeminiModels(
    "https://gemini.example.test/v1beta",
    "test-key",
    {
      fetch: async (input, init) => {
        calls += 1;
        const url = new URL(String(input));
        expect(url.pathname).toBe("/v1beta/models");
        expect(url.searchParams.has("key")).toBe(false);
        expect(new Headers(init?.headers).get("x-goog-api-key")).toBe(
          "test-key"
        );
        if (calls === 2) {
          expect(url.searchParams.get("pageToken")).toBe("next");
        }
        return Response.json(
          calls === 1
            ? {
                models: [
                  {
                    name: "models/embedding",
                    supportedGenerationMethods: ["embedContent"],
                  },
                ],
                nextPageToken: "next",
              }
            : {
                models: [
                  {
                    name: "models/chat",
                    supportedGenerationMethods: ["generateContent"],
                    thinking: false,
                  },
                ],
              }
        );
      },
      resolveDns: publicDns,
    }
  );
  expect(models.map((entry) => entry.id)).toEqual(["chat"]);
  expect(models[0]?.supportsThinking).toBe(false);
  expect(calls).toBe(2);
});

test("discovery failures do not return a partial or guessed model catalog", async () => {
  let calls = 0;
  await expect(
    fetchAnthropicModels("https://anthropic.example.test/v1", "test-key", {
      fetch: async () => {
        calls += 1;
        return Response.json({
          data: [{ id: "one" }],
          has_more: true,
          last_id: "one",
        });
      },
      resolveDns: publicDns,
    })
  ).rejects.toThrow();
  expect(calls).toBe(2);
  await expect(
    fetchGeminiModels("https://gemini.example.test", "test-key", {
      fetch: async () => new Response(null, { status: 401 }),
      resolveDns: publicDns,
    })
  ).rejects.toThrow();
  await expect(
    fetchAnthropicModels("https://anthropic.example.test", "test-key", {
      fetch: async () => Response.json({ data: [], has_more: true }),
      resolveDns: publicDns,
    })
  ).rejects.toThrow();
});

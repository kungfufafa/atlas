import { afterEach, describe, expect, test } from "bun:test";
import {
  fetchOpenCodeGoGatewayModels,
  getModelsForOpenCodeGoInstance,
  OPENCODE_GO_MODELS_URL,
  resetOpenCodeGoCatalogCacheForTests,
  toOpenCodeGoCatalogModelId,
} from "./catalog";

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  resetOpenCodeGoCatalogCacheForTests();
});

describe("toOpenCodeGoCatalogModelId", () => {
  test("prefixes bare API ids and keeps catalog ids", () => {
    expect(toOpenCodeGoCatalogModelId("kimi-k2.7-code")).toBe(
      "opencode-go/kimi-k2.7-code"
    );
    expect(toOpenCodeGoCatalogModelId("opencode-go/glm-5.3")).toBe(
      "opencode-go/glm-5.3"
    );
  });
});

describe("fetchOpenCodeGoGatewayModels", () => {
  test("maps the official /v1/models list onto catalog ids", async () => {
    globalThis.fetch = (async (input) => {
      expect(String(input)).toBe(OPENCODE_GO_MODELS_URL);
      return new Response(
        JSON.stringify({
          data: [
            { id: "glm-5.3", object: "model" },
            { id: "kimi-k2.7-code", object: "model" },
            { id: "qwen3.8-max", object: "model" },
            { id: "deepseek-v4-flash-vision-exp", object: "model" },
          ],
          object: "list",
        }),
        { headers: { "Content-Type": "application/json" }, status: 200 }
      );
    }) as typeof fetch;

    const entries = await fetchOpenCodeGoGatewayModels();
    const ids = entries.map((entry) => entry.id);

    expect(ids).toContain("opencode-go/glm-5.3");
    expect(ids).toContain("opencode-go/kimi-k2.7-code");
    expect(ids).toContain("opencode-go/qwen3.8-max");
    expect(
      entries.find((entry) => entry.id === "opencode-go/kimi-k2.7-code")
        ?.default
    ).toBe(true);
    expect(
      entries.find((entry) => entry.id === "opencode-go/kimi-k2.7-code")?.name
    ).toBe("Kimi K2.7 Code");
    expect(
      entries.find((entry) => entry.id === "opencode-go/kimi-k2.7-code")
        ?.capabilities?.["chat.tool-use"]
    ).toBeUndefined();
    expect(
      entries.find((entry) => entry.id === "opencode-go/glm-5.3")
        ?.supportsThinking
    ).toBeUndefined();
    expect(
      entries.find(
        (entry) => entry.id === "opencode-go/deepseek-v4-flash-vision-exp"
      )?.supportsVision
    ).toBeUndefined();
    expect(
      entries.find(
        (entry) => entry.id === "opencode-go/deepseek-v4-flash-vision-exp"
      )?.capabilities?.["chat.input.image"]
    ).toBeUndefined();
    expect(
      entries.find((entry) => entry.id === "opencode-go/kimi-k2.7-code")
        ?.capabilities?.["chat.input.image"]
    ).toBeUndefined();
  });

  test("retains metadata supplied in model rows", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              capabilities: { tools: false },
              context_length: 65_536,
              id: "custom",
              max_output_tokens: 4096,
              reasoningEffortValues: [],
              supportsThinking: false,
            },
          ],
        })
      )) as typeof fetch;
    const [entry] = await fetchOpenCodeGoGatewayModels();
    expect(entry).toMatchObject({
      capabilities: { "chat.tool-use": { status: "unsupported" } },
      contextWindow: 65_536,
      id: "opencode-go/custom",
      maxOutputTokens: 4096,
      reasoningEffortValues: [],
      supportsThinking: false,
    });
  });

  test("reuses the cached catalog within the TTL", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ data: [{ id: "hy3" }], object: "list" }),
        { headers: { "Content-Type": "application/json" }, status: 200 }
      );
    }) as typeof fetch;

    const first = await fetchOpenCodeGoGatewayModels();
    const second = await fetchOpenCodeGoGatewayModels();

    expect(calls).toBe(1);
    expect(first).toEqual(second);
    expect(first[0]?.id).toBe("opencode-go/hy3");
    expect(first[0]?.default).toBe(true);
  });
});

describe("getModelsForOpenCodeGoInstance", () => {
  test("uses the live official catalog when no shortlist is saved", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [{ id: "glm-5.3" }, { id: "kimi-k3" }],
          object: "list",
        }),
        { headers: { "Content-Type": "application/json" }, status: 200 }
      )) as typeof fetch;

    const models = await getModelsForOpenCodeGoInstance({
      apiKey: "sk-test",
      createdAt: "2026-06-07T10:00:00.000Z",
      id: "go-1",
      label: "OpenCode Go",
      type: "opencode_go",
    });

    expect(models.map((model) => model.id)).toEqual([
      "opencode-go/glm-5.3",
      "opencode-go/kimi-k3",
    ]);
    expect(models[0]?.providerId).toBe("go-1");
  });

  test("refreshes saved discovery metadata from the exact live model", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        data: [
          {
            context_length: 131_072,
            id: "custom",
            reasoningEffortValues: ["low", "high"],
            supportsThinking: true,
          },
        ],
      })) as typeof fetch;
    const instance = {
      apiKey: "sk-test",
      createdAt: "2026-06-07T10:00:00.000Z",
      id: "go-1",
      label: "OpenCode Go",
      type: "opencode_go" as const,
    };
    const [configured] = await getModelsForOpenCodeGoInstance({
      ...instance,
      customModels: [
        {
          contextWindow: 16_384,
          id: "custom",
          reasoningEffortValues: [],
          supportsThinking: false,
        },
      ],
    });
    const [other] = await getModelsForOpenCodeGoInstance({
      ...instance,
      id: "go-2",
    });
    expect(configured).toMatchObject({
      contextWindow: 131_072,
      id: "opencode-go/custom",
      reasoningEffortValues: ["low", "high"],
      supportsThinking: true,
    });
    expect(other).toMatchObject({
      contextWindow: 131_072,
      reasoningEffortValues: ["low", "high"],
      supportsThinking: true,
    });
  });

  test("honors live negative declarations, omitted limits, and explicit admin capability overrides", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        data: [
          {
            capabilities: { tools: false, vision: false },
            context_length: 32_768,
            id: "custom",
            reasoningEffortValues: [],
            supportsThinking: false,
          },
        ],
      })) as typeof fetch;
    const [model] = await getModelsForOpenCodeGoInstance({
      apiKey: "sk-test",
      createdAt: "2026-06-07T10:00:00.000Z",
      customModels: [
        {
          capabilities: {
            "chat.input.image": {
              source: "provider-discovery",
              status: "supported",
              verified: true,
            },
            "chat.tool-use": {
              source: "admin-override",
              status: "supported",
              verified: true,
            },
          },
          contextWindow: 131_072,
          default: true,
          defaultReasoningEffort: "high",
          id: "custom",
          maxOutputTokens: 8192,
          name: "My selected model",
          reasoningEffortValues: ["low", "high"],
          supportsThinking: true,
          supportsVision: true,
        },
      ],
      id: "go-1",
      label: "OpenCode Go",
      type: "opencode_go",
    });
    expect(model).toMatchObject({
      capabilities: {
        "chat.input.image": {
          source: "provider-discovery",
          status: "unsupported",
        },
        "chat.tool-use": {
          source: "admin-override",
          status: "supported",
        },
      },
      contextWindow: 32_768,
      default: true,
      maxOutputTokens: 8192,
      name: "My selected model",
      reasoningEffortValues: [],
      supportsThinking: false,
      supportsVision: false,
    });
    expect(model?.defaultReasoningEffort).toBeUndefined();
  });

  test("keeps the live catalog when a default shortlist is saved", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "glm-5.3" },
            { id: "kimi-k3" },
            { id: "deepseek-v4-flash" },
          ],
          object: "list",
        }),
        { headers: { "Content-Type": "application/json" }, status: 200 }
      )) as typeof fetch;

    const models = await getModelsForOpenCodeGoInstance({
      apiKey: "sk-test",
      createdAt: "2026-06-07T10:00:00.000Z",
      customModels: [{ id: "opencode-go/deepseek-v4-flash" }],
      id: "go-1",
      label: "OpenCode Go",
      type: "opencode_go",
    });

    expect(models.map((model) => model.id)).toEqual([
      "opencode-go/deepseek-v4-flash",
      "opencode-go/glm-5.3",
      "opencode-go/kimi-k3",
    ]);
    expect(
      models.find((model) => model.id === "opencode-go/deepseek-v4-flash")
        ?.default
    ).toBe(true);
    expect(
      models.find((model) => model.id === "opencode-go/glm-5.3")?.default
    ).toBeFalsy();
  });
});

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
    ).toMatchObject({ status: "supported", verified: true });
    expect(
      entries.find((entry) => entry.id === "opencode-go/glm-5.3")
        ?.supportsThinking
    ).toBe(true);
    expect(
      entries.find(
        (entry) => entry.id === "opencode-go/deepseek-v4-flash-vision-exp"
      )?.supportsVision
    ).toBe(true);
    expect(
      entries.find(
        (entry) => entry.id === "opencode-go/deepseek-v4-flash-vision-exp"
      )?.capabilities?.["chat.input.image"]
    ).toMatchObject({ status: "supported" });
    expect(
      entries.find((entry) => entry.id === "opencode-go/kimi-k2.7-code")
        ?.capabilities?.["chat.input.image"]
    ).toBeUndefined();
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

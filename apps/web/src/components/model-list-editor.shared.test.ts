import { describe, expect, test } from "bun:test";
import {
  applyInferredCompatibleCapabilities,
  clearConnectionModelMetadata,
  modelListRowVisionEnabled,
  normalizeModelListRows,
  toggleModelListRow,
} from "./model-list-editor.shared";
import {
  seedManageModelRows,
  seedShortlistManageModelRows,
} from "./settings/provider-settings-seed";

describe("applyInferredCompatibleCapabilities", () => {
  test("leaves reasoning unknown when only a model id is supplied", () => {
    expect(
      applyInferredCompatibleCapabilities(
        [{ id: "qwen/qwen3.8-max-free", name: "Qwen" }],
        { baseUrl: "https://api.tokenrouter.com/v1" }
      )
    ).toEqual([
      {
        id: "qwen/qwen3.8-max-free",
        name: "Qwen",
      },
    ]);
  });

  test("does not override an explicit opt-out", () => {
    expect(
      applyInferredCompatibleCapabilities([
        {
          id: "qwen/qwen3.8-max-free",
          supportsThinking: false,
        },
      ])
    ).toEqual([{ id: "qwen/qwen3.8-max-free", supportsThinking: false }]);
  });
});

describe("toggleModelListRow", () => {
  test("adds a model and drops blank placeholder rows", () => {
    expect(
      toggleModelListRow([{ id: "", name: "" }], {
        id: "llama3.2",
        name: "Llama 3.2",
      })
    ).toEqual([{ id: "llama3.2", name: "Llama 3.2" }]);
  });

  test("removes a model that is already selected", () => {
    expect(
      toggleModelListRow(
        [
          { id: "llama3.2", name: "Llama 3.2" },
          { id: "qwen3", name: "Qwen 3" },
        ],
        { id: "llama3.2", name: "Llama 3.2" }
      )
    ).toEqual([{ id: "qwen3", name: "Qwen 3" }]);
  });
});

describe("modelListRowVisionEnabled", () => {
  test("uses the provider default only when vision is not explicit", () => {
    expect(modelListRowVisionEnabled({}, true)).toBe(true);
    expect(modelListRowVisionEnabled({ supportsVision: false }, true)).toBe(
      false
    );
    expect(modelListRowVisionEnabled({}, false)).toBe(false);
    expect(modelListRowVisionEnabled({ supportsVision: true }, false)).toBe(
      true
    );
  });
});

describe("normalizeModelListRows", () => {
  test("preserves generic provider capability claims for saving", () => {
    const capabilities = {
      "audio.transcription": {
        source: "provider-discovery" as const,
        status: "supported" as const,
        verified: true,
      },
      "vendor.custom-operation": {
        source: "provider-discovery" as const,
        status: "unknown" as const,
      },
    };
    const normalized = normalizeModelListRows([
      {
        capabilities,
        id: "  provider/generic-model  ",
        name: "  Generic Model  ",
      },
    ]);

    expect(normalized).toEqual([
      {
        capabilities,
        id: "provider/generic-model",
        name: "Generic Model",
      },
    ]);
  });

  test("preserves reasoningEffortValues array and cleans empty items", () => {
    const normalized = normalizeModelListRows([
      {
        id: "qwen/qwen3.8-max-free",
        name: "Qwen 3.8 Max Free",
        reasoningEffortValues: ["low", "medium", "xhigh"],
        supportsThinking: true,
      },
    ]);

    expect(normalized).toEqual([
      {
        id: "qwen/qwen3.8-max-free",
        name: "Qwen 3.8 Max Free",
        reasoningEffortValues: ["low", "medium", "xhigh"],
        supportsThinking: true,
      },
    ]);
  });

  test("parses string reasoningEffortValues into trimmed array", () => {
    const normalized = normalizeModelListRows([
      {
        id: "qwen/qwen3.8-max-free",
        name: "qwen/qwen3.8-max-free",
        // @ts-expect-error test raw string input
        reasoningEffortValues: "low, medium, high, xhigh",
        supportsThinking: true,
      },
    ]);

    expect(normalized).toEqual([
      {
        id: "qwen/qwen3.8-max-free",
        name: "qwen/qwen3.8-max-free",
        reasoningEffortValues: ["low", "medium", "high", "xhigh"],
        supportsThinking: true,
      },
    ]);
  });

  test("skips empty id rows", () => {
    const normalized = normalizeModelListRows([
      {
        id: "   ",
        name: "Empty",
      },
    ]);

    expect(normalized).toEqual([]);
  });
});

describe("provider-settings-seed", () => {
  test("seedManageModelRows preserves reasoningEffortValues", () => {
    const seeded = seedManageModelRows(
      [
        {
          id: "qwen/qwen3.8-max-free",
          reasoningEffortValues: ["low", "medium", "xhigh"],
          supportsThinking: true,
        },
      ],
      []
    );

    expect(seeded[0].reasoningEffortValues).toEqual(["low", "medium", "xhigh"]);
  });

  test("seedShortlistManageModelRows preserves reasoningEffortValues", () => {
    const seeded = seedShortlistManageModelRows([
      {
        id: "qwen/qwen3.8-max-free",
        reasoningEffortValues: ["low", "medium", "high"],
        supportsThinking: true,
      },
    ]);

    expect(seeded[0].reasoningEffortValues).toEqual(["low", "medium", "high"]);
  });

  test("preserves generic capability evidence while editing providers", () => {
    const capabilities = {
      "vendor.custom-operation": {
        source: "provider-discovery" as const,
        status: "supported" as const,
      },
    };
    const model = {
      capabilities,
      id: "vendor/model",
      supportsVision: true,
    };

    expect(seedManageModelRows([model], [])[0]).toEqual(
      expect.objectContaining({ capabilities, supportsVision: true })
    );
    expect(seedShortlistManageModelRows([model])[0]).toEqual(
      expect.objectContaining({ capabilities, supportsVision: true })
    );
  });
});

test("saving model rows keeps limits, defaults, and explicit empty efforts", () => {
  const row = {
    contextWindow: 98_000,
    defaultReasoningEffort: "high",
    id: "model",
    maxOutputTokens: 12_000,
    name: "Model",
    reasoningEffortValues: [],
    supportsThinking: false,
  };
  expect(normalizeModelListRows([row])).toEqual([row]);
  expect(seedManageModelRows([row], [])[0]).toMatchObject(row);
  expect(seedShortlistManageModelRows([row])[0]).toMatchObject(row);
});

test("changing connection removes old endpoint metadata while retaining explicit admin claims", () => {
  const admin = {
    source: "admin-override" as const,
    status: "unsupported" as const,
    verified: true,
  };
  const discovery = {
    source: "provider-discovery" as const,
    status: "supported" as const,
    verified: true,
  };
  expect(
    clearConnectionModelMetadata([
      {
        capabilities: {
          "chat.input.image": admin,
          "chat.reasoning": discovery,
        },
        contextWindow: 98_000,
        default: true,
        defaultReasoningEffort: "high",
        id: "model",
        maxOutputTokens: 12_000,
        name: "Model",
        reasoningEffortValues: ["high"],
        supportsThinking: true,
      },
    ])
  ).toEqual([
    {
      capabilities: { "chat.input.image": admin },
      default: true,
      id: "model",
      name: "Model",
    },
  ]);
});

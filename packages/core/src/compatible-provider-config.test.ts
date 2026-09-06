import { describe, expect, test } from "bun:test";
import {
  parseWireApi,
  validateCustomModels,
} from "./compatible-provider-config";

describe("parseWireApi", () => {
  test("persists Responses and defaults all other input to Chat", () => {
    expect(parseWireApi("responses")).toBe("responses");
    expect(parseWireApi("chat")).toBeUndefined();
    expect(parseWireApi("unknown")).toBeUndefined();
  });
});

describe("validateCustomModels", () => {
  test("preserves versioned capability claims", () => {
    const models = validateCustomModels([
      {
        capabilities: {
          "audio.transcription": {
            source: "admin-override",
            status: "supported",
            verified: false,
          },
        },
        id: "custom-asr",
      },
    ]);

    expect(models[0]?.capabilities?.["audio.transcription"]).toEqual({
      source: "admin-override",
      status: "supported",
      verified: false,
    });
  });

  test("accepts supportsThinking when it is boolean", () => {
    const models = validateCustomModels([
      {
        default: true,
        id: "qwen3.6-35b",
        name: "Qwen 3.6 35B",
        supportsThinking: true,
      },
    ]);

    expect(models[0]?.supportsThinking).toBe(true);
  });

  test("preserves a runtime reasoning default from the advertised values", () => {
    const models = validateCustomModels([
      {
        defaultReasoningEffort: " high ",
        id: "runtime-model",
        reasoningEffortValues: ["low", "high"],
      },
    ]);

    expect(models[0]).toMatchObject({
      defaultReasoningEffort: "high",
      reasoningEffortValues: ["low", "high"],
    });
  });

  test("rejects a reasoning default outside the advertised values", () => {
    expect(() =>
      validateCustomModels([
        {
          defaultReasoningEffort: "ultra",
          id: "runtime-model",
          reasoningEffortValues: ["low", "high"],
        },
      ])
    ).toThrow("default reasoning effort");
  });

  test("rejects non-boolean supportsThinking values", () => {
    expect(() =>
      validateCustomModels([
        {
          id: "qwen3.6-35b",
          supportsThinking: "yes",
        },
      ])
    ).toThrow('Model "qwen3.6-35b" has invalid supportsThinking flag.');
  });

  test("rejects model ids that collide after trimming", () => {
    expect(() =>
      validateCustomModels([{ id: "same" }, { id: " same " }])
    ).toThrow('Duplicate model id "same".');
  });
});

describe("custom model context metadata", () => {
  test("preserves context limits, explicit false and empty reasoning values", () => {
    const [entry] = validateCustomModels([
      {
        contextWindow: 65_536,
        id: "custom",
        maxOutputTokens: 4096,
        reasoningEffortValues: [],
        supportsThinking: false,
      },
    ]);
    expect(entry).toEqual({
      contextWindow: 65_536,
      id: "custom",
      maxOutputTokens: 4096,
      reasoningEffortValues: [],
      supportsThinking: false,
    });
  });

  test.each([0, -1, 1.5, "4096", Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid context/output limits %s",
    (value) => {
      expect(() =>
        validateCustomModels([{ contextWindow: value, id: "custom" }])
      ).toThrow();
      expect(() =>
        validateCustomModels([{ id: "custom", maxOutputTokens: value }])
      ).toThrow();
    }
  );

  test("rejects a default when the effort list is explicitly empty", () => {
    expect(() =>
      validateCustomModels([
        {
          defaultReasoningEffort: "high",
          id: "custom",
          reasoningEffortValues: [],
        },
      ])
    ).toThrow();
  });
});

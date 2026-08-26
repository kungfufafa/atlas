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

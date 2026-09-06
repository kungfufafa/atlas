import { describe, expect, test } from "bun:test";
import { serializeToolOutput } from "./result-serialization";

describe("tool output serialization", () => {
  test("preserves text and JSON output while giving empty results a valid JSON value", () => {
    expect(serializeToolOutput("plain output")).toEqual({
      data: "plain output",
      text: "plain output",
      warnings: [],
    });
    const data = {
      error: null,
      items: [1, "two", false],
      nested: { ok: true },
    };
    expect(serializeToolOutput(data)).toEqual({
      data,
      text: JSON.stringify(data),
      warnings: [],
    });
    expect(serializeToolOutput(undefined)).toEqual({
      data: null,
      text: "null",
      warnings: [],
    });
  });

  test("keeps exact BigInt values and distinguishes cycles from repeated references", () => {
    const shared = { count: 9007199254740993n };
    const cyclic: Record<string, unknown> = { first: shared, second: shared };
    cyclic.self = cyclic;

    const serialized = serializeToolOutput(cyclic);

    expect(serialized.data).toEqual({
      first: { count: "9007199254740993" },
      second: { count: "9007199254740993" },
      self: "[Circular]",
    });
    expect(JSON.parse(serialized.text)).toEqual(serialized.data);
    expect(serialized.warnings).toHaveLength(2);
  });

  test("reports unavailable output separately from handler failure", () => {
    const serialized = serializeToolOutput({
      toJSON() {
        throw new Error("Cannot serialize custom record");
      },
    });

    expect(serialized.data).toMatchObject({
      outputUnavailable: true,
      serializationError: "Cannot serialize custom record",
      toolExecutionCompleted: true,
    });
    expect(serialized.data).not.toHaveProperty("error");
    expect(JSON.parse(serialized.text)).toEqual(serialized.data);
  });
});

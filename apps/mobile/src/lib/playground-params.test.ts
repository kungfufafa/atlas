import { expect, test } from "bun:test";
import {
  buildExampleParametersJson,
  parseParametersJson,
} from "./playground-params";

test("builds example JSON from a simple schema", () => {
  expect(
    JSON.parse(
      buildExampleParametersJson({
        properties: {
          count: { type: "integer" },
          path: { type: "string" },
        },
        type: "object",
      })
    )
  ).toEqual({ count: 0, path: "" });
});

test("rejects non-object JSON", () => {
  expect(parseParametersJson("[1]")).toBeNull();
  expect(parseParametersJson("{")).toBeNull();
  expect(parseParametersJson('{"ok":true}')).toEqual({ ok: true });
});

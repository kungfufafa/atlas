import { describe, expect, test } from "bun:test";
import { toCodeFence } from "./artifact-code-fence";

describe("toCodeFence", () => {
  test("wraps source in a standard fence", () => {
    expect(toCodeFence("const x = 1;", "typescript")).toBe(
      "```typescript\nconst x = 1;\n```"
    );
  });

  test("lengthens the fence when the source contains a matching run", () => {
    expect(toCodeFence("see ```js inside", "markdown")).toBe(
      "````markdown\nsee ```js inside\n````"
    );
  });
});

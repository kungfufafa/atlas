import { describe, expect, test } from "bun:test";
import { InvalidThemeArgError, parseThemeArg } from "./theme-arg";

describe("parseThemeArg", () => {
  test("parses separate and equals-form theme values", () => {
    expect(parseThemeArg(["--theme", "light"])).toBe("light");
    expect(parseThemeArg(["chat", "--theme", "dark"])).toBe("dark");
    expect(parseThemeArg(["--theme=light"])).toBe("light");
    expect(parseThemeArg(["--theme=dark"])).toBe("dark");
  });

  test("returns null when the flag is absent", () => {
    expect(parseThemeArg(["chat"])).toBeNull();
    expect(parseThemeArg([])).toBeNull();
  });

  test("rejects unknown and missing theme values", () => {
    expect(() => parseThemeArg(["--theme", "sepia"])).toThrow(
      InvalidThemeArgError
    );
    expect(() => parseThemeArg(["--theme=neon"])).toThrow(InvalidThemeArgError);
    expect(() => parseThemeArg(["--theme"])).toThrow(InvalidThemeArgError);
  });
});

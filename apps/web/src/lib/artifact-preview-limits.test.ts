import { describe, expect, test } from "bun:test";
import {
  MAX_MARKDOWN_PREVIEW_CHARS,
  truncatePreviewText,
} from "./artifact-preview-limits";

describe("truncatePreviewText", () => {
  test("returns the original string when it fits", () => {
    expect(truncatePreviewText("hello", 10)).toEqual({
      text: "hello",
      truncated: false,
    });
  });

  test("cuts at the limit and flags truncation", () => {
    expect(truncatePreviewText("abcdef", 3)).toEqual({
      text: "abc",
      truncated: true,
    });
  });

  test("markdown ceiling is large enough for typical docs", () => {
    expect(MAX_MARKDOWN_PREVIEW_CHARS).toBeGreaterThan(100_000);
  });
});

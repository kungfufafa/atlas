import { expect, test } from "bun:test";
import { tokenizeMemoryQuery } from "./memory-search";

test("numeric identifiers remain searchable alongside natural words", () => {
  expect(tokenizeMemoryQuery("42")).toEqual(["42"]);
  expect(tokenizeMemoryQuery("Find invoice 2048 for me")).toEqual([
    "find",
    "invoice",
    "2048",
  ]);
  expect(tokenizeMemoryQuery("４２")).toEqual(["42"]);
});

test("numeric support retains stop-word, literal punctuation and query bounds", () => {
  expect(tokenizeMemoryQuery("and the dengan yang")).toEqual([]);
  expect(tokenizeMemoryQuery("%_")).toEqual(["%_"]);
  expect(
    tokenizeMemoryQuery(
      Array.from({ length: 30 }, (_, i) => String(i)).join(" ")
    )
  ).toHaveLength(16);
  expect(tokenizeMemoryQuery(`${" ".repeat(4096)}2048`)).toEqual([]);
  expect(tokenizeMemoryQuery("9".repeat(129))).toEqual([]);
});

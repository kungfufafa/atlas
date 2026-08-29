import { expect, test } from "bun:test";
import { isSafeHttpUrl } from "./url-safety";

test("recognizes only HTTP and HTTPS URLs as safe external links", () => {
  expect(isSafeHttpUrl("https://atlas.example.com/docs")).toBe(true);
  expect(isSafeHttpUrl("http://127.0.0.1:4310")).toBe(true);
  expect(isSafeHttpUrl("httpmalicious://atlas.example.com")).toBe(false);
  expect(isSafeHttpUrl("httpsmalicious://atlas.example.com")).toBe(false);
  expect(isSafeHttpUrl("mailto:team@example.com")).toBe(false);
  expect(isSafeHttpUrl("javascript:alert(1)")).toBe(false);
  expect(isSafeHttpUrl("/relative-link")).toBe(false);
});

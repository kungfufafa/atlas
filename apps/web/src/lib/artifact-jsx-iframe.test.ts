import { describe, expect, test } from "bun:test";
import {
  htmlWithJsxIframeCompiler,
  looksLikeJsx,
  transformJsx,
} from "./artifact-jsx-iframe";

describe("looksLikeJsx", () => {
  test("detects jsx files and react-looking sources", () => {
    expect(looksLikeJsx("const x = 1", "App.jsx")).toBe(true);
    expect(
      looksLikeJsx("export default function App() { return <div>Hi</div>; }")
    ).toBe(true);
    expect(looksLikeJsx("<!DOCTYPE html><html><body>Hi</body></html>")).toBe(
      false
    );
  });
});

describe("transformJsx", () => {
  test("turns a default component into h() calls", () => {
    const compiled = transformJsx(
      "export default function App(){return <h1>JSX canvas OK</h1>}"
    );
    expect(compiled).toContain("var __Default");
    expect(compiled).toContain('h("h1"');
    expect(compiled).toContain("JSX canvas OK");
    const h = (tag: string) => tag;
    const run = new Function(
      "h",
      `${compiled}; return typeof __Default === "function" ? __Default() : null;`
    );
    expect(run(h)).toBe("h1");
  });
});

describe("htmlWithJsxIframeCompiler", () => {
  test("embeds source and compiler inside the iframe document", () => {
    const html = htmlWithJsxIframeCompiler(
      "export default function App(){return <h1>Hi</h1>}"
    );
    expect(html).toContain("atlas-jsx-source");
    expect(html).toContain("data-atlas-jsx-compiler");
    expect(html).toContain("new Function");
    expect(html).not.toContain("allow-same-origin");
  });
});

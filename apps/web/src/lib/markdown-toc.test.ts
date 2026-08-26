import { describe, expect, test } from "bun:test";
import {
  extractMarkdownHeadings,
  findHeadingElement,
  MARKDOWN_TOC_MAX_HEADINGS,
} from "./markdown-toc";

describe("extractMarkdownHeadings", () => {
  test("lists h1 to h3 in document order", () => {
    const headings = extractMarkdownHeadings(
      ["# Script", "intro", "## Hook", "### Beat one", "#### Detail"].join("\n")
    );

    expect(headings).toEqual([
      {
        level: 1,
        occurrence: 0,
        position: 0,
        slug: "script",
        text: "Script",
      },
      {
        level: 2,
        occurrence: 0,
        position: 1,
        slug: "hook",
        text: "Hook",
      },
      {
        level: 3,
        occurrence: 0,
        position: 2,
        slug: "beat-one",
        text: "Beat one",
      },
    ]);
  });

  test("parses Setext headings with shared duplicate slug semantics", () => {
    const headings = extractMarkdownHeadings(
      ["Project *Atlas*", "=====", "Hook", "---", "## Hook"].join("\n")
    );

    expect(headings).toEqual([
      {
        level: 1,
        occurrence: 0,
        position: 0,
        slug: "project-atlas",
        text: "Project Atlas",
      },
      {
        level: 2,
        occurrence: 0,
        position: 1,
        slug: "hook",
        text: "Hook",
      },
      {
        level: 2,
        occurrence: 1,
        position: 2,
        slug: "hook-1",
        text: "Hook",
      },
    ]);
  });

  test("numbers repeated titles so each entry keeps its own target", () => {
    const headings = extractMarkdownHeadings(
      ["## Hook", "a", "## Body", "b", "## Hook", "c"].join("\n")
    );

    expect(headings.map((heading) => heading.occurrence)).toEqual([0, 0, 1]);
  });

  test("ignores hashes inside correctly delimited fenced code", () => {
    const headings = extractMarkdownHeadings(
      [
        "# Real",
        "````md",
        "## not a heading",
        "```",
        "### still code",
        "````",
        "## Also real",
      ].join("\n")
    );

    expect(headings.map((heading) => heading.text)).toEqual([
      "Real",
      "Also real",
    ]);
  });

  test("ignores Setext-looking content inside fenced code", () => {
    const headings = extractMarkdownHeadings(
      ["```md", "Not real", "---", "```", "Real", "---"].join("\n")
    );

    expect(headings.map((heading) => heading.text)).toEqual(["Real"]);
  });

  test("ignores indented code and a bare hash", () => {
    const headings = extractMarkdownHeadings(
      ["    # indented code", "#no space", "#", " ### Kept"].join("\n")
    );

    expect(headings.map((heading) => heading.text)).toEqual(["Kept"]);
  });

  test("reduces inline markup to rendered heading text", () => {
    const headings = extractMarkdownHeadings(
      "## **Hook** &amp; [a link](https://example.com) and `code` ##"
    );

    expect(headings[0]?.text).toBe("Hook & a link and code");
  });

  test("caps generated outlines", () => {
    const markdown = Array.from(
      { length: MARKDOWN_TOC_MAX_HEADINGS + 5 },
      (_, index) => `## Section ${index}`
    ).join("\n");

    expect(extractMarkdownHeadings(markdown)).toHaveLength(
      MARKDOWN_TOC_MAX_HEADINGS
    );
  });

  test("resolves duplicates and falls back to the rendered position", () => {
    const first = {
      id: "hook",
      tagName: "H2",
      textContent: "Hook",
    } as HTMLElement;
    const second = {
      id: "hook-1",
      tagName: "H2",
      textContent: "Hook",
    } as HTMLElement;
    const markedUp = {
      tagName: "H3",
      textContent: "literal_value",
    } as HTMLElement;
    const root = {
      querySelectorAll: () => [first, second, markedUp],
    } as unknown as HTMLElement;

    expect(
      findHeadingElement(root, {
        level: 2,
        occurrence: 0,
        position: 1,
        slug: "hook-1",
        text: "Hook",
      })
    ).toBe(second);
    expect(
      findHeadingElement(root, {
        level: 3,
        occurrence: 0,
        position: 2,
        slug: "literalvalue",
        text: "literalvalue",
      })
    ).toBe(markedUp);
  });
});

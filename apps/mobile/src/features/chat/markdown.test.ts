import { expect, test } from "bun:test";
import { parseMarkdownBlocks, parseMarkdownInline } from "./markdown";

test("parses headings, lists, quotes, and fenced code", () => {
  const blocks = parseMarkdownBlocks(
    "# Title\n\n- one\n- two\n\n> note\n\n```js\nconst n = 1;\n```\n\nbody"
  );
  expect(blocks.map((block) => block.type)).toEqual([
    "heading",
    "list",
    "quote",
    "code",
    "paragraph",
  ]);
  expect(blocks[3]).toMatchObject({ language: "js", type: "code" });
});

test("parses bold, italic, code, and links", () => {
  const parts = parseMarkdownInline(
    "See **bold** and *italic* plus `code` and [Atlas](https://atlas.example.com)"
  );
  expect(parts.map((part) => part.type)).toEqual([
    "text",
    "bold",
    "text",
    "italic",
    "text",
    "code",
    "text",
    "link",
  ]);
});

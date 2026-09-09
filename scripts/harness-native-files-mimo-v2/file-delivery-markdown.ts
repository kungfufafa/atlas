import { Lexer, type Token } from "./file-markdown-vendor.mjs";

const leadingPunctuation = /^[[(<{]+/;
const trailingPunctuation = /[.,;:!?\])}>]+$/;
const standalonePath = /^(?:artifacts\/|\.{1,2}\/|\/|[a-z][a-z0-9+.-]*:\/\/)/i;

/** Syntax only: no rendering, extension hooks, filesystem or oracle lookup. */
export function deliveryReferences(markdown: string): string[] {
  if (markdown.length > 1_000_000) {
    throw new Error("Delivery Markdown exceeds the declared parsing bound.");
  }
  const references: string[] = [];
  const plain = (text: string) => {
    for (const token of text.split(/\s+/)) {
      const value = token
        .replace(leadingPunctuation, "")
        .replace(trailingPunctuation, "");
      if (value.includes("artifacts/")) {
        references.push(value);
      }
    }
  };
  const inlineFormatting = (tokens: Token[]): Token[] =>
    tokens.flatMap((token) =>
      ["em", "strong", "del"].includes(token.type) &&
      "tokens" in token &&
      Array.isArray(token.tokens)
        ? inlineFormatting(token.tokens)
        : [token]
    );
  const visit = (tokens: Token[]) => {
    let text = "";
    const flush = () => {
      plain(text);
      text = "";
    };
    for (const token of inlineFormatting(tokens)) {
      switch (token.type) {
        case "link":
        case "image":
          flush();
          references.push(String(token.href));
          break;
        case "codespan":
          flush();
          references.push(String(token.text));
          break;
        case "code":
          flush();
          // Fences/indentation are block syntax. Standalone literal path lines
          // remain visible candidates; embedded code is not re-parsed as Markdown.
          for (const line of String(token.text).split(/\r?\n/)) {
            const value = line.trim();
            if (standalonePath.test(value) && value.includes("artifacts/")) {
              references.push(value);
            }
          }
          break;
        case "list":
          flush();
          for (const item of token.items) {
            visit(item.tokens);
          }
          break;
        case "table":
          flush();
          for (const cell of token.header) {
            visit(cell.tokens);
          }
          for (const row of token.rows) {
            for (const cell of row) {
              visit(cell.tokens);
            }
          }
          break;
        case "space":
        case "hr":
        case "br":
          text += "\n";
          break;
        default:
          if ("tokens" in token && Array.isArray(token.tokens)) {
            flush();
            visit(token.tokens);
          } else if ("text" in token && typeof token.text === "string") {
            text += token.text;
          } else if ("raw" in token) {
            text += String(token.raw);
          }
      }
    }
    flush();
  };
  visit(Lexer.lex(markdown, { breaks: false, gfm: true, pedantic: false }));
  return references;
}

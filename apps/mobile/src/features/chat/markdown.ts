export type MarkdownBlock =
  | { language?: string; text: string; type: "code" }
  | { level: 1 | 2 | 3; text: string; type: "heading" }
  | { items: string[]; ordered: boolean; type: "list" }
  | { text: string; type: "paragraph" }
  | { text: string; type: "quote" };

export type MarkdownInline =
  | { href: string; text: string; type: "link" }
  | { text: string; type: "bold" | "code" | "italic" | "text" };

const FENCE = /```([^\n]*)\n?([\s\S]*?)```/g;

export function parseMarkdownBlocks(input: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const fenced: Array<{ language?: string; text: string }> = [];
  const withSlots = input.replace(FENCE, (_match, language, text) => {
    fenced.push({
      language: String(language ?? "").trim() || undefined,
      text: String(text ?? "").replace(/\n$/, ""),
    });
    return `\n\n%%CODE${fenced.length - 1}%%\n\n`;
  });

  const chunks = withSlots.split(/\n{2,}/);

  for (const rawChunk of chunks) {
    const chunk = rawChunk.trim();
    if (!chunk) {
      continue;
    }

    const codeSlot = /^%%CODE(\d+)%%$/.exec(chunk);
    if (codeSlot) {
      const fencedBlock = fenced[Number(codeSlot[1])];
      if (fencedBlock) {
        blocks.push({ ...fencedBlock, type: "code" });
      }
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(chunk);
    if (heading) {
      const level = heading[1]?.length as 1 | 2 | 3;
      blocks.push({
        level,
        text: heading[2] ?? "",
        type: "heading",
      });
      continue;
    }

    if (chunk.startsWith("> ")) {
      blocks.push({
        text: chunk
          .split("\n")
          .map((line) => line.replace(/^>\s?/, ""))
          .join("\n"),
        type: "quote",
      });
      continue;
    }

    const lines = chunk.split("\n");
    const unordered = lines.every((line) => /^[-*]\s+/.test(line));
    const ordered = lines.every((line) => /^\d+\.\s+/.test(line));
    if (lines.length > 0 && (unordered || ordered)) {
      blocks.push({
        items: lines.map((line) =>
          line.replace(unordered ? /^[-*]\s+/ : /^\d+\.\s+/, "")
        ),
        ordered,
        type: "list",
      });
      continue;
    }

    blocks.push({ text: chunk, type: "paragraph" });
  }

  return blocks;
}

export function parseMarkdownInline(input: string): MarkdownInline[] {
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  const parts: MarkdownInline[] = [];
  let cursor = 0;

  for (const match of input.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      parts.push({ text: input.slice(cursor, index), type: "text" });
    }
    const token = match[0];
    if (token.startsWith("**")) {
      parts.push({ text: token.slice(2, -2), type: "bold" });
    } else if (token.startsWith("*")) {
      parts.push({ text: token.slice(1, -1), type: "italic" });
    } else if (token.startsWith("`")) {
      parts.push({ text: token.slice(1, -1), type: "code" });
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      parts.push({
        href: link?.[2] ?? "",
        text: link?.[1] ?? token,
        type: "link",
      });
    }
    cursor = index + token.length;
  }

  if (cursor < input.length) {
    parts.push({ text: input.slice(cursor), type: "text" });
  }

  return parts.length > 0 ? parts : [{ text: input, type: "text" }];
}

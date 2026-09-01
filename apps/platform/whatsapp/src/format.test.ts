import { describe, expect, test } from "bun:test";
import {
  formatHelpText,
  prepareWhatsAppReply,
  splitWhatsAppMessage,
  stripMarkdownForWhatsApp,
} from "./format";

test("WhatsApp help includes entry and profile commands", () => {
  const help = formatHelpText();

  expect(help).toContain("/start");
  expect(help).toContain("/profile");
  expect(help).toContain("/attach");
});

test("workspace-locked help hides only the org command", () => {
  const help = formatHelpText({ workspaceLocked: true });

  expect(help).not.toContain("/org");
  for (const command of [
    "/start",
    "/help",
    "/stop",
    "/clear",
    "/compact",
    "/new",
    "/attach",
    "/profile",
    "/status",
  ]) {
    expect(help).toContain(command);
  }
});

describe("stripMarkdownForWhatsApp", () => {
  test("converts double-bold to WhatsApp bold", () => {
    expect(stripMarkdownForWhatsApp("Hello **world**")).toBe("Hello *world*");
  });

  test("preserves WhatsApp italic markers", () => {
    expect(stripMarkdownForWhatsApp("Hello _world_")).toBe("Hello _world_");
  });

  test("removes inline code backticks", () => {
    expect(stripMarkdownForWhatsApp("Use `code` here")).toBe("Use code here");
  });

  test("unwraps fenced code blocks", () => {
    expect(
      stripMarkdownForWhatsApp("Before\n```js\nconst x = 1;\n```\nAfter")
    ).toBe("Before\nconst x = 1;\nAfter");
  });

  test("strips headings", () => {
    expect(stripMarkdownForWhatsApp("## Title")).toBe("Title");
  });
});

describe("prepareWhatsAppReply", () => {
  test("strips markdown and trims", () => {
    expect(prepareWhatsAppReply("  **bold**  ")).toBe("*bold*");
  });

  test("drops sandbox download links and share-url filename lines", () => {
    expect(
      prepareWhatsAppReply(
        "Sudah.\n\n[Download Excel](sandbox:/artifacts/sales.xlsx)\n\nsales.xlsx: https://app.example/s/nkshareabc"
      )
    ).toBe("Sudah.");
  });

  test("keeps ordinary https links", () => {
    expect(prepareWhatsAppReply("See https://example.com/docs")).toBe(
      "See https://example.com/docs"
    );
  });
});

describe("splitWhatsAppMessage", () => {
  test("returns single chunk for short text", () => {
    expect(splitWhatsAppMessage("Hello")).toEqual(["Hello"]);
  });

  test("splits on paragraph boundaries into chat bubbles", () => {
    const first = "A".repeat(195);
    const second = "B".repeat(195);
    const third = "Third end.";
    const text = `${first}\n\n${second}\n\n${third}`;
    const chunks = splitWhatsAppMessage(text);

    expect(chunks).toEqual([`${first}\n\n${second}`, third]);
  });

  test("splits long paragraphs by words", () => {
    const text = "word ".repeat(120).trim();
    const chunks = splitWhatsAppMessage(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(400);
    }
  });

  test("splits text exceeding WhatsApp limit", () => {
    const text = "a".repeat(70_000);
    const chunks = splitWhatsAppMessage(text);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 65_536)).toBe(true);
  });
});

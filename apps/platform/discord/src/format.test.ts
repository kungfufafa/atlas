import { describe, expect, test } from "bun:test";
import { formatHelpText, splitDiscordMessage } from "./format";

describe("formatHelpText", () => {
  test("lists native artifact and allowlist commands", () => {
    const help = formatHelpText();

    expect(help).toContain("/attach — send the latest saved artifact");
    expect(help).toContain("/allow user — add a Discord user");
  });
});

describe("splitDiscordMessage", () => {
  test("returns single chunk for short text", () => {
    expect(splitDiscordMessage("hello")).toEqual(["hello"]);
  });

  test("splits long text on paragraph boundaries", () => {
    const paragraph = "word ".repeat(400).trim();
    const text = `${paragraph}\n\n${paragraph}\n\n${paragraph}`;
    const chunks = splitDiscordMessage(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000);
    }
  });
});

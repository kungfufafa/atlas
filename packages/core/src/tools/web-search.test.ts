import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "../contract";
import { canonicalizeUrl, classifySourceType } from "./url-utils";
import {
  normalizeAndDedupeSearchResults,
  partitionTools,
  webSearchInputSchema,
  webSearchTool,
} from "./web-search";

const writeFileTool: ToolDefinition = {
  description: "Write a file",
  name: "write_file",
  run() {
    return Promise.resolve({});
  },
};

describe("canonicalizeUrl", () => {
  test("strips tracking query parameters", () => {
    const raw =
      "https://example.com/docs/install?utm_source=twitter&utm_medium=social&fbclid=12345&version=1.0&gclid=abc#heading-1";
    const canonical = canonicalizeUrl(raw);
    expect(canonical).toBe("https://example.com/docs/install?version=1.0");
  });

  test("normalizes trailing slashes and casing", () => {
    const raw = "HTTPS://BUN.SH/DOCS/";
    expect(canonicalizeUrl(raw)).toBe("https://bun.sh/docs");
  });

  test("sorts query parameters deterministically", () => {
    const a = canonicalizeUrl("https://example.com/search?b=2&a=1");
    const b = canonicalizeUrl("https://example.com/search?a=1&b=2");
    expect(a).toBe("https://example.com/search?a=1&b=2");
    expect(a).toBe(b);
  });
});

describe("classifySourceType", () => {
  test("identifies primary documentation and standards", () => {
    expect(
      classifySourceType("https://bun.sh/docs/cli/install", "bun.sh")
    ).toBe("primary");
    expect(
      classifySourceType(
        "https://developer.mozilla.org/en-US/docs/Web",
        "developer.mozilla.org"
      )
    ).toBe("primary");
    expect(
      classifySourceType("https://csrc.nist.gov/publications", "nist.gov")
    ).toBe("primary");
  });

  test("identifies community sources", () => {
    expect(
      classifySourceType("https://reddit.com/r/programming", "reddit.com")
    ).toBe("community");
    expect(
      classifySourceType(
        "https://stackoverflow.com/questions/123",
        "stackoverflow.com"
      )
    ).toBe("community");
  });

  test("identifies secondary sources", () => {
    expect(
      classifySourceType("https://techcrunch.com/article", "techcrunch.com")
    ).toBe("secondary");
  });
});

describe("normalizeAndDedupeSearchResults", () => {
  test("deduplicates exact canonical URLs and tracking variants", () => {
    const raw = [
      {
        snippet: "Bun docs",
        title: "Installation | Bun Docs",
        url: "https://bun.sh/docs/installation?utm_source=google",
      },
      {
        snippet: "Bun docs duplicate",
        title: "Installation | Bun Docs",
        url: "https://bun.sh/docs/installation?utm_source=twitter",
      },
      {
        snippet: "Node docs",
        title: "Node.js Guide",
        url: "https://nodejs.org/guide",
      },
    ];

    const results = normalizeAndDedupeSearchResults(raw, { limit: 5 });
    expect(results.length).toBe(2);
    expect(results[0]?.url).toBe("https://bun.sh/docs/installation");
    expect(results[0]?.sourceType).toBe("primary");
    expect(results[1]?.url).toBe("https://nodejs.org/guide");
  });

  test("respects domain filtering", () => {
    const raw = [
      { title: "Bun Docs", url: "https://bun.sh/docs" },
      { title: "Random Blog", url: "https://randomblog.com/bun" },
    ];

    const results = normalizeAndDedupeSearchResults(raw, {
      domains: ["bun.sh"],
      limit: 5,
    });
    expect(results.length).toBe(1);
    expect(results[0]?.domain).toBe("bun.sh");
  });

  test("respects domain exclusion", () => {
    const raw = [
      { title: "Bun Docs", url: "https://bun.sh/docs" },
      { title: "Spam Site", url: "https://spam.com/bun" },
    ];

    const results = normalizeAndDedupeSearchResults(raw, {
      excludeDomains: ["spam.com"],
      limit: 5,
    });
    expect(results.length).toBe(1);
    expect(results[0]?.domain).toBe("bun.sh");
  });
});

describe("webSearchInputSchema", () => {
  test("validates mature search options", () => {
    const input = {
      country: "us",
      domains: ["bun.sh", "github.com"],
      language: "en",
      limit: 10,
      query: "bun install package",
      recencyDays: 30,
    };
    expect(webSearchInputSchema.parse(input)).toEqual(input);
  });
});

describe("partitionTools", () => {
  test("separates web_search from local tools", () => {
    expect(partitionTools([writeFileTool, webSearchTool])).toEqual({
      hasWebSearch: true,
      localTools: [writeFileTool],
    });
  });

  test("returns empty local tools when only web_search is assigned", () => {
    expect(partitionTools([webSearchTool])).toEqual({
      hasWebSearch: true,
      localTools: [],
    });
  });
});

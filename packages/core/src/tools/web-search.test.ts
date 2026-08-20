import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ToolDefinition } from "../contract";
import { canonicalizeUrl, classifySourceType } from "./url-utils";
import {
  clearWebSearchCache,
  normalizeAndDedupeSearchResults,
  partitionTools,
  resolveWebSearchProvider,
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

describe("resolveWebSearchProvider", () => {
  test("prefers API-key providers over self-hosted over fallback", () => {
    expect(resolveWebSearchProvider({})).toBe("duckduckgo");
    expect(
      resolveWebSearchProvider({ SEARXNG_URL: "http://localhost:8888" })
    ).toBe("searxng");
    expect(
      resolveWebSearchProvider({
        BRAVE_API_KEY: "x",
        SEARXNG_URL: "http://localhost:8888",
      })
    ).toBe("brave");
    expect(
      resolveWebSearchProvider({ BRAVE_API_KEY: "x", TAVILY_API_KEY: "y" })
    ).toBe("tavily");
  });
});

describe("recency filtering", () => {
  test("drops results older than recencyDays but keeps undated ones", () => {
    const oldDate = new Date(
      Date.now() - 40 * 24 * 60 * 60 * 1000
    ).toISOString();
    const freshDate = new Date(
      Date.now() - 2 * 24 * 60 * 60 * 1000
    ).toISOString();
    const raw = [
      { publishedAt: oldDate, title: "Old Article", url: "https://old.com/a" },
      {
        publishedAt: freshDate,
        title: "Fresh Article",
        url: "https://fresh.com/a",
      },
      { title: "Undated Article", url: "https://undated.com/a" },
    ];

    const results = normalizeAndDedupeSearchResults(raw, {
      limit: 5,
      recencyDays: 7,
    });

    expect(results.map((r) => r.domain)).toEqual(["fresh.com", "undated.com"]);
  });
});

describe("web_search caching", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearWebSearchCache();
  });

  test("serves repeated queries from cache without a second network call", async () => {
    clearWebSearchCache();
    const fetchMock = mock(
      async () =>
        new Response(
          '<a class="result__a" href="https://bun.sh/docs">Bun Docs</a>' +
            '<div class="result__snippet">Bun is a runtime</div>',
          { headers: { "content-type": "text/html" } }
        )
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const first = await webSearchTool.run(
      { limit: 5, query: "bun javascript runtime" },
      undefined
    );
    const second = await webSearchTool.run(
      { limit: 5, query: "bun javascript runtime" },
      undefined
    );

    expect(first.results[0]?.url).toBe("https://bun.sh/docs");
    expect(second.results[0]?.url).toBe("https://bun.sh/docs");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("falls back to DuckDuckGo when the configured provider errors", async () => {
    clearWebSearchCache();
    process.env.TAVILY_API_KEY = "test-key";
    try {
      let call = 0;
      const fetchMock = mock(async (input: unknown) => {
        call += 1;
        if (call === 1) {
          return new Response("quota exceeded", { status: 429 });
        }
        const ddgHtml =
          '<a class="result__a" href="https://bun.sh/docs">Bun Docs</a>' +
          '<div class="result__snippet">Bun is a runtime</div>';
        return new Response(ddgHtml, {
          headers: { "content-type": "text/html" },
        });
      });
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      const output = await webSearchTool.run(
        { limit: 5, query: "bun javascript runtime" },
        undefined
      );

      expect(output.results[0]?.url).toBe("https://bun.sh/docs");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      delete process.env.TAVILY_API_KEY;
    }
  });
});

describe("sourceItemsFromSearchToolResult", () => {
  test("maps builtin web_search results", async () => {
    const { sourceItemsFromSearchToolResult } = await import("./web-search");
    expect(
      sourceItemsFromSearchToolResult({
        query: "jwt",
        results: [
          {
            domain: "auth0.com",
            id: "r1",
            snippet: "Use RS256",
            title: "JWT best practices",
            url: "https://auth0.com/jwt",
          },
        ],
        totalResults: 1,
      })
    ).toEqual([
      {
        domain: "auth0.com",
        id: "r1",
        snippet: "Use RS256",
        title: "JWT best practices",
        type: undefined,
        url: "https://auth0.com/jwt",
      },
    ]);
  });
});

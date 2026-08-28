import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  browserTool,
  registerBrowserHandler,
} from "@atlas/core/tools/browser-tool";
import { serve } from "bun";
import { type Browser, chromium } from "playwright";
import {
  assertBrowserNavigationUrl,
  BROWSER_CHROMIUM_LAUNCH_ARGS,
  BROWSER_DEFAULT_LOCALE,
  BROWSER_USER_AGENT,
  browserAcceptLanguageForLocale,
  browserLaunchArgs,
  browserSessionService,
  isHttp2ProtocolError,
  isRetryableBrowserNavigationError,
  resolveBrowserLocale,
  setBrowserLaunchForTests,
  shouldLaunchHeadlessBrowser,
} from "./browser-session-service";

function playwrightChromiumAvailable(): boolean {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

const chromiumAvailable = playwrightChromiumAvailable();
const BROWSER_SMOKE_TIMEOUT_MS = 30_000;

type FakeElement = {
  name: string;
  role: string;
  selector: string;
  value?: string;
};

type FakeDocument = {
  elements: FakeElement[];
  links: Array<{ text: string; url: string }>;
  text: string;
  title: string;
};

function documentFor(path: string): FakeDocument {
  if (path === "/products") {
    return {
      elements: [
        {
          name: "Search Products",
          role: "textbox",
          selector: "#search-input",
        },
        { name: "Search", role: "button", selector: "#search-btn" },
        {
          name: "Atlas Pro",
          role: "link",
          selector: 'a:has-text("Atlas Pro")',
        },
      ],
      links: [{ text: "Atlas Pro", url: "/products/atlas-pro" }],
      text: "Product Catalog",
      title: "Products - Test Store",
    };
  }
  if (path.startsWith("/search")) {
    return {
      elements: [],
      links: [{ text: "View Details", url: "/products/atlas-pro" }],
      text: "Search for Atlas Pro Price: $299",
      title: "Search Results",
    };
  }
  return {
    elements: [
      { name: "Products", role: "link", selector: 'a:has-text("Products")' },
    ],
    links: [{ text: "Products", url: "/products" }],
    text: "Welcome to Test Store",
    title: "Atlas Test Store",
  };
}

function pathFromUrl(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "/";
  }
}

function createFakeBrowser(): Browser {
  const pages: FakePage[] = [];
  let connected = true;

  class FakePage {
    closed = false;
    currentUrl = "about:blank";
    doc = documentFor("/");

    isClosed(): boolean {
      return this.closed;
    }

    url(): string {
      return this.currentUrl;
    }

    async title(): Promise<string> {
      return this.doc.title;
    }

    setDefaultTimeout(_ms: number): void {}
    setDefaultNavigationTimeout(_ms: number): void {}

    async goto(url: string): Promise<null> {
      this.currentUrl = url;
      this.doc = documentFor(pathFromUrl(url));
      return null;
    }

    async waitForTimeout(_ms: number): Promise<void> {}

    async waitForLoadState(_state?: string): Promise<void> {}

    async waitForSelector(selector: string): Promise<void> {
      if (!this.doc.elements.some((element) => element.selector === selector)) {
        throw new Error(`Selector not found: ${selector}`);
      }
    }

    async click(selector: string): Promise<void> {
      await this.waitForSelector(selector);
      if (selector.includes("Products") && !selector.includes("Atlas Pro")) {
        await this.goto(new URL("/products", this.currentUrl).href);
        return;
      }
      if (selector === "#search-btn") {
        await this.goto(new URL("/search?q=Atlas+Pro", this.currentUrl).href);
      }
    }

    async fill(selector: string, value: string): Promise<void> {
      const element = this.doc.elements.find(
        (item) => item.selector === selector
      );
      if (element) {
        element.value = value;
      }
    }

    async type(selector: string, text: string): Promise<void> {
      const element = this.doc.elements.find(
        (item) => item.selector === selector
      );
      if (element) {
        element.value = `${element.value ?? ""}${text}`;
      }
    }

    async evaluate<R, Arg>(
      _pageFunction: ((arg: Arg) => R) | (() => R),
      arg?: Arg
    ): Promise<R> {
      if (arg !== undefined) {
        const query = String(arg);
        const body = this.doc.text;
        const idx = body.toLowerCase().indexOf(query.toLowerCase());
        if (idx === -1) {
          return null as R;
        }
        return body.slice(
          Math.max(0, idx - 100),
          Math.min(body.length, idx + query.length + 100)
        ) as R;
      }
      return {
        elements: this.doc.elements,
        links: this.doc.links,
        text: this.doc.text,
      } as R;
    }
  }

  class FakeContext {
    readonly page = new FakePage();

    async newPage(): Promise<FakePage> {
      pages.push(this.page);
      return this.page;
    }

    async addInitScript(): Promise<void> {}

    async close(): Promise<void> {
      this.page.closed = true;
    }
  }

  return {
    async close() {
      connected = false;
      for (const page of pages) {
        page.closed = true;
      }
    },
    isConnected() {
      return connected;
    },
    async newContext() {
      return new FakeContext();
    },
  } as unknown as Browser;
}

function registerSessionHandler(): void {
  registerBrowserHandler((input, context) =>
    browserSessionService.executeBrowserAction(input, {
      orgId: context.orgId,
      profileId: context.profileId,
      sessionId: context.sessionId,
    })
  );
}

describe("BrowserSessionService with a mocked browser", () => {
  beforeAll(() => {
    process.env.ATLAS_BROWSER_HEADED = "0";
    setBrowserLaunchForTests(async () => createFakeBrowser());
    registerSessionHandler();
  });

  afterAll(async () => {
    await browserSessionService.closeAll();
    setBrowserLaunchForTests(null);
  });

  test("navigates to page, extracts title and compact element refs", async () => {
    const output = await browserTool.run(
      { action: "open", url: "http://127.0.0.1:4310/" },
      { orgId: "org-1", profileId: "prof-1", sessionId: "sess-mock-1" }
    );

    expect(output.status).toBe("success");
    expect(output.snapshot?.title).toBe("Atlas Test Store");
    expect(output.snapshot?.interactiveElements.length).toBeGreaterThan(0);
    const linkEl = output.snapshot?.interactiveElements.find(
      (element) => element.name === "Products"
    );
    expect(linkEl).toBeDefined();
    expect(linkEl?.ref).toMatch(/^e\d+$/);
  });

  test("clicks element using element ref", async () => {
    const openOutput = await browserTool.run(
      { action: "open", url: "http://127.0.0.1:4310/" },
      { orgId: "org-1", profileId: "prof-1", sessionId: "sess-mock-2" }
    );
    const linkEl = openOutput.snapshot?.interactiveElements.find(
      (element) => element.name === "Products"
    );
    expect(linkEl).toBeDefined();

    const clickOutput = await browserTool.run(
      { action: "click", element: linkEl!.ref },
      { orgId: "org-1", profileId: "prof-1", sessionId: "sess-mock-2" }
    );

    expect(clickOutput.status).toBe("success");
    expect(clickOutput.snapshot?.title).toBe("Products - Test Store");
    expect(clickOutput.snapshot?.text).toContain("Product Catalog");
  });

  test("types into textbox and clicks submit", async () => {
    const pageSnap = await browserTool.run(
      { action: "open", url: "http://127.0.0.1:4310/products" },
      { orgId: "org-1", profileId: "prof-1", sessionId: "sess-mock-3" }
    );
    const inputEl = pageSnap.snapshot?.interactiveElements.find(
      (element) => element.role === "textbox"
    );
    expect(inputEl).toBeDefined();

    await browserTool.run(
      { action: "type", element: inputEl!.ref, text: "Atlas Pro" },
      { orgId: "org-1", profileId: "prof-1", sessionId: "sess-mock-3" }
    );

    const btnEl = pageSnap.snapshot?.interactiveElements.find(
      (element) => element.role === "button" || element.name === "Search"
    );
    expect(btnEl).toBeDefined();

    const searchOutput = await browserTool.run(
      { action: "click", element: btnEl!.ref },
      { orgId: "org-1", profileId: "prof-1", sessionId: "sess-mock-3" }
    );

    expect(searchOutput.snapshot?.title).toBe("Search Results");
    expect(searchOutput.snapshot?.text).toContain("Price: $299");
  });

  test("finds text on page", async () => {
    await browserTool.run(
      { action: "open", url: "http://127.0.0.1:4310/search" },
      { orgId: "org-1", profileId: "prof-1", sessionId: "sess-mock-4" }
    );
    const findOutput = await browserTool.run(
      { action: "find", query: "$299" },
      { orgId: "org-1", profileId: "prof-1", sessionId: "sess-mock-4" }
    );

    expect(findOutput.status).toBe("success");
    expect(findOutput.message).toContain("$299");
  });

  test("closes browser session context", async () => {
    await browserTool.run(
      { action: "open", url: "http://127.0.0.1:4310/" },
      { orgId: "org-1", profileId: "prof-1", sessionId: "sess-mock-5" }
    );
    const closeOutput = await browserTool.run(
      { action: "close" },
      { orgId: "org-1", profileId: "prof-1", sessionId: "sess-mock-5" }
    );

    expect(closeOutput.status).toBe("success");
  });

  test("closing one org browser session leaves another org's session intact", async () => {
    await browserTool.run(
      { action: "open", url: "http://127.0.0.1:4310/" },
      { orgId: "org-a", profileId: "prof-a", sessionId: "sess-mock-a" }
    );
    await browserTool.run(
      { action: "open", url: "http://127.0.0.1:4310/products" },
      { orgId: "org-b", profileId: "prof-b", sessionId: "sess-mock-b" }
    );

    const closeOutput = await browserTool.run(
      { action: "close" },
      { orgId: "org-a", profileId: "prof-a", sessionId: "sess-mock-a" }
    );
    expect(closeOutput.status).toBe("success");

    const remaining = await browserTool.run(
      { action: "find", query: "Product Catalog" },
      { orgId: "org-b", profileId: "prof-b", sessionId: "sess-mock-b" }
    );
    expect(remaining.status).toBe("success");
    expect(remaining.message).toContain("Product Catalog");

    await browserTool.run(
      { action: "close" },
      { orgId: "org-b", profileId: "prof-b", sessionId: "sess-mock-b" }
    );
  });
});

let testServer: ReturnType<typeof serve> | null = null;
let testServerUrl = "";

describe.skipIf(!chromiumAvailable)(
  "BrowserSessionService Chromium smokes",
  () => {
    beforeAll(() => {
      process.env.ATLAS_BROWSER_HEADED = "0";
      setBrowserLaunchForTests(null);
      testServer = serve({
        fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === "/") {
            return new Response(
              `<!DOCTYPE html>
          <html>
            <head><title>Atlas Test Store</title></head>
            <body>
              <h1>Welcome to Test Store</h1>
              <nav><a href="/products">Products</a></nav>
            </body>
          </html>`,
              { headers: { "Content-Type": "text/html" } }
            );
          }
          if (url.pathname === "/products") {
            return new Response(
              `<!DOCTYPE html>
          <html>
            <head><title>Products - Test Store</title></head>
            <body>
              <h1>Product Catalog</h1>
            </body>
          </html>`,
              { headers: { "Content-Type": "text/html" } }
            );
          }
          return new Response("Not Found", { status: 404 });
        },
        port: 8088,
      });
      testServerUrl = `http://127.0.0.1:${testServer.port}`;
      registerSessionHandler();
    });

    afterAll(async () => {
      await browserSessionService.closeAll();
      testServer?.stop(true);
    });

    test(
      "navigates to page and extracts title and compact element refs",
      async () => {
        const output = await browserTool.run(
          { action: "open", url: `${testServerUrl}/` },
          { orgId: "org-1", profileId: "prof-1", sessionId: "sess-smoke-1" }
        );

        expect(output.status).toBe("success");
        expect(output.snapshot?.title).toBe("Atlas Test Store");
        expect(output.snapshot?.interactiveElements.length).toBeGreaterThan(0);
        const linkEl = output.snapshot?.interactiveElements.find(
          (element) => element.name === "Products"
        );
        expect(linkEl).toBeDefined();
        expect(linkEl?.ref).toMatch(/^e\d+$/);
      },
      { timeout: BROWSER_SMOKE_TIMEOUT_MS }
    );

    test(
      "closing one org browser session leaves another org's session intact",
      async () => {
        await browserTool.run(
          { action: "open", url: `${testServerUrl}/` },
          {
            orgId: "org-smoke-a",
            profileId: "prof-a",
            sessionId: "sess-smoke-a",
          }
        );
        await browserTool.run(
          { action: "open", url: `${testServerUrl}/products` },
          {
            orgId: "org-smoke-b",
            profileId: "prof-b",
            sessionId: "sess-smoke-b",
          }
        );

        const closeOutput = await browserTool.run(
          { action: "close" },
          {
            orgId: "org-smoke-a",
            profileId: "prof-a",
            sessionId: "sess-smoke-a",
          }
        );
        expect(closeOutput.status).toBe("success");

        const remaining = await browserTool.run(
          { action: "find", query: "Product Catalog" },
          {
            orgId: "org-smoke-b",
            profileId: "prof-b",
            sessionId: "sess-smoke-b",
          }
        );
        expect(remaining.status).toBe("success");
        expect(remaining.message).toContain("Product Catalog");

        await browserTool.run(
          { action: "close" },
          {
            orgId: "org-smoke-b",
            profileId: "prof-b",
            sessionId: "sess-smoke-b",
          }
        );
      },
      { timeout: BROWSER_SMOKE_TIMEOUT_MS }
    );
  }
);

describe("browser navigation hardening", () => {
  test("does not fingerprint as AtlasBrowser", () => {
    expect(BROWSER_CHROMIUM_LAUNCH_ARGS).not.toContain("--disable-http2");
    expect(browserLaunchArgs()).not.toContain("--disable-http2");
    expect(browserLaunchArgs({ http1: true })).toContain("--disable-http2");
    expect(BROWSER_CHROMIUM_LAUNCH_ARGS).toContain(
      "--disable-blink-features=AutomationControlled"
    );
    expect(BROWSER_USER_AGENT).not.toContain("AtlasBrowser");
    expect(BROWSER_USER_AGENT).toContain("Chrome/");
  });

  test("retries HTTP/2 protocol failures and navigation timeouts", () => {
    expect(
      isRetryableBrowserNavigationError(
        new Error(
          "goto: net::ERR_HTTP2_PROTOCOL_ERROR at https://www.tokopedia.com/about"
        )
      )
    ).toBe(true);
    expect(
      isRetryableBrowserNavigationError(
        new Error("goto: net::ERR_CONNECTION_RESET at https://example.com")
      )
    ).toBe(true);
    expect(
      isRetryableBrowserNavigationError(
        new Error("goto: Timeout 30000ms exceeded.")
      )
    ).toBe(true);
    expect(
      isRetryableBrowserNavigationError(
        new Error("net::ERR_NAME_NOT_RESOLVED at https://missing.example")
      )
    ).toBe(false);
    expect(
      isHttp2ProtocolError(
        new Error(
          "goto: net::ERR_HTTP2_PROTOCOL_ERROR at https://www.tokopedia.com/about"
        )
      )
    ).toBe(true);
    expect(
      isHttp2ProtocolError(new Error("goto: Timeout 30000ms exceeded."))
    ).toBe(false);
  });

  test("ATLAS_BROWSER_HEADED opts into headed Chromium; default is headless", () => {
    expect(shouldLaunchHeadlessBrowser({})).toBe(true);
    expect(shouldLaunchHeadlessBrowser({ ATLAS_BROWSER_HEADED: "0" })).toBe(
      true
    );
    expect(shouldLaunchHeadlessBrowser({ ATLAS_BROWSER_HEADED: "1" })).toBe(
      false
    );
    expect(shouldLaunchHeadlessBrowser({ CI: "true" })).toBe(true);
  });

  test("browser locale defaults to en-US and can be overridden", () => {
    expect(resolveBrowserLocale({})).toBe(BROWSER_DEFAULT_LOCALE);
    expect(resolveBrowserLocale({ ATLAS_BROWSER_LOCALE: "id-ID" })).toBe(
      "id-ID"
    );
    expect(browserAcceptLanguageForLocale("en-US")).toBe("en-US,en;q=0.9");
    expect(browserAcceptLanguageForLocale("id-ID")).toBe(
      "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7"
    );
  });

  test("blocks private, link-local, and RFC1918 addresses", async () => {
    await expect(
      assertBrowserNavigationUrl("http://172.16.1.9/admin")
    ).rejects.toThrow(/private address/);
    await expect(
      assertBrowserNavigationUrl("http://10.0.0.5/")
    ).rejects.toThrow(/private address/);
    await expect(
      assertBrowserNavigationUrl("http://192.168.1.1/")
    ).rejects.toThrow(/private address/);
    await expect(
      assertBrowserNavigationUrl("http://169.254.169.254/latest/meta-data")
    ).rejects.toThrow(/private address/);
    await expect(
      assertBrowserNavigationUrl("http://127.0.0.1/")
    ).rejects.toThrow(/private address/);
  });

  test("allows loopback only on local fixture ports", async () => {
    await assertBrowserNavigationUrl("http://127.0.0.1:4310/health");
    await assertBrowserNavigationUrl("http://localhost:3000/");
    await expect(
      assertBrowserNavigationUrl("http://localhost:80/")
    ).rejects.toThrow(/private address/);
  });

  test("rejects non-http protocols and unresolvable hosts", async () => {
    await expect(
      assertBrowserNavigationUrl("file:///etc/passwd")
    ).rejects.toThrow(/Unsupported protocol/);
    await expect(
      assertBrowserNavigationUrl("http://atlas-ssrf-test.invalid/")
    ).rejects.toThrow(/could not be resolved/);
  });
});

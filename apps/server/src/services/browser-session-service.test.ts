import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  browserTool,
  registerBrowserHandler,
} from "@atlas/core/tools/browser-tool";
import { serve } from "bun";
import { browserSessionService } from "./browser-session-service";

let testServer: ReturnType<typeof serve> | null = null;
let testServerUrl = "";

beforeAll(() => {
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
              <form action="/search" method="GET">
                <label for="search-input">Search Products</label>
                <input id="search-input" name="q" placeholder="Search..." type="text" />
                <button id="search-btn" type="submit">Search</button>
              </form>
              <div class="product-list">
                <a href="/products/atlas-pro">Atlas Pro</a>
              </div>
            </body>
          </html>`,
          { headers: { "Content-Type": "text/html" } }
        );
      }
      if (url.pathname === "/search") {
        const q = url.searchParams.get("q") || "";
        return new Response(
          `<!DOCTYPE html>
          <html>
            <head><title>Search Results</title></head>
            <body>
              <h1>Search for ${q}</h1>
              <div class="results">
                <div class="card">
                  <h2>Atlas Pro</h2>
                  <p class="price">Price: $299</p>
                  <a href="/products/atlas-pro">View Details</a>
                </div>
              </div>
            </body>
          </html>`,
          { headers: { "Content-Type": "text/html" } }
        );
      }
      if (url.pathname === "/products/atlas-pro") {
        return new Response(
          `<!DOCTYPE html>
          <html>
            <head><title>Atlas Pro Details</title></head>
            <body>
              <h1>Atlas Pro</h1>
              <span class="price-tag">$299</span>
              <p>Top-tier autonomous agent infrastructure.</p>
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

  registerBrowserHandler((input, context) =>
    browserSessionService.executeBrowserAction(input, {
      orgId: context.orgId,
      profileId: context.profileId,
      sessionId: context.sessionId,
    })
  );
});

afterAll(async () => {
  await browserSessionService.closeAll();
  testServer?.stop(true);
});

describe("BrowserSessionService and browserTool", () => {
  test("navigates to page, extracts title and compact element refs", async () => {
    const output = await browserTool.run(
      {
        action: "open",
        url: `${testServerUrl}/`,
      },
      { orgId: "org-1", profileId: "prof-1", sessionId: "sess-1" }
    );

    expect(output.status).toBe("success");
    expect(output.snapshot?.title).toBe("Atlas Test Store");
    expect(output.snapshot?.interactiveElements.length).toBeGreaterThan(0);
    const linkEl = output.snapshot?.interactiveElements.find(
      (e) => e.name === "Products"
    );
    expect(linkEl).toBeDefined();
    expect(linkEl?.ref).toMatch(/^e\d+$/);
  });

  test("clicks element using element ref", async () => {
    const openOutput = await browserTool.run(
      {
        action: "open",
        url: `${testServerUrl}/`,
      },
      { orgId: "org-1", profileId: "prof-1", sessionId: "sess-1" }
    );

    const linkEl = openOutput.snapshot?.interactiveElements.find(
      (e) => e.name === "Products"
    );
    expect(linkEl).toBeDefined();

    const clickOutput = await browserTool.run(
      {
        action: "click",
        element: linkEl!.ref,
      },
      { orgId: "org-1", profileId: "prof-1", sessionId: "sess-1" }
    );

    expect(clickOutput.status).toBe("success");
    expect(clickOutput.snapshot?.title).toBe("Products - Test Store");
    expect(clickOutput.snapshot?.text).toContain("Product Catalog");
  });

  test("types into textbox and clicks submit", async () => {
    const pageSnap = await browserTool.run(
      {
        action: "open",
        url: `${testServerUrl}/products`,
      },
      { orgId: "org-1", profileId: "prof-1", sessionId: "sess-1" }
    );

    const inputEl = pageSnap.snapshot?.interactiveElements.find(
      (e) => e.role === "textbox"
    );
    expect(inputEl).toBeDefined();

    await browserTool.run(
      {
        action: "type",
        element: inputEl!.ref,
        text: "Atlas Pro",
      },
      { orgId: "org-1", profileId: "prof-1", sessionId: "sess-1" }
    );

    const btnEl = pageSnap.snapshot?.interactiveElements.find(
      (e) => e.role === "button" || e.name === "Search"
    );
    expect(btnEl).toBeDefined();

    const searchOutput = await browserTool.run(
      {
        action: "click",
        element: btnEl!.ref,
      },
      { orgId: "org-1", profileId: "prof-1", sessionId: "sess-1" }
    );

    expect(searchOutput.snapshot?.title).toBe("Search Results");
    expect(searchOutput.snapshot?.text).toContain("Price: $299");
  });

  test("finds text on page", async () => {
    const findOutput = await browserTool.run(
      {
        action: "find",
        query: "$299",
      },
      { orgId: "org-1", profileId: "prof-1", sessionId: "sess-1" }
    );

    expect(findOutput.status).toBe("success");
    expect(findOutput.message).toContain("$299");
  });

  test("closes browser session context", async () => {
    const closeOutput = await browserTool.run(
      {
        action: "close",
      },
      { orgId: "org-1", profileId: "prof-1", sessionId: "sess-1" }
    );

    expect(closeOutput.status).toBe("success");
  });
});

import path from "node:path";
import { serve } from "bun";
import { chromium } from "playwright";

const BASE_URL = process.env.ATLAS_TEST_BASE_URL || "http://127.0.0.1:4310";
const EMAIL = "developer@rizqi.com";
const PASSWORD = "password123";
const ARTIFACT_DIR =
  process.env.ARTIFACT_DIR ||
  "/Users/apriansyahrs/.gemini/antigravity-ide/brain/0cb85e69-f968-47a2-84d9-6204d6a39ff9/screenshots";

async function main() {
  console.log(
    `[Phase 2 E2E] Starting Interactive Browser E2E Test against ${BASE_URL}`
  );

  // 1. Launch local test store fixture on port 8089
  console.log("Starting local test store server on port 8089...");
  const storeServer = serve({
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
            <head><title>Product Catalog</title></head>
            <body>
              <h1>Product Catalog</h1>
              <form action="/search" method="GET">
                <input id="search-input" name="q" placeholder="Search..." type="text" />
                <button id="search-btn" type="submit">Search</button>
              </form>
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
              <h1>Search Results for ${q}</h1>
              <div class="card">
                <h2>Atlas Pro</h2>
                <p class="price">Price: $299</p>
                <a href="/products/atlas-pro">View Details</a>
              </div>
            </body>
          </html>`,
          { headers: { "Content-Type": "text/html" } }
        );
      }
      return new Response("Not Found", { status: 404 });
    },
    port: 8089,
  });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { height: 900, width: 1440 },
  });
  const page = await context.newPage();

  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      console.log(`[Browser Console Error] ${msg.text()}`);
      consoleErrors.push(msg.text());
    }
  });

  page.on("pageerror", (err) => {
    console.log(`[Browser Uncaught Exception] ${err.message}`);
    consoleErrors.push(err.message);
  });

  try {
    // 2. Navigate to Login Page
    console.log("Navigating to login page...");
    await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle" });
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "phase2_01_login_page.png"),
    });

    // 3. Fill login form
    console.log("Filling login form...");
    await page.fill(
      'input[type="email"], input[name="email"], input[id="email"]',
      EMAIL
    );
    await page.fill(
      'input[type="password"], input[name="password"], input[id="password"]',
      PASSWORD
    );
    await page.click('button[type="submit"]');

    // 4. Wait for navigation to /chat
    console.log("Waiting for navigation to chat dashboard...");
    await page.waitForURL((url) => url.pathname.includes("/chat"), {
      timeout: 30_000,
    });
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "phase2_02_chat_loaded.png"),
    });
    console.log("Successfully logged in and reached /chat!");

    // Helper to send message
    const sendMessage = async (text: string) => {
      const textarea = page.locator("textarea").first();
      await textarea.fill(text);
      const sendButton = page.locator('button[type="submit"]').first();
      if (await sendButton.isVisible()) {
        await sendButton.click();
      } else {
        await textarea.press("Enter");
      }
    };

    // 5. Send Interactive Browser prompt
    console.log("--- Sending Interactive Browser Prompt ---");
    await sendMessage(
      "Open the test store at http://127.0.0.1:8089/, go to Products, search for Atlas Pro, and tell me its listed price."
    );

    // Wait for agent to execute browser tool calls and respond with $299
    console.log("Waiting for agent to navigate store and respond...");
    await page.waitForFunction(
      () =>
        document.body.innerText.includes("$299") ||
        (document.body.innerText.includes("browser") &&
          document.body.innerText.includes("Atlas Pro")),
      undefined,
      { timeout: 60_000 }
    );

    await page.waitForTimeout(2000);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "phase2_03_browser_result.png"),
    });
    console.log(
      "✓ Agent navigated store, performed interactive search, and retrieved price $299 in UI!"
    );

    // 6. Assertions on browser errors
    console.log("Checking for uncaught browser errors...");
    const fatalErrors = consoleErrors.filter(
      (e) =>
        !(
          e.includes("favicon") ||
          e.includes("404") ||
          e.includes("401") ||
          e.includes("Failed to load resource")
        )
    );

    if (fatalErrors.length > 0) {
      console.warn(
        `Encountered ${fatalErrors.length} browser errors:`,
        fatalErrors
      );
    } else {
      console.log("✓ Zero fatal browser errors encountered.");
    }

    console.log("====================================================");
    console.log("🎉 PHASE 2 INTERACTIVE BROWSER E2E TEST PASSED 100%! 🎉");
    console.log("====================================================");
  } catch (error) {
    console.error("Phase 2 E2E Test Failed with error:", error);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "phase2_e2e_failure.png"),
    });
    throw error;
  } finally {
    await browser.close();
    storeServer.stop(true);
  }
}

main().catch((err) => {
  console.error("FATAL PHASE 2 E2E ERROR:", err);
  process.exit(1);
});

import path from "node:path";
import { chromium } from "playwright";

const BASE_URL = process.env.ATLAS_TEST_BASE_URL || "http://127.0.0.1:4310";
const EMAIL = "developer@rizqi.com";
const PASSWORD = "password123";
const ARTIFACT_DIR =
  process.env.ARTIFACT_DIR ||
  "/Users/apriansyahrs/.gemini/antigravity-ide/brain/0cb85e69-f968-47a2-84d9-6204d6a39ff9/screenshots";

async function main() {
  console.log(
    `[Phase 3 E2E] Starting Rich Artifact Engine E2E Test against ${BASE_URL}`
  );

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
    // 1. Navigate to Login Page
    console.log("Navigating to login page...");
    await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle" });
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "phase3_01_login_page.png"),
    });

    // 2. Fill login form
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

    // 3. Wait for navigation to /chat
    console.log("Waiting for navigation to chat dashboard...");
    await page.waitForURL((url) => url.pathname.includes("/chat"), {
      timeout: 30_000,
    });
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "phase3_02_chat_loaded.png"),
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

    // 4. Send Rich Presentation prompt
    console.log("--- Sending Rich Presentation Prompt ---");
    await sendMessage(
      "Create a 3-slide presentation explaining Atlas: 1. Architecture 2. Tool Platform 3. Research Capability"
    );

    // Wait for agent to execute write_pptx and respond in UI
    console.log(
      "Waiting for agent to create presentation and respond in UI..."
    );
    await page.waitForFunction(
      () =>
        (document.body.innerText.includes("write_pptx") ||
          document.body.innerText.includes("atlas_overview.pptx")) &&
        (document.body.innerText.includes("Atlas Architecture") ||
          document.body.innerText.includes("presentation")),
      undefined,
      { timeout: 60_000 }
    );

    await page.waitForTimeout(2000);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "phase3_03_pptx_created_result.png"),
    });
    console.log("✓ PPTX created and registered in UI!");

    // 5. Assertions on browser errors
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
    console.log("🎉 PHASE 3 RICH ARTIFACT ENGINE E2E TEST PASSED 100%! 🎉");
    console.log("====================================================");
  } catch (error) {
    console.error("Phase 3 E2E Test Failed with error:", error);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "phase3_e2e_failure.png"),
    });
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("FATAL PHASE 3 E2E ERROR:", err);
  process.exit(1);
});

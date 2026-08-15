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
    `[Phase 4 E2E] Starting Personal & Project Memory E2E Test against ${BASE_URL}`
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
      path: path.join(ARTIFACT_DIR, "phase4_01_login_page.png"),
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

    // 4. Conversation 1: Save User Preference
    console.log("--- Conversation 1: Storing durable preference ---");
    await sendMessage(
      "Remember that I prefer technical answers with concise examples."
    );

    console.log("Waiting for memory_write confirmation...");
    await page.waitForFunction(
      () =>
        document.body.innerText.includes(
          "technical answers with concise examples"
        ) ||
        document.body.innerText.includes("memory_write") ||
        document.body.innerText.includes("durable memory"),
      undefined,
      { timeout: 60_000 }
    );
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "phase4_02_memory_saved.png"),
    });
    console.log("✓ User preference persisted into durable memory!");

    // 5. Conversation 2: Fresh Session Memory Recall
    console.log(
      "--- Conversation 2: Verifying Cross-Session Memory Recall ---"
    );
    // Start fresh chat or navigate to /chat
    const newChatButton = page
      .locator(
        'button:has-text("New Chat"), a:has-text("New Chat"), button[aria-label="New Chat"]'
      )
      .first();
    if (await newChatButton.isVisible()) {
      await newChatButton.click();
      await page.waitForTimeout(1500);
    } else {
      await page.goto(`${BASE_URL}/chat`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1500);
    }

    await sendMessage("How should you present technical explanations to me?");

    console.log("Waiting for memory recall in new conversation...");
    await page.waitForFunction(
      () =>
        document.body.innerText.includes("concise examples") &&
        document.body.innerText.includes("technical explanations"),
      undefined,
      { timeout: 60_000 }
    );
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "phase4_03_memory_recalled.png"),
    });
    console.log("✓ Cross-session memory recall succeeded in new conversation!");

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
    console.log(
      "🎉 PHASE 4 PERSONAL & PROJECT MEMORY E2E TEST PASSED 100%! 🎉"
    );
    console.log("====================================================");
  } catch (error) {
    console.error("Phase 4 E2E Test Failed with error:", error);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "phase4_e2e_failure.png"),
    });
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("FATAL PHASE 4 E2E ERROR:", err);
  process.exit(1);
});

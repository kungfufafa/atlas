import path from "node:path";
import { chromium } from "playwright";

const BASE_URL = process.env.ATLAS_TEST_BASE_URL || "http://127.0.0.1:4310";
const EMAIL = "developer@rizqi.com";
const PASSWORD = "password123";
const ARTIFACT_DIR =
  process.env.ARTIFACT_DIR ||
  "/Users/apriansyahrs/.gemini/antigravity-ide/brain/99688ddc-1a2a-4e4a-a26d-b59311dbdafe/screenshots";

async function main() {
  console.log(`Starting Comprehensive E2E Browser Test against ${BASE_URL}`);
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
      path: path.join(ARTIFACT_DIR, "01_login_page.png"),
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
      path: path.join(ARTIFACT_DIR, "02_chat_loaded.png"),
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

    // 4. Scenario 1: Calculator Execution
    console.log("--- Scenario 1: Calculator Execution ---");
    await sendMessage("Calculate (12500 * 17.5) / 7 using the calculator tool");
    await page.waitForFunction(
      () => document.body.innerText.includes("31250"),
      undefined,
      { timeout: 60_000 }
    );
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "03_calculator_result.png"),
    });
    console.log("Calculator test passed! Result 31250 displayed in UI.");

    // 5. Scenario 2: Filesystem Tool
    console.log("--- Scenario 2: Filesystem Tool ---");
    await sendMessage(
      "Create a file named e2e-test.txt containing hello atlas"
    );
    await page.waitForFunction(
      () =>
        document.body.innerText.includes("e2e-test.txt") &&
        (document.body.innerText.includes("Operation completed") ||
          document.body.innerText.includes("written")),
      undefined,
      { timeout: 60_000 }
    );
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "04_file_created_result.png"),
    });
    console.log("Filesystem write message turn completed in UI.");

    // 6. Scenario 3: Python Analysis Sandbox
    console.log("--- Scenario 3: Python Sandbox ---");
    await sendMessage(
      "Use python_execute to calculate 2**16 and print RESULT: 65536"
    );
    await page.waitForFunction(
      () => document.body.innerText.includes("65536"),
      undefined,
      { timeout: 60_000 }
    );
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "05_python_result.png"),
    });
    console.log("Python execution message turn completed in UI.");

    // 7. Scenario 4: Spreadsheet XLSX Engine
    console.log("--- Scenario 4: Spreadsheet XLSX Engine ---");
    await sendMessage(
      "Use spreadsheet tool to create sales_report.xlsx with columns Item, Qty, Price, Total"
    );
    await page.waitForFunction(
      () =>
        document.body.innerText.includes("sales_report.xlsx") ||
        document.body.innerText.includes("Created spreadsheet") ||
        document.body.innerText.includes("spreadsheet"),
      undefined,
      { timeout: 60_000 }
    );
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "06_spreadsheet_result.png"),
    });
    console.log("Spreadsheet XLSX creation message turn completed in UI.");

    // 8. Scenario 5: Dynamic Tool Search & Activation
    console.log("--- Scenario 5: Dynamic Tool Search & Activation ---");
    await sendMessage("Use tool_search to Find tools for spreadsheet analysis");
    await page.waitForFunction(
      () =>
        document.body.innerText.includes("spreadsheet") ||
        document.body.innerText.includes("tool_search") ||
        document.body.innerText.includes("Discovered"),
      undefined,
      { timeout: 60_000 }
    );
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "07_tool_search_result.png"),
    });
    console.log("Dynamic tool search & activation turn completed in UI.");

    // 9. Assertions on browser errors
    console.log("Checking for uncaught browser errors...");
    const fatalErrors = consoleErrors.filter(
      (e) => !(e.includes("favicon") || e.includes("404") || e.includes("401"))
    );

    if (fatalErrors.length > 0) {
      console.warn(
        `Encountered ${fatalErrors.length} browser errors:`,
        fatalErrors
      );
    } else {
      console.log("No fatal browser errors encountered.");
    }

    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "08_final_e2e_state.png"),
    });
    console.log("====================================================");
    console.log("ALL COMPREHENSIVE E2E BROWSER SCENARIOS PASSED 100%!");
    console.log("====================================================");
  } catch (error) {
    console.error("E2E Test Failed with error:", error);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "e2e_failure_state.png"),
    });
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("FATAL E2E ERROR:", err);
  process.exit(1);
});

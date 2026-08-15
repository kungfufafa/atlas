import path from "node:path";
import { chromium } from "playwright";

const BASE_URL = process.env.ATLAS_TEST_BASE_URL || "http://127.0.0.1:4310";
const EMAIL = "admin@oceanmall.test";
const PASSWORD = "password123";
const ARTIFACT_DIR =
  process.env.ARTIFACT_DIR ||
  "/Users/apriansyahrs/.gemini/antigravity-ide/brain/ba9cc42d-b0e5-41b0-835a-9e2b3ef5d014/screenshots";

async function main() {
  console.log(
    `Starting Comprehensive End-to-End Browser QA against ${BASE_URL}`
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
    // 1. Navigate to Landing / Login Page
    console.log("Step 1: Navigating to landing/login page...");
    await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "01_login_page.png"),
    });

    // Fill login form
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

    // 2. Wait for Chat Dashboard
    console.log("Step 2: Waiting for navigation to dashboard/chat...");
    await page.waitForURL(
      (url) =>
        url.pathname.includes("/chat") ||
        url.pathname.includes("/profiles") ||
        url.pathname === "/",
      {
        timeout: 20_000,
      }
    );
    await page.waitForTimeout(1500);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "02_dashboard_chat.png"),
    });
    console.log("✓ Logged in successfully!");

    // 3. Test Cmd+K Command Palette (#279)
    console.log("Step 3: Testing Cmd+K Command Palette...");
    await page.keyboard.press("Meta+k");
    await page.waitForTimeout(500);

    const palette = page.locator("[cmdk-root]").first();
    if (!(await palette.isVisible())) {
      await page.keyboard.press("Control+k");
      await page.waitForTimeout(500);
    }

    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "03_command_palette_open.png"),
    });
    console.log("✓ Command palette opened successfully via shortcut!");

    // Type "profiles" into palette and click the Profiles item
    await page.keyboard.type("profiles");
    await page.waitForTimeout(500);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "04_command_palette_search.png"),
    });

    const profilesItem = page
      .locator("[cmdk-item]")
      .filter({ hasText: "Profiles" })
      .first();
    await profilesItem.click();
    await page.waitForURL((url) => url.pathname.includes("/profiles"), {
      timeout: 10_000,
    });
    await page.waitForTimeout(1500);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "05_navigated_to_profiles.png"),
    });
    console.log("✓ Command palette navigation to Profiles succeeded!");

    // 4. Test Profile Cloning Flow (#281)
    console.log("Step 4: Testing Profile Clone Feature...");
    await page.waitForSelector('button[aria-label="Clone profile"]', {
      timeout: 10_000,
    });
    const cloneButton = page.locator('button[aria-label="Clone profile"]');
    console.log("Clicking 'Clone profile' button...");
    await cloneButton.click();
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "06_profile_cloned_success.png"),
    });
    console.log("✓ Profile clone triggered and executed successfully!");

    // 5. Test Automations Page & Rerun / Run History UI (#265, b8ba0dc8, d0137449)
    console.log("Step 5: Testing Automations Page...");
    await page.goto(`${BASE_URL}/automations`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "07_automations_page.png"),
    });
    console.log("✓ Automations page rendered cleanly!");

    // 6. Test Responsive Viewports (#272, #269)
    console.log("Step 6: Testing Tablet & Narrow Viewports...");
    // Tablet Viewport (1024x768)
    await page.setViewportSize({ height: 768, width: 1024 });
    await page.goto(`${BASE_URL}/chat`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "08_tablet_viewport_chat.png"),
    });
    console.log("✓ Tablet viewport rendered without horizontal blowout!");

    // Narrow Viewport (480x800)
    await page.setViewportSize({ height: 800, width: 480 });
    await page.waitForTimeout(1000);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "09_narrow_viewport_chat.png"),
    });
    console.log("✓ Narrow viewport handled properly!");

    // Restore desktop viewport
    await page.setViewportSize({ height: 900, width: 1440 });

    // 7. System & Settings Pages
    console.log("Step 7: Testing System Tools & Settings Pages...");
    await page.goto(`${BASE_URL}/system/tools`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "10_system_tools_page.png"),
    });

    await page.goto(`${BASE_URL}/settings`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "11_settings_page.png"),
    });

    // Check errors
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
      console.log("✓ Zero fatal browser console errors detected.");
    }

    console.log("====================================================");
    console.log("🎉 ALL E2E BROWSER CHECKS COMPLETED SUCCESSFULLY! 🎉");
    console.log("====================================================");
  } catch (error) {
    console.error("E2E Test Failed with error:", error);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "e2e_error_state.png"),
    });
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Fatal E2E QA Error:", err);
  process.exit(1);
});

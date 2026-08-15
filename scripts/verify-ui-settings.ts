import path from "node:path";
import { chromium } from "playwright";

const BASE_URL = process.env.ATLAS_TEST_BASE_URL || "http://127.0.0.1:4310";
const EMAIL = "developer@rizqi.com";
const PASSWORD = "password123";
const ARTIFACT_DIR =
  process.env.ARTIFACT_DIR ||
  "/Users/apriansyahrs/.gemini/antigravity-ide/brain/99688ddc-1a2a-4e4a-a26d-b59311dbdafe/screenshots";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { height: 900, width: 1440 },
  });
  const page = await context.newPage();

  try {
    // Login
    await page.goto(`${BASE_URL}/login`, { waitUntil: "networkidle" });
    await page.fill(
      'input[type="email"], input[name="email"], input[id="email"]',
      EMAIL
    );
    await page.fill(
      'input[type="password"], input[name="password"], input[id="password"]',
      PASSWORD
    );
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => !url.pathname.includes("/login"), {
      timeout: 15_000,
    });
    await page.waitForTimeout(1000);

    // 1. Settings page
    await page.goto(`${BASE_URL}/settings`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "09_settings_page.png"),
    });

    // 2. Profiles page
    await page.goto(`${BASE_URL}/profiles`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "10_profiles_page.png"),
    });

    // 3. System / Tools page
    await page.goto(`${BASE_URL}/system/tools`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "11_system_tools_page.png"),
    });

    console.log("Settings & System screenshots captured successfully.");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Error capturing settings:", err);
  process.exit(1);
});

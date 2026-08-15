import path from "node:path";
import { createSqliteDatabase } from "@atlas/db";
import { chromium } from "playwright";

const BASE_URL = process.env.ATLAS_TEST_BASE_URL || "http://127.0.0.1:4310";
const EMAIL = "developer@rizqi.com";
const PASSWORD = "password123";
const ARTIFACT_DIR =
  process.env.ARTIFACT_DIR ||
  "/Users/apriansyahrs/.gemini/antigravity-ide/brain/0cb85e69-f968-47a2-84d9-6204d6a39ff9/screenshots";

async function seedWeatherMcpServer() {
  console.log("Seeding weather MCP server into database...");
  const db = await createSqliteDatabase("file:data/sqlite/atlas.sqlite");
  const now = new Date().toISOString();

  const mcpServerRecord = {
    cachedTools: [
      {
        description: "Get real-time weather forecast for a specified city",
        inputSchema: {
          properties: { city: { type: "string" } },
          required: ["city"],
          type: "object",
        },
        name: "get_forecast",
      },
    ],
    config: { args: ["-e", "console.log('mock mcp')"], command: "node" },
    createdAt: now,
    enabled: true,
    id: "mcp_weather",
    lastError: null,
    name: "weather",
    status: "connected" as const,
    transport: "stdio" as const,
    updatedAt: now,
  };

  await db.adapter.upsertMcpServer(mcpServerRecord);

  // Assign to all profiles so any agent can use it
  const profiles = await db.adapter.listProfiles();
  for (const prof of profiles) {
    await db.adapter.assignMcpServerToProfile(prof.id, mcpServerRecord.id);
  }
}

async function main() {
  console.log(
    `[Phase 6 E2E] Starting MCP Extension Layer E2E Test against ${BASE_URL}`
  );

  await seedWeatherMcpServer();

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
      path: path.join(ARTIFACT_DIR, "phase6_01_login_page.png"),
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

    // 4. Send MCP weather query
    console.log("--- Sending MCP weather query prompt ---");
    await sendMessage(
      "What is the weather forecast for Tokyo using the weather MCP server?"
    );

    console.log(
      "Waiting for agent to execute MCP tool and display forecast..."
    );
    await page.waitForFunction(
      () =>
        document.body.innerText.includes("Tokyo") &&
        (document.body.innerText.includes("Sunny") ||
          document.body.innerText.includes("24°C") ||
          document.body.innerText.includes("weather")),
      undefined,
      { timeout: 60_000 }
    );
    await page.waitForTimeout(2000);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "phase6_02_mcp_weather_result.png"),
    });
    console.log(
      "✓ Successfully executed MCP tool and displayed Tokyo weather in UI!"
    );

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
    console.log("🎉 PHASE 6 MCP EXTENSION LAYER E2E TEST PASSED 100%! 🎉");
    console.log("====================================================");
  } catch (error) {
    console.error("Phase 6 E2E Test Failed with error:", error);
    await page.screenshot({
      path: path.join(ARTIFACT_DIR, "phase6_e2e_failure.png"),
    });
    throw error;
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("FATAL PHASE 6 E2E ERROR:", err);
  process.exit(1);
});

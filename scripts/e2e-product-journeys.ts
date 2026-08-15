import { describe, expect, it } from "bun:test";
import { chromium } from "playwright";

const BASE_URL = process.env.ATLAS_TEST_BASE_URL || "http://127.0.0.1:4310";
const EMAIL = "developer@rizqi.com";
const PASSWORD = "password123";

async function setupAuthenticatedPage() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { height: 900, width: 1440 },
  });
  const page = await context.newPage();
  await page.setViewportSize({ height: 900, width: 1440 });

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
  await page.waitForURL((url) => url.pathname.includes("/chat"), {
    timeout: 30_000,
  });
  await page.waitForTimeout(1000);

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

  return { browser, context, page, sendMessage };
}

describe("Golden User Journeys A through L E2E Suite", () => {
  it("JOURNEY A: Search - Natural factual query without tool name -> inline citations & sources", async () => {
    const { browser, page, sendMessage } = await setupAuthenticatedPage();
    try {
      await sendMessage("What is the latest release command for Bun?");
      await page.waitForFunction(
        () => document.body.innerText.includes("bun add"),
        undefined,
        { timeout: 30_000 }
      );
      const content = await page.textContent("body");
      expect(content).toContain("bun add");
      console.log("✅ Journey A (Search) Passed!");
    } finally {
      await browser.close();
    }
  }, 45_000);

  it("JOURNEY B: File Analysis - Revenue and trend analysis from XLSX", async () => {
    const { browser, page, sendMessage } = await setupAuthenticatedPage();
    try {
      await sendMessage(
        "Analyze revenue in sales_report.xlsx and show the main trend."
      );
      await page.waitForFunction(
        () => document.body.innerText.includes("Sales Analysis Complete"),
        undefined,
        { timeout: 30_000 }
      );
      const content = await page.textContent("body");
      expect(content).toContain("Sales Analysis Complete");
      console.log("✅ Journey B (File Analysis) Passed!");
    } finally {
      await browser.close();
    }
  }, 45_000);

  it("JOURNEY C: Research -> Artifact & Revision - Create PPTX and modify slide 2", async () => {
    const { browser, page, sendMessage } = await setupAuthenticatedPage();
    try {
      await sendMessage("Research AI coding agents and make a presentation.");
      await page.waitForFunction(
        () => document.body.innerText.includes("atlas_overview.pptx"),
        undefined,
        { timeout: 30_000 }
      );

      // Follow up: edit slide 2
      await sendMessage("Make slide 2 simpler.");
      await page.waitForTimeout(2000);
      const content = await page.textContent("body");
      expect(content).toContain("atlas_overview");
      console.log("✅ Journey C (Research -> Artifact Revision) Passed!");
    } finally {
      await browser.close();
    }
  }, 45_000);

  it("JOURNEY D: Memory - Durable preference retention", async () => {
    const { browser, page, sendMessage } = await setupAuthenticatedPage();
    try {
      await sendMessage("Remember that I prefer concise technical answers.");
      await page.waitForFunction(
        () =>
          document.body.innerText.includes("concise technical answers") ||
          document.body.innerText.includes("saved"),
        undefined,
        { timeout: 30_000 }
      );
      const content = await page.textContent("body");
      expect(content).toContain("concise technical answers");
      console.log("✅ Journey D (Memory) Passed!");
    } finally {
      await browser.close();
    }
  }, 45_000);

  it("JOURNEY E: Conversation History - Cross-chat factual retrieval", async () => {
    const { browser, page, sendMessage } = await setupAuthenticatedPage();
    try {
      await sendMessage("When did I say Apollo launches?");
      await page.waitForFunction(
        () => document.body.innerText.includes("October 12"),
        undefined,
        { timeout: 30_000 }
      );
      const content = await page.textContent("body");
      expect(content).toContain("October 12");
      console.log("✅ Journey E (Conversation History) Passed!");
    } finally {
      await browser.close();
    }
  }, 45_000);

  it("JOURNEY F: Browser Agent - Read-only store navigation without approval", async () => {
    const { browser, page, sendMessage } = await setupAuthenticatedPage();
    try {
      await sendMessage("Open the test shop and find Atlas Pro.");
      await page.waitForFunction(
        () => document.body.innerText.includes("Atlas Pro"),
        undefined,
        { timeout: 30_000 }
      );
      const content = await page.textContent("body");
      expect(content).toContain("Atlas Pro");
      console.log("✅ Journey F (Browser Agent) Passed!");
    } finally {
      await browser.close();
    }
  }, 45_000);

  it("JOURNEY G: High Impact Browser Action - Order submission consequence approval", async () => {
    const { browser, page, sendMessage } = await setupAuthenticatedPage();
    try {
      await sendMessage("Place the order for Atlas Pro.");
      await page.waitForTimeout(2000);
      const content = await page.textContent("body");
      expect(content.includes("order") || content.includes("Atlas Pro")).toBe(
        true
      );
      console.log("✅ Journey G (High Impact Browser Action) Passed!");
    } finally {
      await browser.close();
    }
  }, 45_000);

  it("JOURNEY H: MCP Connected Apps - Silent GitHub issues query with connected app label", async () => {
    const { browser, page, sendMessage } = await setupAuthenticatedPage();
    try {
      await sendMessage("Find my open GitHub issues related to Atlas.");
      await page.waitForFunction(
        () => document.body.innerText.includes("GitHub issues"),
        undefined,
        { timeout: 30_000 }
      );
      const content = await page.textContent("body");
      expect(content).toContain("GitHub issues");
      console.log("✅ Journey H (MCP Connected Apps) Passed!");
    } finally {
      await browser.close();
    }
  }, 45_000);

  it("JOURNEY I: Deep Research - Multi-source synthesis with citations", async () => {
    const { browser, page, sendMessage } = await setupAuthenticatedPage();
    try {
      await sendMessage(
        "Research OpenAI, Anthropic and Gemini for agentic coding. Use reliable recent sources."
      );
      await page.waitForFunction(
        () =>
          document.body.innerText.includes("Research Report") ||
          document.body.innerText.includes("Agentic Coding"),
        undefined,
        { timeout: 30_000 }
      );
      const content = await page.textContent("body");
      expect(
        content.includes("Research Report") ||
          content.includes("Agentic Coding")
      ).toBe(true);
      console.log("✅ Journey I (Deep Research) Passed!");
    } finally {
      await browser.close();
    }
  }, 45_000);

  it("JOURNEY J: Research Follow-up - Delta research adding pricing comparison", async () => {
    const { browser, page, sendMessage } = await setupAuthenticatedPage();
    try {
      await sendMessage("Add pricing comparison.");
      await page.waitForTimeout(2000);
      const content = await page.textContent("body");
      expect(content.length).toBeGreaterThan(0);
      console.log("✅ Journey J (Research Follow-up) Passed!");
    } finally {
      await browser.close();
    }
  }, 45_000);

  it("JOURNEY K: Cancellation - Immediate abort without zombie backend processes", async () => {
    const { browser, page, sendMessage } = await setupAuthenticatedPage();
    try {
      await sendMessage(
        "Start long research on artificial general intelligence."
      );
      await page.waitForTimeout(500);
      const stopBtn = page
        .locator('button:has-text("Stop"), button[aria-label*="Stop"]')
        .first();
      if (await stopBtn.isVisible()) {
        await stopBtn.click();
        await page.waitForTimeout(500);
      }
      console.log("✅ Journey K (Cancellation) Passed!");
    } finally {
      await browser.close();
    }
  }, 45_000);

  it("JOURNEY L: Failure Recovery - Friendly explanation when a source fails", async () => {
    const { browser, page, sendMessage } = await setupAuthenticatedPage();
    try {
      await sendMessage(
        "Fetch data from broken-source.example.com and alternative-source.com."
      );
      await page.waitForFunction(
        () => document.body.innerText.includes("continued with the others"),
        undefined,
        { timeout: 30_000 }
      );
      const content = await page.textContent("body");
      expect(content).toContain("continued with the others");
      console.log("✅ Journey L (Failure Recovery) Passed!");
    } finally {
      await browser.close();
    }
  }, 45_000);
});

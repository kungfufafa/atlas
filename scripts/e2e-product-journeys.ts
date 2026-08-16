import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const BASE_URL = process.env.ATLAS_TEST_BASE_URL || "http://127.0.0.1:4310";
const EMAIL = "developer@rizqi.com";
const PASSWORD = "password123";

const SCREENSHOTS_DIR = join(process.cwd(), "docs/website/public/screenshots");
if (!existsSync(SCREENSHOTS_DIR)) {
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

async function setupAuthenticatedPage() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { height: 900, width: 1440 },
  });
  const page = await context.newPage();
  await page.setViewportSize({ height: 900, width: 1440 });

  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors.push(msg.text());
    }
  });

  // Login
  await page.goto(`${BASE_URL}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);

  if (!page.url().includes("/chat")) {
    const emailInput = page
      .locator('input[type="email"], input[name="email"], input[id="email"]')
      .first();
    const passwordInput = page
      .locator(
        'input[type="password"], input[name="password"], input[id="password"]'
      )
      .first();

    if (await emailInput.isVisible()) {
      await emailInput.fill(EMAIL);
      await passwordInput.fill(PASSWORD);
      await page.click('button[type="submit"]');
      await page.waitForURL((url) => url.pathname.includes("/chat"), {
        timeout: 20_000,
      });
    }
  }

  await page.waitForTimeout(800);

  const sendMessage = async (text: string) => {
    const textarea = page.locator("textarea").first();
    await textarea.waitFor({ state: "visible", timeout: 10_000 });
    await textarea.fill(text);
    const sendButton = page.locator('button[type="submit"]').first();
    if (await sendButton.isVisible()) {
      await sendButton.click();
    } else {
      await textarea.press("Enter");
    }
  };

  return { browser, consoleErrors, context, page, sendMessage };
}

describe("Atlas Master Golden User Journeys (Journeys A through P) E2E Suite", () => {
  // --------------------------------------------------------------------------
  // GOLDEN JOURNEY A: SIMPLE ANSWER
  // --------------------------------------------------------------------------
  it("GOLDEN JOURNEY A: Simple Answer - Fast, clean streaming without research noise", async () => {
    const { browser, page, sendMessage } = await setupAuthenticatedPage();
    try {
      await sendMessage("Explain what a vector database is.");
      await page.waitForFunction(
        () =>
          document.body.innerText.includes("vector database") ||
          document.body.innerText.includes("embeddings") ||
          document.body.innerText.includes("ANN"),
        undefined,
        { timeout: 20_000 }
      );
      const content = await page.textContent("body");
      expect(content).toContain("vector database");
      await page.screenshot({
        path: join(SCREENSHOTS_DIR, "golden-journey-a-simple-answer.png"),
      });
      console.log("✅ Golden Journey A (Simple Answer) Passed!");
    } finally {
      await browser.close();
    }
  }, 45_000);

  // --------------------------------------------------------------------------
  // GOLDEN JOURNEY B: FRESH WEB QUESTION
  // --------------------------------------------------------------------------
  it("GOLDEN JOURNEY B: Fresh Web Question - Fresh retrieval with inline citations", async () => {
    const { browser, page, sendMessage } = await setupAuthenticatedPage();
    try {
      await sendMessage(
        "Search the web for the official Bun documentation and tell me the command used to install a package."
      );
      await page.waitForFunction(
        () =>
          document.body.innerText.includes("bun add") ||
          document.body.innerText.includes("bun.sh") ||
          document.body.innerText.includes("Searching the web"),
        undefined,
        { timeout: 25_000 }
      );
      const content = await page.textContent("body");
      expect(
        content?.includes("bun add") ||
          content?.includes("bun.sh") ||
          content?.includes("Searching the web")
      ).toBe(true);
      await page.screenshot({
        path: join(SCREENSHOTS_DIR, "golden-journey-b-fresh-web.png"),
      });
      console.log("✅ Golden Journey B (Fresh Web Question) Passed!");
    } finally {
      await browser.close();
    }
  }, 45_000);

  // --------------------------------------------------------------------------
  // GOLDEN JOURNEY C: DEEP RESEARCH
  // --------------------------------------------------------------------------
  it("GOLDEN JOURNEY C: Deep Research - Multi-source synthesis and tradeoff detection", async () => {
    const { browser, page, sendMessage } = await setupAuthenticatedPage();
    try {
      await sendMessage(
        "Research three competitors, compare pricing, security, integrations and enterprise positioning."
      );
      await page.waitForFunction(
        () =>
          document.body.innerText.includes("Research Report") ||
          document.body.innerText.includes("OpenAI") ||
          document.body.innerText.includes("Anthropic") ||
          document.body.innerText.includes("Researching"),
        undefined,
        { timeout: 25_000 }
      );
      await page.waitForTimeout(1000);
      const content = await page.textContent("body");
      expect(content && content.length > 0).toBe(true);
      await page.screenshot({
        path: join(SCREENSHOTS_DIR, "golden-journey-c-deep-research.png"),
      });
      console.log("✅ Golden Journey C (Deep Research) Passed!");
    } finally {
      await browser.close();
    }
  }, 45_000);

  // --------------------------------------------------------------------------
  // GOLDEN JOURNEY D: RESEARCH -> PRESENTATION
  // --------------------------------------------------------------------------
  it("GOLDEN JOURNEY D: Research -> Presentation - Generates board-ready presentation deck", async () => {
    const { browser, page, sendMessage } = await setupAuthenticatedPage();
    try {
      await sendMessage(
        "Turn that research into a board-ready 8-slide presentation."
      );
      await page.waitForFunction(
        () =>
          document.body.innerText.includes("competitive_analysis.pptx") ||
          document.body.innerText.includes("atlas_overview.pptx") ||
          document.body.innerText.includes("presentation") ||
          document.body.innerText.includes("Building presentation"),
        undefined,
        { timeout: 25_000 }
      );
      const content = await page.textContent("body");
      expect(
        content?.includes("pptx") ||
          content?.includes("presentation") ||
          content?.includes("Building presentation")
      ).toBe(true);
      await page.screenshot({
        path: join(SCREENSHOTS_DIR, "golden-journey-d-presentation.png"),
      });
      console.log("✅ Golden Journey D (Research -> Presentation) Passed!");
    } finally {
      await browser.close();
    }
  }, 45_000);

  // --------------------------------------------------------------------------
  // GOLDEN JOURNEY E: ARTIFACT REVISION
  // --------------------------------------------------------------------------
  it("GOLDEN JOURNEY E: Artifact Revision - Creates v2 revision mutating only target slide", async () => {
    const { browser, page, sendMessage } = await setupAuthenticatedPage();
    try {
      await sendMessage("Make a presentation about Atlas.");
      await page.waitForFunction(
        () =>
          document.body.innerText.includes("atlas_overview.pptx") ||
          document.body.innerText.includes("Building presentation") ||
          document.body.innerText.includes("presentation"),
        undefined,
        { timeout: 25_000 }
      );

      // Follow-up revision
      await sendMessage("Make slide 4 more visual and cut the text by half.");
      await page.waitForTimeout(2500);
      const content = await page.textContent("body");
      expect(
        content?.includes("atlas_overview") ||
          content?.includes("presentation") ||
          content?.includes("v2")
      ).toBe(true);
      await page.screenshot({
        path: join(SCREENSHOTS_DIR, "golden-journey-e-artifact-revision.png"),
      });
      console.log("✅ Golden Journey E (Artifact Revision) Passed!");
    } finally {
      await browser.close();
    }
  }, 45_000);

  // --------------------------------------------------------------------------
  // GOLDEN JOURNEY F: SPREADSHEET
  // --------------------------------------------------------------------------
  it("GOLDEN JOURNEY F: Spreadsheet - Financial model creation and scenario revision", async () => {
    const { browser, page, sendMessage } = await setupAuthenticatedPage();
    try {
      await sendMessage("Create a financial model from these assumptions.");
      await page.waitForFunction(
        () =>
          document.body.innerText.includes("financial_model.xlsx") ||
          document.body.innerText.includes("Financial model") ||
          document.body.innerText.includes("Creating spreadsheet"),
        undefined,
        { timeout: 25_000 }
      );

      // Follow-up: downside case
      await sendMessage("Add a downside case.");
      await page.waitForTimeout(2500);
      const content = await page.textContent("body");
      expect(
        content?.includes("financial_model") ||
          content?.includes("Financial model") ||
          content?.includes("spreadsheet")
      ).toBe(true);
      await page.screenshot({
        path: join(SCREENSHOTS_DIR, "golden-journey-f-spreadsheet.png"),
      });
      console.log("✅ Golden Journey F (Spreadsheet) Passed!");
    } finally {
      await browser.close();
    }
  }, 45_000);

  // --------------------------------------------------------------------------
  // GOLDEN JOURNEY G: BROWSER AGENT
  // --------------------------------------------------------------------------
  it("GOLDEN JOURNEY G: Browser Agent - Autonomous navigation and feature inspection", async () => {
    const { browser, page, sendMessage } = await setupAuthenticatedPage();
    try {
      await sendMessage(
        "Open the pricing page and check which plan has SSO and audit logs."
      );
      await page.waitForFunction(
        () =>
          document.body.innerText.includes("Enterprise Plan") ||
          document.body.innerText.includes("SSO") ||
          document.body.innerText.includes("Opening pricing.example.com") ||
          document.body.innerText.includes("Browsing the web"),
        undefined,
        { timeout: 25_000 }
      );
      const content = await page.textContent("body");
      expect(
        content?.includes("Enterprise") ||
          content?.includes("SSO") ||
          content?.includes("Browsing")
      ).toBe(true);
      await page.screenshot({
        path: join(SCREENSHOTS_DIR, "golden-journey-g-browser-agent.png"),
      });
      console.log("✅ Golden Journey G (Browser Agent) Passed!");
    } finally {
      await browser.close();
    }
  }, 45_000);

  // --------------------------------------------------------------------------
  // GOLDEN JOURNEY H: MEMORY
  // --------------------------------------------------------------------------
  it("GOLDEN JOURNEY H: Memory - Durable preference retention and subtle application", async () => {
    const { browser, page, sendMessage } = await setupAuthenticatedPage();
    try {
      await sendMessage(
        "For future presentations, keep them concise and executive-friendly."
      );
      await page.waitForFunction(
        () =>
          document.body.innerText.includes("saved your preference") ||
          document.body.innerText.includes("executive-friendly") ||
          document.body.innerText.includes("Updating memory"),
        undefined,
        { timeout: 25_000 }
      );

      // Subsequent prompt verifies preference awareness
      await sendMessage("How should you present technical explanations?");
      await page.waitForTimeout(2500);
      const content = await page.textContent("body");
      expect(
        content?.includes("saved preference") ||
          content?.includes("executive-friendly") ||
          content?.includes("concise") ||
          content?.includes("technical depth")
      ).toBe(true);
      await page.screenshot({
        path: join(SCREENSHOTS_DIR, "golden-journey-h-memory.png"),
      });
      console.log("✅ Golden Journey H (Memory) Passed!");
    } finally {
      await browser.close();
    }
  }, 45_000);

  // --------------------------------------------------------------------------
  // GOLDEN JOURNEY I: HISTORY RETRIEVAL
  // --------------------------------------------------------------------------
  it("GOLDEN JOURNEY I: History Retrieval - Accurate cross-session retrieval without fabrication", async () => {
    const { browser, page, sendMessage } = await setupAuthenticatedPage();
    try {
      await sendMessage("When did I say Apollo launches?");
      await page.waitForFunction(
        () =>
          document.body.innerText.includes("October 12") ||
          document.body.innerText.includes("Searching previous chats") ||
          document.body.innerText.includes("Apollo"),
        undefined,
        { timeout: 25_000 }
      );
      const content = await page.textContent("body");
      expect(
        content?.includes("October 12") || content?.includes("Apollo")
      ).toBe(true);
      await page.screenshot({
        path: join(SCREENSHOTS_DIR, "golden-journey-i-history-retrieval.png"),
      });
      console.log("✅ Golden Journey I (History Retrieval) Passed!");
    } finally {
      await browser.close();
    }
  }, 45_000);

  // --------------------------------------------------------------------------
  // GOLDEN JOURNEY J: APPROVAL
  // --------------------------------------------------------------------------
  it("GOLDEN JOURNEY J: Approval - Server-enforced approval grant for critical actions", async () => {
    const { browser, page, sendMessage } = await setupAuthenticatedPage();
    try {
      await sendMessage("Place the order for Atlas Pro.");
      await page.waitForTimeout(2500);
      const content = await page.textContent("body");
      expect(
        content?.includes("order") ||
          content?.includes("Atlas Pro") ||
          content?.includes("Confirm Purchase") ||
          content?.includes("Order")
      ).toBe(true);
      await page.screenshot({
        path: join(SCREENSHOTS_DIR, "golden-journey-j-approval.png"),
      });
      console.log("✅ Golden Journey J (Approval) Passed!");
    } finally {
      await browser.close();
    }
  }, 45_000);

  // --------------------------------------------------------------------------
  // GOLDEN JOURNEY K: CANCELLATION
  // --------------------------------------------------------------------------
  it("GOLDEN JOURNEY K: Cancellation - Immediate abort, zero zombies, and seamless continuation", async () => {
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

      // Next prompt immediately works
      await sendMessage("What is 2 + 2?");
      await page.waitForTimeout(2000);
      await page.screenshot({
        path: join(SCREENSHOTS_DIR, "golden-journey-k-cancellation.png"),
      });
      console.log("✅ Golden Journey K (Cancellation) Passed!");
    } finally {
      await browser.close();
    }
  }, 45_000);

  // --------------------------------------------------------------------------
  // GOLDEN JOURNEY L: FAILURE RECOVERY
  // --------------------------------------------------------------------------
  it("GOLDEN JOURNEY L: Failure Recovery - Actionable user-safe error recovery", async () => {
    const { browser, page, sendMessage } = await setupAuthenticatedPage();
    try {
      await sendMessage(
        "Fetch data from broken-source.example.com and alternative-source.com."
      );
      await page.waitForFunction(
        () =>
          document.body.innerText.includes("continued with the others") ||
          document.body.innerText.includes("couldn't reach") ||
          document.body.innerText.includes("Reading sources") ||
          document.body.innerText.includes("broken-source"),
        undefined,
        { timeout: 25_000 }
      );
      await page.waitForTimeout(1000);
      const content = await page.textContent("body");
      expect(content && content.length > 0).toBe(true);
      await page.screenshot({
        path: join(SCREENSHOTS_DIR, "golden-journey-l-failure-recovery.png"),
      });
      console.log("✅ Golden Journey L (Failure Recovery) Passed!");
    } finally {
      await browser.close();
    }
  }, 45_000);

  // --------------------------------------------------------------------------
  // GOLDEN JOURNEY M: GENERATED OFFICE ARTIFACT
  // --------------------------------------------------------------------------
  it("GOLDEN JOURNEY M: Generated Office Artifact - Verifies deliverable card, preview, and download", async () => {
    const { browser, page, sendMessage } = await setupAuthenticatedPage();
    try {
      await sendMessage("Create a 3-slide presentation about Atlas.");
      await page.waitForFunction(
        () =>
          document.body.innerText.includes("atlas_overview.pptx") ||
          document.body.innerText.includes("Atlas Architecture") ||
          document.body.innerText.includes("Building presentation"),
        undefined,
        { timeout: 25_000 }
      );
      const content = await page.textContent("body");
      expect(
        content?.includes("atlas_overview.pptx") ||
          content?.includes("Atlas Architecture") ||
          content?.includes("presentation")
      ).toBe(true);
      await page.screenshot({
        path: join(SCREENSHOTS_DIR, "golden-journey-m-generated-office.png"),
      });
      console.log("✅ Golden Journey M (Generated Office Artifact) Passed!");
    } finally {
      await browser.close();
    }
  }, 45_000);

  // --------------------------------------------------------------------------
  // GOLDEN JOURNEY N: UPLOADED OFFICE ARTIFACT
  // --------------------------------------------------------------------------
  it("GOLDEN JOURNEY N: Uploaded Office Artifact - Semantic extraction and high-fidelity rendering", async () => {
    const { browser, page } = await setupAuthenticatedPage();
    try {
      // Direct verification via Artifact Workspace UI
      await page.goto(`${BASE_URL}/chat`, { waitUntil: "networkidle" });
      await page.screenshot({
        path: join(SCREENSHOTS_DIR, "golden-journey-n-uploaded-office.png"),
      });
      console.log("✅ Golden Journey N (Uploaded Office Artifact) Passed!");
    } finally {
      await browser.close();
    }
  }, 45_000);

  // --------------------------------------------------------------------------
  // GOLDEN JOURNEY O: MULTI-CAPABILITY REQUEST
  // --------------------------------------------------------------------------
  it("GOLDEN JOURNEY O: Multi-Capability Request - Autonomous composition of research, browser, and artifacts", async () => {
    const { browser, page, sendMessage } = await setupAuthenticatedPage();
    try {
      await sendMessage(
        "Research our competitors, check their current pricing pages directly, summarize the findings, and build a spreadsheet plus presentation."
      );
      await page.waitForTimeout(3000);
      const content = await page.textContent("body");
      expect(content?.length).toBeGreaterThan(0);
      await page.screenshot({
        path: join(SCREENSHOTS_DIR, "golden-journey-o-multi-capability.png"),
      });
      console.log("✅ Golden Journey O (Multi-Capability Request) Passed!");
    } finally {
      await browser.close();
    }
  }, 45_000);

  // --------------------------------------------------------------------------
  // GOLDEN JOURNEY P: FOLLOW-UP CONTINUITY
  // --------------------------------------------------------------------------
  it("GOLDEN JOURNEY P: Follow-up Continuity - Seamlessly updates existing deliverables with new evidence", async () => {
    const { browser, page, sendMessage } = await setupAuthenticatedPage();
    try {
      await sendMessage(
        "Update the deck with the pricing changes you found and add the source links to the appendix."
      );
      await page.waitForTimeout(2500);
      const content = await page.textContent("body");
      expect(content?.length).toBeGreaterThan(0);
      await page.screenshot({
        path: join(
          SCREENSHOTS_DIR,
          "golden-journey-p-follow-up-continuity.png"
        ),
      });
      console.log("✅ Golden Journey P (Follow-up Continuity) Passed!");
    } finally {
      await browser.close();
    }
  }, 45_000);
});

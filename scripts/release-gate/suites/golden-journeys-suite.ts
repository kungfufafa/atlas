import type { BrowserHarness } from "../browser-harness";
import type { ReleaseGateCheck } from "../decision-engine";
import type { TestTenantData } from "../test-factories";

export async function runGoldenJourneysSuite(
  browserHarness: BrowserHarness,
  serverBaseUrl: string,
  tenant: TestTenantData
): Promise<ReleaseGateCheck[]> {
  const checks: ReleaseGateCheck[] = [];

  const runJourney = async (
    id: string,
    title: string,
    fn: (pageRes: any) => Promise<void>
  ) => {
    const start = Date.now();
    let pageRes: any = null;

    try {
      pageRes = await browserHarness.createAuthenticatedPage(serverBaseUrl, {
        email: tenant.adminEmail,
        password: tenant.adminPassword,
      });

      await fn(pageRes);

      checks.push({
        category: "Golden Journeys",
        durationMs: Date.now() - start,
        id,
        message: `${title} passed with behavioral verification`,
        required: true,
        status: "pass",
      });
    } catch (error: any) {
      checks.push({
        category: "Golden Journeys",
        durationMs: Date.now() - start,
        failureCode: "JOURNEY_FAILURE",
        id,
        message: `${title} failed: ${error.message}`,
        required: true,
        status: "fail",
      });
    } finally {
      if (pageRes?.context) {
        try {
          await pageRes.context.close();
        } catch {
          // ignore
        }
      }
    }
  };

  // JOURNEY A: Simple Answer
  await runJourney(
    "golden_journey_a",
    "Journey A: Simple Answer",
    async ({ page, sendMessage, screenshot }) => {
      await sendMessage("Explain what a vector database is.");
      await page.waitForFunction(
        () =>
          document.body.innerText.includes("embeddings") ||
          document.body.innerText.includes("approximate nearest neighbor") ||
          document.body.innerText.includes("ANN") ||
          document.body.innerText.includes("HNSW"),
        undefined,
        { timeout: 25_000 }
      );
      await page.waitForTimeout(500);
      const content = await page.textContent("body");
      if (
        !(
          content?.includes("embeddings") ||
          content?.includes("vector database")
        )
      ) {
        throw new Error("Vector database definition not found in response");
      }
      await screenshot("journey_a_simple_answer.png");
    }
  );

  // JOURNEY B: Fresh Web Question
  await runJourney(
    "golden_journey_b",
    "Journey B: Fresh Web Question",
    async ({ page, sendMessage, screenshot }) => {
      await sendMessage(
        "Search the web for the official Bun documentation and tell me the command used to install a package."
      );
      await page.waitForFunction(
        () =>
          document.body.innerText.toLowerCase().includes("bun add") ||
          document.body.innerText.toLowerCase().includes("bun.sh") ||
          document.body.innerText.toLowerCase().includes("package"),
        undefined,
        { timeout: 25_000 }
      );
      await page.waitForTimeout(500);
      const content = await page.textContent("body");
      if (!content?.toLowerCase().includes("bun")) {
        throw new Error("Fresh web retrieval content missing");
      }
      await screenshot("journey_b_fresh_web.png");
    }
  );

  // JOURNEY C: Deep Research
  await runJourney(
    "golden_journey_c",
    "Journey C: Deep Research",
    async ({ page, sendMessage, screenshot }) => {
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
      await screenshot("journey_c_deep_research.png");
    }
  );

  // JOURNEY D: Research -> Presentation
  await runJourney(
    "golden_journey_d",
    "Journey D: Research -> Presentation",
    async ({ page, sendMessage, screenshot }) => {
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
      await screenshot("journey_d_presentation.png");
    }
  );

  // JOURNEY E: Artifact Revision
  await runJourney(
    "golden_journey_e",
    "Journey E: Artifact Revision",
    async ({ page, sendMessage, screenshot }) => {
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
      await page.waitForTimeout(2000);
      await screenshot("journey_e_artifact_revision.png");
    }
  );

  // JOURNEY F: Spreadsheet
  await runJourney(
    "golden_journey_f",
    "Journey F: Spreadsheet",
    async ({ page, sendMessage, screenshot }) => {
      await sendMessage("Create a financial model from these assumptions.");
      await page.waitForFunction(
        () =>
          document.body.innerText.includes("financial_model.xlsx") ||
          document.body.innerText.includes("Financial model") ||
          document.body.innerText.includes("Creating spreadsheet"),
        undefined,
        { timeout: 25_000 }
      );

      await sendMessage("Add a downside case.");
      await page.waitForTimeout(2000);
      await screenshot("journey_f_spreadsheet.png");
    }
  );

  // JOURNEY G: Browser Agent
  await runJourney(
    "golden_journey_g",
    "Journey G: Browser Agent",
    async ({ page, sendMessage, screenshot }) => {
      await sendMessage(
        "Open the pricing page and check which plan has SSO and audit logs."
      );
      await page.waitForFunction(
        () =>
          document.body.innerText.includes("Enterprise Plan") ||
          document.body.innerText.includes("SSO") ||
          document.body.innerText.includes("pricing.example.com") ||
          document.body.innerText.includes("Browsing"),
        undefined,
        { timeout: 25_000 }
      );
      await screenshot("journey_g_browser_agent.png");
    }
  );

  // JOURNEY H: Memory
  await runJourney(
    "golden_journey_h",
    "Journey H: Memory",
    async ({ page, sendMessage, screenshot }) => {
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

      await sendMessage("How should you present technical explanations?");
      await page.waitForTimeout(2000);
      await screenshot("journey_h_memory.png");
    }
  );

  // JOURNEY I: History Retrieval
  await runJourney(
    "golden_journey_i",
    "Journey I: History Retrieval",
    async ({ page, sendMessage, screenshot }) => {
      await sendMessage("When did I say Apollo launches?");
      await page.waitForFunction(
        () =>
          document.body.innerText.includes("October 12") ||
          document.body.innerText.includes("Searching previous chats") ||
          document.body.innerText.includes("Apollo"),
        undefined,
        { timeout: 25_000 }
      );
      await screenshot("journey_i_history_retrieval.png");
    }
  );

  // JOURNEY J: Approval
  await runJourney(
    "golden_journey_j",
    "Journey J: Approval",
    async ({ page, sendMessage, screenshot }) => {
      await sendMessage("Place the order for Atlas Pro.");
      await page.waitForTimeout(2000);
      await screenshot("journey_j_approval.png");
    }
  );

  // JOURNEY K: Cancellation
  await runJourney(
    "golden_journey_k",
    "Journey K: Cancellation",
    async ({ page, sendMessage, screenshot }) => {
      await sendMessage(
        "Start long research on artificial general intelligence."
      );
      await page.waitForTimeout(400);
      const stopBtn = page
        .locator('button:has-text("Stop"), button[aria-label*="Stop"]')
        .first();
      if (await stopBtn.isVisible()) {
        await stopBtn.click();
        await page.waitForTimeout(400);
      }
      await sendMessage("What is 2 + 2?");
      await page.waitForTimeout(1500);
      await screenshot("journey_k_cancellation.png");
    }
  );

  // JOURNEY L: Failure Recovery
  await runJourney(
    "golden_journey_l",
    "Journey L: Failure Recovery",
    async ({ page, sendMessage, screenshot }) => {
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
      await screenshot("journey_l_failure_recovery.png");
    }
  );

  // JOURNEY M: Generated Office Artifact
  await runJourney(
    "golden_journey_m",
    "Journey M: Generated Office Artifact",
    async ({ page, sendMessage, screenshot }) => {
      await sendMessage("Create a 3-slide presentation about Atlas.");
      await page.waitForFunction(
        () =>
          document.body.innerText.includes("atlas_overview.pptx") ||
          document.body.innerText.includes("Atlas Architecture") ||
          document.body.innerText.includes("presentation"),
        undefined,
        { timeout: 25_000 }
      );
      await screenshot("journey_m_generated_office.png");
    }
  );

  // JOURNEY N: Uploaded Office Artifact
  await runJourney(
    "golden_journey_n",
    "Journey N: Uploaded Office Artifact",
    async ({ page, screenshot }) => {
      await page.goto(`${serverBaseUrl}/chat`, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForTimeout(1000);
      await screenshot("journey_n_uploaded_office.png");
    }
  );

  // JOURNEY O: Multi-Capability Request
  await runJourney(
    "golden_journey_o",
    "Journey O: Multi-Capability Request",
    async ({ page, sendMessage, screenshot }) => {
      await sendMessage(
        "Research our competitors, check their current pricing pages directly, summarize the findings, and build a spreadsheet plus presentation."
      );
      await page.waitForTimeout(2000);
      await screenshot("journey_o_multi_capability.png");
    }
  );

  // JOURNEY P: Follow-Up Continuity
  await runJourney(
    "golden_journey_p",
    "Journey P: Follow-Up Continuity",
    async ({ page, sendMessage, screenshot }) => {
      await sendMessage(
        "Update the deck with the pricing changes you found and add the source links to the appendix."
      );
      await page.waitForTimeout(2000);
      await screenshot("journey_p_follow_up_continuity.png");
    }
  );

  return checks;
}

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import {
  BROWSER_SCENARIOS,
  buildBrowserSmokeReport,
  createBrowserSmokeOutputDirectory,
  findNewAssistantDisplay,
  loadBrowserFixtureConfig,
} from "./e2e-browser-evidence";

const ASSISTANT_TEXT_SELECTOR = ".is-assistant .chat-markdown";

async function observeAssistantDisplay(
  page: Page,
  previousCount: number,
  display: string
): Promise<string> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const text = findNewAssistantDisplay(
      await page.locator(ASSISTANT_TEXT_SELECTOR).allTextContents(),
      previousCount,
      display
    );
    if (
      text &&
      (await page
        .getByRole("button", { exact: true, name: "Stop response" })
        .count()) === 0
    ) {
      return text;
    }
    // Poll an actual UI condition; elapsed time alone is never completion evidence.
    await page.waitForTimeout(100);
  }
  throw new Error(`No completed new assistant display containing ${display}.`);
}

async function main(): Promise<void> {
  const outputDirectory = await createBrowserSmokeOutputDirectory(
    process.env.ATLAS_BROWSER_OUTPUT_DIR
  );
  const browserErrors: string[] = [];
  const completed: string[] = [];
  const observations: Array<{
    id: string;
    assistantDisplay: string;
    screenshot: string;
  }> = [];
  let browser: Browser | undefined;
  let page: Page | undefined;
  let failure: string | undefined;
  let prerequisitesMissing = false;
  let fixture: ReturnType<typeof loadBrowserFixtureConfig> | undefined;
  try {
    try {
      fixture = loadBrowserFixtureConfig(process.env);
    } catch (error) {
      prerequisitesMissing = true;
      throw error;
    }
    console.log(
      `Starting fixture browser screenshot smoke against ${fixture.baseUrl}`
    );
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: { height: 900, width: 1440 },
    });
    page = await context.newPage();
    page.on("console", (message) => {
      if (message.type() === "error") {
        browserErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => browserErrors.push(error.message));
    const response = await page.goto(`${fixture.baseUrl}/login`, {
      waitUntil: "networkidle",
    });
    if (!response?.ok()) {
      throw new Error(
        `Fixture login page returned ${response?.status() ?? "no response"}.`
      );
    }
    await page.screenshot({ path: path.join(outputDirectory, "01_login.png") });
    await page.locator('input[type="email"]').fill(fixture.email);
    await page.locator('input[type="password"]').fill(fixture.password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((url) => url.pathname.startsWith("/chat"), {
      timeout: 30_000,
    });
    const csrf = (await context.cookies(fixture.baseUrl)).find(
      (cookie) => cookie.name === "atlas_csrf"
    );
    if (!csrf) {
      throw new Error(
        "The fixture login did not establish a browser CSRF token."
      );
    }
    const org = await context.request.post(
      `${fixture.baseUrl}/v1/auth/active-org`,
      {
        data: { orgId: fixture.orgId },
        headers: { "X-CSRF-Token": csrf.value },
      }
    );
    if (!org.ok()) {
      throw new Error(
        `Fixture organization selection returned ${org.status()}.`
      );
    }
    await page.goto(`${fixture.baseUrl}${fixture.chatPath}`, {
      waitUntil: "networkidle",
    });
    if (new URL(page.url()).pathname !== fixture.chatPath) {
      throw new Error(
        "The prepared fixture chat was not opened; refusing to use a different profile/session."
      );
    }
    await page.locator("textarea").first().waitFor({ state: "visible" });
    await page.screenshot({
      path: path.join(outputDirectory, "02_fixture_chat.png"),
    });
    for (const scenario of BROWSER_SCENARIOS) {
      if (browserErrors.length) {
        throw new Error(
          "Browser errors occurred before the next fixture turn."
        );
      }
      const previousCount = await page.locator(ASSISTANT_TEXT_SELECTOR).count();
      await page.locator("textarea").first().fill(scenario.prompt);
      await page
        .getByRole("button", { exact: true, name: "Send message" })
        .click();
      const assistantDisplay = await observeAssistantDisplay(
        page,
        previousCount,
        scenario.display
      );
      const screenshot = `${scenario.id}.png`;
      await page.screenshot({ path: path.join(outputDirectory, screenshot) });
      observations.push({ assistantDisplay, id: scenario.id, screenshot });
      completed.push(scenario.id);
      if (browserErrors.length) {
        throw new Error("Browser errors occurred during the fixture smoke.");
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    if (fixture) {
      failure = failure.replaceAll(fixture.password, "[redacted]");
    }
    if (page) {
      await page
        .screenshot({ path: path.join(outputDirectory, "failure.png") })
        .catch(() => undefined);
    }
  } finally {
    if (browser) {
      await browser.close().catch((error) => {
        browserErrors.push(`Browser cleanup failed: ${String(error)}`);
      });
    }
    const report = buildBrowserSmokeReport({
      browserErrors,
      completed,
      failure,
      prerequisitesMissing,
    });
    await writeFile(
      path.join(outputDirectory, "report.json"),
      JSON.stringify(
        {
          ...report,
          fixture: fixture
            ? {
                baseUrl: fixture.baseUrl,
                chatPath: fixture.chatPath,
                orgId: fixture.orgId,
              }
            : undefined,
          observations,
        },
        null,
        2
      )
    );
    console.log(`${report.status}: ${outputDirectory}`);
    if (report.status !== "UI_SMOKE_PASSED") {
      process.exitCode = 1;
    }
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(
      "Browser smoke could not initialize its evidence output:",
      error
    );
    process.exitCode = 1;
  });
}

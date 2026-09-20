import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "playwright";

export interface BrowserHarnessOptions {
  executablePath?: string;
  headless?: boolean;
  screenshotsDir: string;
}

export interface AuthenticatedPageResult {
  consoleErrors: string[];
  context: BrowserContext;
  page: Page;
  pageErrors: string[];
  screenshot: (filename: string) => Promise<string>;
  sendMessage: (text: string) => Promise<void>;
  writeEvidence: (filename: string, evidence: unknown) => Promise<string>;
}

export class BrowserHarness {
  private browser: Browser | null = null;

  constructor(private readonly options: BrowserHarnessOptions) {}

  async launch(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await chromium.launch({
        executablePath: this.options.executablePath,
        headless: this.options.headless ?? true,
      });
    }
    return this.browser;
  }

  async createAuthenticatedPage(
    baseUrl: string,
    credentials: { email: string; password?: string }
  ): Promise<AuthenticatedPageResult> {
    const browser = await this.launch();
    const context = await browser.newContext({
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await page.setViewportSize({ height: 900, width: 1440 });

    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    page.on("pageerror", (err) => {
      pageErrors.push(err.message);
    });

    // Navigate to Login Page
    await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
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
        await emailInput.fill(credentials.email);
        await passwordInput.fill(credentials.password ?? "Password123!");
        await page.click('button[type="submit"]');
        await page.waitForURL((url) => url.pathname.includes("/chat"), {
          timeout: 20_000,
        });
      }
    }

    await page.waitForTimeout(500);

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

    const screenshot = async (filename: string) => {
      const destPath = join(this.options.screenshotsDir, filename);
      await page.screenshot({ path: destPath });
      return destPath;
    };

    return {
      consoleErrors,
      context,
      page,
      pageErrors,
      screenshot,
      sendMessage,
      writeEvidence: async (filename, evidence) => {
        const destination = join(this.options.screenshotsDir, filename);
        await writeFile(destination, JSON.stringify(evidence, null, 2));
        return destination;
      },
    };
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

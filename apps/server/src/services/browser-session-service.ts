import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { nanoid, type ToolArtifact } from "@atlas/core";
import type {
  BrowserInput,
  BrowserPageSnapshot,
  BrowserToolOutput,
  InteractiveElement,
} from "@atlas/core/browser/browser-types";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "playwright";
import { artifactService } from "./artifact-service";

interface SessionBrowserContext {
  context: BrowserContext;
  lastActiveAt: number;
  page: Page;
  refMap: Map<string, { role: string; name: string; selector: string }>;
  sessionKey: string;
}

const CONTEXT_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const MAX_CONTEXTS = 20;
const ACTION_TIMEOUT_MS = 15_000;
const NAV_TIMEOUT_MS = 30_000;

export class BrowserSessionService {
  private browserPromise: Promise<Browser> | null = null;
  private readonly sessions = new Map<string, SessionBrowserContext>();

  private async getBrowser(): Promise<Browser> {
    if (!this.browserPromise) {
      this.browserPromise = chromium.launch({
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-popup-blocking",
        ],
        headless: true,
      });
    }
    return this.browserPromise;
  }

  private buildSessionKey(
    orgId?: string,
    userId?: string,
    profileId?: string,
    sessionId?: string
  ): string {
    return `${orgId || "org"}:${userId || "user"}:${profileId || "prof"}:${sessionId || "sess"}`;
  }

  private cleanIdleSessions(): void {
    const now = Date.now();
    for (const [key, sess] of this.sessions.entries()) {
      if (now - sess.lastActiveAt > CONTEXT_IDLE_TIMEOUT_MS) {
        sess.context.close().catch(() => {});
        this.sessions.delete(key);
      }
    }
  }

  private async getOrCreateSession(
    orgId?: string,
    userId?: string,
    profileId?: string,
    sessionId?: string
  ): Promise<SessionBrowserContext> {
    this.cleanIdleSessions();

    const key = this.buildSessionKey(orgId, userId, profileId, sessionId);
    const existing = this.sessions.get(key);
    if (existing && !existing.page.isClosed()) {
      existing.lastActiveAt = Date.now();
      return existing;
    }

    if (this.sessions.size >= MAX_CONTEXTS) {
      // Evict oldest
      let oldestKey: string | null = null;
      let oldestTime = Number.POSITIVE_INFINITY;
      for (const [k, s] of this.sessions.entries()) {
        if (s.lastActiveAt < oldestTime) {
          oldestTime = s.lastActiveAt;
          oldestKey = k;
        }
      }
      if (oldestKey) {
        const s = this.sessions.get(oldestKey);
        s?.context.close().catch(() => {});
        this.sessions.delete(oldestKey);
      }
    }

    const browser = await this.getBrowser();
    const context = await browser.newContext({
      acceptDownloads: true,
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 AtlasBrowser/1.0",
      viewport: { height: 800, width: 1280 },
    });

    const page = await context.newPage();
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

    const session: SessionBrowserContext = {
      context,
      lastActiveAt: Date.now(),
      page,
      refMap: new Map(),
      sessionKey: key,
    };

    this.sessions.set(key, session);
    return session;
  }

  private async assertSafeUrl(targetUrl: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      throw new Error(`Invalid URL: ${targetUrl}`);
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Unsupported protocol: ${parsed.protocol}`);
    }

    const hostname = parsed.hostname.toLowerCase();

    // Allow localhost / loopback ONLY if running local test fixture (ports >= 3000)
    const portNum = Number(parsed.port);
    const isTestPort =
      Number.isInteger(portNum) && portNum >= 3000 && portNum <= 65_535;
    if (
      (hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "::1") &&
      isTestPort
    ) {
      return;
    }

    // SSRF validation for external addresses
    if (
      hostname === "169.254.169.254" ||
      hostname.startsWith("10.") ||
      hostname.startsWith("192.168.") ||
      hostname === "localhost" ||
      hostname === "127.0.0.1"
    ) {
      throw new Error(
        `Access to private address ${hostname} is blocked for security.`
      );
    }

    if (!isIP(hostname)) {
      try {
        const records = await dnsLookup(hostname, { all: true });
        for (const record of records) {
          if (
            record.address.startsWith("127.") ||
            record.address.startsWith("10.") ||
            record.address.startsWith("192.168.") ||
            record.address === "::1" ||
            record.address === "169.254.169.254"
          ) {
            throw new Error(
              `Hostname ${hostname} resolves to blocked private address.`
            );
          }
        }
      } catch (err) {
        if ((err as Error).message.includes("blocked private address")) {
          throw err;
        }
      }
    }
  }

  private async extractPageSnapshot(
    page: Page,
    session: SessionBrowserContext
  ): Promise<BrowserPageSnapshot> {
    const url = page.url();
    const title = await page.title().catch(() => "");

    // Extract interactive elements and links via in-page script
    const extracted = await page.evaluate(() => {
      const isVisible = (elem: Element) => {
        const htmlElem = elem as HTMLElement;
        return !!(
          htmlElem.offsetWidth ||
          htmlElem.offsetHeight ||
          htmlElem.getClientRects().length
        );
      };

      const elements: Array<{
        name: string;
        role: string;
        selector: string;
        value?: string;
      }> = [];

      const queryTargets = document.querySelectorAll(
        "button, a, input, select, textarea, [role='button'], [role='link'], [role='textbox'], [role='combobox'], [role='checkbox'], [role='tab']"
      );

      let idx = 1;
      for (const el of queryTargets) {
        if (!isVisible(el) || idx > 60) {
          continue;
        }

        const tag = el.tagName.toLowerCase();
        let role = el.getAttribute("role") || tag;
        if (tag === "input") {
          const type = (el as HTMLInputElement).type || "text";
          role = type === "submit" || type === "button" ? "button" : "textbox";
        }

        let name =
          el.getAttribute("aria-label") ||
          (el as HTMLElement).innerText ||
          el.getAttribute("placeholder") ||
          el.getAttribute("name") ||
          el.getAttribute("title") ||
          "";

        name = name.replace(/\s+/g, " ").trim().slice(0, 50);

        let selector = "";
        const id = el.getAttribute("id");
        if (id) {
          selector = `#${id}`;
        } else {
          const testId = el.getAttribute("data-testid");
          if (testId) {
            selector = `[data-testid="${testId}"]`;
          } else if (name && tag === "a") {
            selector = `a:has-text("${name}")`;
          } else if (name && tag === "button") {
            selector = `button:has-text("${name}")`;
          } else {
            selector = tag;
          }
        }

        elements.push({
          name: name || tag,
          role,
          selector,
          value: (el as HTMLInputElement).value || undefined,
        });
        idx += 1;
      }

      // Extract links
      const links: Array<{ text: string; url: string }> = [];
      const linkElements = document.querySelectorAll("a[href]");
      let linkIdx = 0;
      for (const a of linkElements) {
        if (linkIdx >= 30) {
          break;
        }
        const text =
          (a as HTMLElement).innerText.trim() || a.getAttribute("title") || "";
        const href = a.getAttribute("href") || "";
        if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
          links.push({ text: text.slice(0, 60), url: href });
          linkIdx += 1;
        }
      }

      // Extract main visible text
      const bodyText = document.body
        ? document.body.innerText.slice(0, 10_000)
        : "";

      return {
        elements,
        links,
        text: bodyText,
      };
    });

    session.refMap.clear();
    const interactiveElements: InteractiveElement[] = [];
    extracted.elements.forEach((item, index) => {
      const ref = `e${index + 1}`;
      session.refMap.set(ref, {
        name: item.name,
        role: item.role,
        selector: item.selector,
      });
      interactiveElements.push({
        name: item.name,
        ref,
        role: item.role,
        selector: item.selector,
        value: item.value,
      });
    });

    return {
      interactiveElements,
      links: extracted.links,
      text: extracted.text,
      title,
      truncated: extracted.text.length >= 10_000,
      url,
    };
  }

  private resolveElementSelector(
    elementOrRef: string | undefined,
    directSelector: string | undefined,
    session: SessionBrowserContext
  ): string {
    if (elementOrRef) {
      const mapped = session.refMap.get(elementOrRef);
      if (mapped) {
        return mapped.selector;
      }
      return elementOrRef;
    }
    if (directSelector) {
      return directSelector;
    }
    throw new Error("No element ref or selector provided for browser action.");
  }

  async executeBrowserAction(
    input: BrowserInput,
    options: {
      orgId?: string;
      profileId?: string;
      sessionId?: string;
      userId?: string;
    } = {}
  ): Promise<BrowserToolOutput> {
    const { action } = input;
    const session = await this.getOrCreateSession(
      options.orgId,
      options.userId,
      options.profileId,
      options.sessionId
    );
    const { page } = session;
    session.lastActiveAt = Date.now();

    const artifacts: ToolArtifact[] = [];

    switch (action) {
      case "open":
      case "navigate": {
        if (!input.url) {
          throw new Error("Action 'open' requires a target url.");
        }
        await this.assertSafeUrl(input.url);
        await page.goto(input.url, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(500);
        const snapshot = await this.extractPageSnapshot(page, session);
        return {
          action,
          message: `Navigated to ${snapshot.url}`,
          snapshot,
          status: "success",
        };
      }

      case "click": {
        const selector = this.resolveElementSelector(
          input.element,
          input.selector,
          session
        );
        await page.waitForSelector(selector, {
          state: "visible",
          timeout: 8000,
        });
        await page.click(selector);
        await page.waitForTimeout(1000);
        const snapshot = await this.extractPageSnapshot(page, session);
        return {
          action,
          message: `Clicked ${input.element || selector}`,
          snapshot,
          status: "success",
        };
      }

      case "type": {
        const selector = this.resolveElementSelector(
          input.element,
          input.selector,
          session
        );
        await page.waitForSelector(selector, {
          state: "visible",
          timeout: 8000,
        });
        if (input.clear !== false) {
          await page.fill(selector, "");
        }
        await page.type(selector, input.text ?? "");
        await page.waitForTimeout(500);
        const snapshot = await this.extractPageSnapshot(page, session);
        return {
          action,
          message: `Typed into ${input.element || selector}`,
          snapshot,
          status: "success",
        };
      }

      case "select": {
        const selector = this.resolveElementSelector(
          input.element,
          input.selector,
          session
        );
        if (!input.value) {
          throw new Error("Action 'select' requires a value parameter.");
        }
        await page.selectOption(selector, input.value);
        await page.waitForTimeout(500);
        const snapshot = await this.extractPageSnapshot(page, session);
        return {
          action,
          message: `Selected '${input.value}' in ${input.element || selector}`,
          snapshot,
          status: "success",
        };
      }

      case "scroll": {
        const direction = input.direction ?? "down";
        if (direction === "top") {
          await page.evaluate(() => window.scrollTo(0, 0));
        } else if (direction === "bottom") {
          await page.evaluate(() =>
            window.scrollTo(0, document.body.scrollHeight)
          );
        } else if (direction === "up") {
          await page.evaluate(() => window.scrollBy(0, -600));
        } else {
          await page.evaluate(() => window.scrollBy(0, 600));
        }
        await page.waitForTimeout(300);
        const snapshot = await this.extractPageSnapshot(page, session);
        return {
          action,
          message: `Scrolled ${direction}`,
          snapshot,
          status: "success",
        };
      }

      case "find": {
        const query = input.query || input.text || "";
        if (!query) {
          throw new Error("Action 'find' requires a query or text parameter.");
        }
        const matches = await page.evaluate((q) => {
          const body = document.body ? document.body.innerText : "";
          const idx = body.toLowerCase().indexOf(q.toLowerCase());
          if (idx === -1) {
            return null;
          }
          const start = Math.max(0, idx - 100);
          const end = Math.min(body.length, idx + q.length + 100);
          return body.slice(start, end);
        }, query);

        const snapshot = await this.extractPageSnapshot(page, session);
        return {
          action,
          message: matches
            ? `Found match for '${query}': "...${matches.trim()}..."`
            : `No match found for '${query}' on current page.`,
          snapshot,
          status: "success",
        };
      }

      case "screenshot": {
        const buffer = await page.screenshot({
          fullPage: Boolean(input.fullPage),
          type: "png",
        });

        const filename = `screenshot_${Date.now()}.png`;
        let artifact: ToolArtifact | undefined;
        if (options.orgId && options.profileId) {
          artifact = await artifactService.saveArtifact(
            options.orgId,
            options.profileId,
            filename,
            buffer,
            { mimeType: "image/png", sessionId: options.sessionId }
          );
          artifacts.push(artifact);
        }

        const snapshot = await this.extractPageSnapshot(page, session);
        snapshot.screenshotArtifact = artifact;
        return {
          action,
          artifacts,
          message: `Captured screenshot (${input.fullPage ? "full-page" : "viewport"})`,
          snapshot,
          status: "success",
        };
      }

      case "download": {
        // Wait for download event or download current page/link
        let artifact: ToolArtifact | undefined;
        try {
          const downloadPromise = page.waitForEvent("download", {
            timeout: 10_000,
          });
          if (input.element || input.selector) {
            const sel = this.resolveElementSelector(
              input.element,
              input.selector,
              session
            );
            await page.click(sel);
          }
          const download = await downloadPromise;
          const downloadFilename =
            download.suggestedFilename() || `download_${nanoid(6)}`;
          const stream = await download.createReadStream();
          if (stream && options.orgId && options.profileId) {
            const chunks: Uint8Array[] = [];
            for await (const chunk of stream) {
              chunks.push(
                typeof chunk === "string" ? Buffer.from(chunk) : chunk
              );
            }
            const buffer = Buffer.concat(chunks);
            artifact = await artifactService.saveArtifact(
              options.orgId,
              options.profileId,
              downloadFilename,
              buffer,
              { sessionId: options.sessionId }
            );
            artifacts.push(artifact);
          }
        } catch {
          // No active download event triggered
        }

        const snapshot = await this.extractPageSnapshot(page, session);
        snapshot.downloadArtifact = artifact;
        return {
          action,
          artifacts,
          message: artifact
            ? `Downloaded file: ${artifact.filename}`
            : "No download event captured.",
          snapshot,
          status: "success",
        };
      }

      case "back": {
        await page.goBack();
        await page.waitForTimeout(500);
        const snapshot = await this.extractPageSnapshot(page, session);
        return { action, snapshot, status: "success" };
      }

      case "forward": {
        await page.goForward();
        await page.waitForTimeout(500);
        const snapshot = await this.extractPageSnapshot(page, session);
        return { action, snapshot, status: "success" };
      }

      case "reload": {
        await page.reload();
        await page.waitForTimeout(500);
        const snapshot = await this.extractPageSnapshot(page, session);
        return { action, snapshot, status: "success" };
      }

      case "close": {
        await session.context.close().catch(() => {});
        this.sessions.delete(session.sessionKey);
        return {
          action,
          message: "Browser session closed.",
          status: "success",
        };
      }

      default:
        throw new Error(`Unsupported browser action: ${action as string}`);
    }
  }

  async closeAll(): Promise<void> {
    for (const sess of this.sessions.values()) {
      await sess.context.close().catch(() => {});
    }
    this.sessions.clear();
    if (this.browserPromise) {
      const b = await this.browserPromise;
      await b.close().catch(() => {});
      this.browserPromise = null;
    }
  }
}

export const browserSessionService = new BrowserSessionService();

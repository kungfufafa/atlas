/**
 * Full live Playwright stress: readiness, dashboard, parallel provider
 * chats, calculator + filesystem tools.
 *
 * bun run scripts/stress-all-playwright.ts
 */
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type APIRequestContext,
  type Browser,
  chromium,
  type Page,
  request as playwrightRequest,
} from "playwright";
import { AuthService } from "../apps/server/src/services/auth-service";
import { getUserConfigDir, loadConfig } from "../packages/core/src/config";
import { isServerHealthy } from "../packages/core/src/ensure-server";
import { LOCAL_CLIENT_EMAIL } from "../packages/core/src/local-auth";
import { createDatabase } from "../packages/db/src/index";

const API_URL = (
  process.env.ATLAS_SERVER_URL ?? "http://127.0.0.1:4310"
).replace(/\/$/, "");
const PREFERRED_WEB_URL = (
  process.env.ATLAS_TEST_BASE_URL ?? "http://127.0.0.1:3000"
).replace(/\/$/, "");
const TURN_TIMEOUT_MS = 180_000;
const HEALTH_CONCURRENCY = 24;
const SESSION_API_CONCURRENCY = 30;

const LOGIN_CANDIDATES = [
  {
    email: process.env.ATLAS_STRESS_EMAIL ?? "developer@rizqis.com",
    password: process.env.ATLAS_STRESS_PASSWORD ?? "password123",
  },
  { email: "developer@rizqi.com", password: "password123" },
  { email: "admin@oceanmall.test", password: "password123" },
];

const REQUIRED_TOOLS = [
  "write_file",
  "delete_file",
  "edit_file",
  "read_file",
  "search_files",
  "web_search",
] as const;

const DASHBOARD_ROUTES = [
  "/chat",
  "/profiles",
  "/system",
  "/system?tab=status",
  "/integrations",
  "/settings",
];

interface SessionAuth {
  api: APIRequestContext;
  cleanup: () => Promise<void>;
  email: string;
  orgId: string | null;
  storageState: Awaited<ReturnType<APIRequestContext["storageState"]>>;
}

interface Sample {
  durationMs: number;
  error?: string;
  ok: boolean;
}

interface TurnResult {
  durationMs: number;
  marker: string;
  replyExcerpt: string;
  streamStatuses: number[];
}

interface ChatResult {
  sessionId: string | null;
  title: string;
  turns: TurnResult[];
}

const PARALLEL_CHATS: Array<{
  profile?: string;
  prompts: string[];
  title: string;
}> = [
  {
    prompts: [
      "Namaku Arka. Ingat. Balas singkat, sebut namaku, akhiri PARA1-OK.",
      "Total mulai 5, tambah 9. Berapa? Akhiri PARA2-OK.",
      "Sebut namaku dan total itu. Akhiri PARA3-OK.",
      "Tambah 6 ke total. Namaku dan total baru? Akhiri PARA4-OK.",
    ],
    title: "parallel-a",
  },
  {
    prompts: [
      "Namaku Bima. Ingat. Balas singkat, sebut namaku, akhiri PARB1-OK.",
      "Warna favoritku biru. Ulangi namaku dan warna. Akhiri PARB2-OK.",
      "Kalau biru dicampur kuning, warna apa kira-kira? Sebut namaku. Akhiri PARB3-OK.",
      "Ringkas namaku dan warna favoritku. Akhiri PARB4-OK.",
    ],
    title: "parallel-b",
  },
  {
    prompts: [
      "Namaku Citra. Ingat. Balas singkat, sebut namaku, akhiri PARC1-OK.",
      "Aku di Medan. Ulangi namaku dan kota. Akhiri PARC2-OK.",
      "Sebut satu makanan khas kotaku dan namaku. Akhiri PARC3-OK.",
      "Ulangi namaku, kota, dan makanan itu. Akhiri PARC4-OK.",
    ],
    title: "parallel-c",
  },
];

async function main(): Promise<void> {
  const artifactDir = join(tmpdir(), "atlas-stress-all-playwright");
  await mkdir(artifactDir, { recursive: true });
  await waitForUrl(`${API_URL}/health`, 60_000);
  const webUrl = await resolveWebUrl();
  console.log(`API ${API_URL}`);
  console.log(`Web ${webUrl}`);
  console.log(`Artifacts ${artifactDir}`);

  const failures: string[] = [];

  console.log("\n== 1. Readiness probe storm ==");
  const health = await Promise.all(
    Array.from({ length: HEALTH_CONCURRENCY }, () =>
      timed(() => isServerHealthy(API_URL))
    )
  );
  report("isServerHealthy", health);
  if (health.some((sample) => !sample.ok)) {
    failures.push("isServerHealthy failed under concurrency");
  }

  const session =
    (await loginViaWeb(webUrl)) ?? (await mintDashboardSession(webUrl));
  if (!session) {
    throw new Error("Could not create a dashboard session");
  }
  console.log(`Auth ${session.email} org=${session.orgId ?? "none"}`);

  const browser = await chromium.launch({ headless: true });
  try {
    console.log("\n== 2. Session API storm ==");
    const apiSamples = await stormSessionApi(session, webUrl);
    report("session API", apiSamples);
    if (apiSamples.some((sample) => !sample.ok)) {
      failures.push("authenticated API storm failed");
    }

    console.log("\n== 3. Dashboard routes ==");
    const dash = await stormDashboard(browser, session, webUrl, artifactDir);
    report("dashboard", dash);
    if (dash.some((sample) => !sample.ok)) {
      failures.push("dashboard routes failed");
    }

    console.log("\n== 4. Parallel live chats (3 threads x 4 turns) ==");
    const chats = await runParallelChats(browser, session, webUrl, artifactDir);
    for (const chat of chats) {
      reportChat(chat);
      failures.push(...validateChat(chat, 4));
    }

    console.log("\n== 5. Calculator tool chat ==");
    try {
      const calc = await runToolChat(
        browser,
        session,
        webUrl,
        artifactDir,
        "tool-calc",
        "Super Agent",
        "Pakai tool calculator untuk (12500 * 17.5) / 7. Tulis hasil persis di jawaban dan akhiri CALC-OK.",
        ["31250", "Calculated"]
      );
      reportChat(calc);
      failures.push(...validateChat(calc, 1));
    } catch (error) {
      failures.push(
        `calculator chat: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    console.log("\n== 6. Filesystem tool chat ==");
    try {
      const fileChat = await runToolChat(
        browser,
        session,
        webUrl,
        artifactDir,
        "tool-file",
        "Super Agent",
        "Buat file stress-all.txt berisi teks atlas-stress. Setelah berhasil, akhiri FILE-OK.",
        ["stress-all.txt", "write_file", "Wrote"]
      );
      reportChat(fileChat);
      failures.push(...validateChat(fileChat, 1));
    } catch (error) {
      failures.push(
        `filesystem chat: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  } finally {
    await browser.close();
    await session.cleanup();
  }

  if (failures.length > 0) {
    console.error(`\nFAILED:\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }
  console.log("\nFull Playwright stress passed.");
}

async function stormSessionApi(
  session: SessionAuth,
  webUrl: string
): Promise<Sample[]> {
  const headers: Record<string, string> = {};
  if (session.orgId) {
    headers["X-Org-Id"] = session.orgId;
  }
  const paths = [
    "/health",
    "/v1/tools",
    "/v1/auth/orgs",
    "/v1/auth/me",
    "/v1/profiles",
  ];
  return Promise.all(
    Array.from({ length: SESSION_API_CONCURRENCY }, (_, index) => {
      const path = paths[index % paths.length];
      return timed(async () => {
        const response = await session.api.get(new URL(path, webUrl).href, {
          headers,
        });
        if (!response.ok()) {
          throw new Error(`${path} ${response.status()}`);
        }
        if (path === "/v1/tools") {
          const payload = (await response.json()) as {
            tools?: Array<{ name?: string }>;
          };
          const names = new Set((payload.tools ?? []).map((tool) => tool.name));
          for (const name of REQUIRED_TOOLS) {
            if (!names.has(name)) {
              throw new Error(`missing builtin ${name}`);
            }
          }
        }
        return true;
      });
    })
  );
}

async function stormDashboard(
  browser: Browser,
  session: SessionAuth,
  webUrl: string,
  artifactDir: string
): Promise<Sample[]> {
  return Promise.all(
    DASHBOARD_ROUTES.map((route, index) =>
      timed(async () => {
        const context = await browser.newContext({
          storageState: session.storageState,
          viewport: { height: 900, width: 1440 },
        });
        try {
          const page = await context.newPage();
          await page.goto(`${webUrl}${route}`, {
            timeout: 20_000,
            waitUntil: "domcontentloaded",
          });
          await page.waitForFunction(
            () =>
              Boolean(
                document.querySelector("textarea") ||
                  document.body.innerText.includes("Tools") ||
                  document.body.innerText.includes("Profiles") ||
                  document.body.innerText.includes("Integrations") ||
                  document.body.innerText.includes("Settings") ||
                  document.body.innerText.includes("Status")
              ),
            undefined,
            { timeout: 20_000 }
          );
          if (page.url().includes("/login")) {
            throw new Error(`redirected to login from ${route}`);
          }
          await page.screenshot({
            path: join(
              artifactDir,
              `dash-${index}-${route.replaceAll(/[/?=]/g, "_")}.png`
            ),
          });
          return true;
        } finally {
          await context.close();
        }
      })
    )
  );
}

async function runParallelChats(
  browser: Browser,
  session: SessionAuth,
  webUrl: string,
  artifactDir: string
): Promise<ChatResult[]> {
  return Promise.all(
    PARALLEL_CHATS.map(async (chat) => {
      const context = await browser.newContext({
        storageState: session.storageState,
        viewport: { height: 900, width: 1440 },
      });
      try {
        const page = await context.newPage();
        attachNetworkLogging(page, chat.title);
        return await runConversation(
          page,
          webUrl,
          chat.title,
          chat.prompts,
          artifactDir,
          "Default Agent"
        );
      } finally {
        await context.close();
      }
    })
  );
}

async function runToolChat(
  browser: Browser,
  session: SessionAuth,
  webUrl: string,
  artifactDir: string,
  title: string,
  profile: string,
  prompt: string,
  extraNeedles: string[]
): Promise<ChatResult> {
  const context = await browser.newContext({
    storageState: session.storageState,
    viewport: { height: 900, width: 1440 },
  });
  try {
    const page = await context.newPage();
    attachNetworkLogging(page, title);
    const chat = await runConversation(
      page,
      webUrl,
      title,
      [prompt],
      artifactDir,
      profile
    );
    const body = await page.evaluate(() => document.body.innerText);
    const missing = extraNeedles.filter(
      (needle) =>
        !(body.includes(needle) || chat.turns[0]?.replyExcerpt.includes(needle))
    );
    if (missing.length === extraNeedles.length) {
      throw new Error(`none of ${extraNeedles.join("/")} appeared`);
    }
    return chat;
  } finally {
    await context.close();
  }
}

async function runConversation(
  page: Page,
  webUrl: string,
  title: string,
  prompts: string[],
  artifactDir: string,
  profileName?: string
): Promise<ChatResult> {
  const streamStatuses: number[] = [];
  page.on("response", (response) => {
    if (
      response.url().includes("/v1/sessions/") &&
      response.url().includes("/messages")
    ) {
      streamStatuses.push(response.status());
    }
  });

  await page.goto(`${webUrl}/chat`, {
    timeout: 30_000,
    waitUntil: "domcontentloaded",
  });
  await page.locator("textarea").first().waitFor({ timeout: 20_000 });
  await selectProfile(page, profileName);
  await maybeLowerThinking(page);

  const turns: TurnResult[] = [];
  for (const [index, prompt] of prompts.entries()) {
    const marker = markerFrom(prompt);
    console.log(`  ${title} turn ${index + 1}/${prompts.length} (${marker})`);
    const started = performance.now();
    const statusesBefore = streamStatuses.length;
    await sendMessage(page, prompt);
    const replyExcerpt = await waitForAssistantMarker(page, marker);
    await waitForComposerIdle(page);
    const durationMs = performance.now() - started;
    const turnStatuses = streamStatuses.slice(statusesBefore);
    turns.push({
      durationMs,
      marker,
      replyExcerpt,
      streamStatuses: turnStatuses,
    });
    console.log(
      `    ${durationMs.toFixed(0)}ms streams=${turnStatuses.join(",") || "n/a"} excerpt=${JSON.stringify(replyExcerpt.slice(0, 120))}`
    );
    await page.screenshot({
      path: join(artifactDir, `${title}-turn-${index + 1}.png`),
      timeout: 15_000,
    });
  }

  return { sessionId: sessionIdFromUrl(page.url()), title, turns };
}

async function selectProfile(page: Page, preferred?: string): Promise<void> {
  const switcher = page
    .getByRole("button", { name: /Switch profile/i })
    .first();
  await switcher.waitFor({ timeout: 15_000 });
  const label = (await switcher.getAttribute("aria-label")) ?? "";
  if (preferred && new RegExp(preferred, "i").test(label)) {
    return;
  }
  if (!preferred && /Switch profile \(/i.test(label)) {
    return;
  }

  await switcher.click();
  const items = page.getByRole("menuitem");
  await items.first().waitFor({ timeout: 5000 });
  const count = await items.count();
  for (let index = 0; index < count; index += 1) {
    const item = items.nth(index);
    const text = await item.innerText();
    const disabled =
      (await item.getAttribute("aria-disabled")) === "true" ||
      (await item.getAttribute("data-disabled")) !== null;
    if (disabled) {
      continue;
    }
    if (preferred && !new RegExp(preferred, "i").test(text)) {
      continue;
    }
    await item.click();
    return;
  }
  await page.keyboard.press("Escape");
}

async function maybeLowerThinking(page: Page): Promise<void> {
  const trigger = page.getByLabel("Thinking effort");
  if ((await trigger.count()) === 0) {
    return;
  }
  try {
    await trigger.click({ timeout: 3000 });
    const low = page.getByRole("option", { name: /^(Low|None|Off)$/i }).first();
    if (await low.isVisible().catch(() => false)) {
      await low.click();
      return;
    }
    await page.keyboard.press("Escape");
  } catch {
    // keep current effort
  }
}

async function sendMessage(page: Page, text: string): Promise<void> {
  const textarea = page.locator("textarea").first();
  await textarea.waitFor({ state: "visible", timeout: 10_000 });
  await textarea.click();
  await textarea.fill(text);
  const send = page.getByRole("button", {
    name: /Send message|Queue message/i,
  });
  await send.waitFor({ state: "visible", timeout: 10_000 });
  await send.click();
}

async function waitForAssistantMarker(
  page: Page,
  marker: string
): Promise<string> {
  const handle = await page.waitForFunction(
    (code) => {
      const match = [...document.querySelectorAll(".is-assistant")]
        .map((node) => (node.textContent ?? node.innerHTML ?? "").trim())
        .find((text) => text.includes(code));
      return match ?? null;
    },
    marker,
    { timeout: TURN_TIMEOUT_MS }
  );
  const text = await handle.jsonValue();
  if (typeof text !== "string" || !text.includes(marker)) {
    throw new Error(`assistant never produced ${marker}`);
  }
  return text;
}

async function waitForComposerIdle(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.querySelector('[aria-label="Stop response"]') == null,
    undefined,
    { timeout: TURN_TIMEOUT_MS }
  );
}

function markerFrom(prompt: string): string {
  const match = prompt.match(/\b([A-Z]+[0-9]*-OK)\b/);
  if (!match) {
    throw new Error(`prompt is missing a turn marker: ${prompt}`);
  }
  return match[1] ?? prompt;
}

function sessionIdFromUrl(url: string): string | null {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  if (parts[0] === "chat" && parts.length >= 3) {
    return parts[2] ?? null;
  }
  return null;
}

function reportChat(chat: ChatResult): void {
  const total = chat.turns.reduce((sum, turn) => sum + turn.durationMs, 0);
  console.log(
    `${chat.title}: ${chat.turns.length} turns session=${chat.sessionId ?? "unknown"} total=${total.toFixed(0)}ms`
  );
}

function validateChat(chat: ChatResult, expectedTurns: number): string[] {
  const failures: string[] = [];
  if (chat.turns.length !== expectedTurns) {
    failures.push(
      `${chat.title} completed ${chat.turns.length}/${expectedTurns} turns`
    );
  }
  for (const turn of chat.turns) {
    if (!turn.replyExcerpt.includes(turn.marker)) {
      failures.push(`${chat.title} missing ${turn.marker} in assistant reply`);
    }
    if (
      turn.streamStatuses.length > 0 &&
      turn.streamStatuses.every((status) => status >= 400)
    ) {
      failures.push(
        `${chat.title} ${turn.marker} stream HTTP ${turn.streamStatuses.join(",")}`
      );
    }
  }
  return failures;
}

function attachNetworkLogging(page: Page, label: string): void {
  page.on("pageerror", (error) => {
    console.log(`[${label} pageerror] ${error.message}`);
  });
  page.on("response", (response) => {
    if (response.url().includes("/v1/sessions/") && response.status() >= 400) {
      console.log(`[${label} http] ${response.status()} ${response.url()}`);
    }
  });
}

function report(label: string, samples: Sample[]): void {
  const ok = samples.filter((sample) => sample.ok);
  const failed = samples.filter((sample) => !sample.ok);
  const durations = ok.map((sample) => sample.durationMs).sort((a, b) => a - b);
  console.log(
    `${label}: ${ok.length}/${samples.length} ok  p50=${pct(durations, 50)}ms  p95=${pct(durations, 95)}ms  max=${pct(durations, 100)}ms`
  );
  for (const sample of failed.slice(0, 8)) {
    console.log(`  fail ${sample.durationMs.toFixed(0)}ms ${sample.error}`);
  }
}

function pct(sorted: number[], percentile: number): string {
  if (sorted.length === 0) {
    return "-";
  }
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((percentile / 100) * sorted.length) - 1
  );
  return sorted[Math.max(0, index)]?.toFixed(0) ?? "-";
}

async function timed(fn: () => Promise<boolean>): Promise<Sample> {
  const started = performance.now();
  try {
    const ok = await fn();
    return { durationMs: performance.now() - started, ok };
  } catch (error) {
    return {
      durationMs: performance.now() - started,
      error: error instanceof Error ? error.message : String(error),
      ok: false,
    };
  }
}

async function loginViaWeb(webUrl: string): Promise<SessionAuth | null> {
  const unique = new Map<string, { email: string; password: string }>();
  for (const candidate of LOGIN_CANDIDATES) {
    unique.set(candidate.email, candidate);
  }
  for (const candidate of unique.values()) {
    const api = await playwrightRequest.newContext({ baseURL: webUrl });
    const response = await api.post("/v1/auth/login", {
      data: { email: candidate.email, password: candidate.password },
    });
    if (!response.ok()) {
      await api.dispose();
      continue;
    }
    const payload = (await response.json()) as {
      activeOrgId?: string | null;
      orgId?: string | null;
    };
    return {
      api,
      cleanup: async () => {
        await api.dispose();
      },
      email: candidate.email,
      orgId: payload.activeOrgId ?? payload.orgId ?? null,
      storageState: await api.storageState(),
    };
  }
  return null;
}

async function mintDashboardSession(
  webUrl: string
): Promise<SessionAuth | null> {
  const database = await createDatabase(loadConfig().databaseUrl, {
    baseDir: getUserConfigDir(),
  });
  const authService = new AuthService();
  try {
    const user =
      (
        await Promise.all(
          LOGIN_CANDIDATES.map((candidate) =>
            database.adapter.getUserByEmail(candidate.email)
          )
        )
      ).find((entry) => entry && entry.email !== LOCAL_CLIENT_EMAIL) ??
      (await database.adapter.getUserById("user_admin"));
    if (!user || user.email === LOCAL_CLIENT_EMAIL) {
      database.close();
      return null;
    }
    const memberships = await database.adapter.listUserOrganizations(user.id);
    const orgId = memberships[0]?.organization.id ?? null;
    const tokens = authService.createBrowserSessionTokens();
    const now = new Date().toISOString();
    await database.adapter.createBrowserSession({
      activeOrgId: orgId,
      createdAt: now,
      csrfTokenHash: authService.hashToken(tokens.csrfToken),
      expiresAt: tokens.expiresAt,
      id: crypto.randomUUID(),
      lastUsedAt: now,
      revokedAt: null,
      sessionTokenHash: authService.hashToken(tokens.sessionToken),
      userId: user.id,
    });
    const origin = new URL(webUrl);
    const cookie = {
      domain: origin.hostname,
      expires: Math.floor(new Date(tokens.expiresAt).getTime() / 1000),
      path: "/",
      sameSite: "Lax" as const,
      secure: origin.protocol === "https:",
    };
    const storageState = {
      cookies: [
        {
          ...cookie,
          httpOnly: true,
          name: "atlas_session",
          value: tokens.sessionToken,
        },
        {
          ...cookie,
          httpOnly: false,
          name: "atlas_csrf",
          value: tokens.csrfToken,
        },
      ],
      origins: [],
    };
    const api = await playwrightRequest.newContext({
      baseURL: webUrl,
      extraHTTPHeaders: {
        Cookie: `atlas_session=${tokens.sessionToken}; atlas_csrf=${tokens.csrfToken}`,
        ...(orgId ? { "X-Org-Id": orgId } : {}),
      },
      storageState,
    });
    return {
      api,
      cleanup: async () => {
        await api.dispose();
        await database.adapter.revokeBrowserSessionBySessionTokenHash(
          authService.hashToken(tokens.sessionToken),
          new Date().toISOString()
        );
        database.close();
      },
      email: user.email,
      orgId,
      storageState,
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "timeout";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = `${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(250);
  }
  throw new Error(`${url} not ready: ${lastError}`);
}

async function resolveWebUrl(): Promise<string> {
  try {
    await waitForUrl(PREFERRED_WEB_URL, 25_000);
    return PREFERRED_WEB_URL;
  } catch {
    console.warn(`Web ${PREFERRED_WEB_URL} not up, using ${API_URL}`);
    await waitForUrl(API_URL, 10_000);
    return API_URL;
  }
}

await main();

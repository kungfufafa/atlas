/**
 * Live Playwright chat against the real configured provider.
 * Long multi-turn threads, repeated, with follow-ups that need prior context.
 *
 * bun run scripts/stress-live-chat-playwright.ts
 */
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type APIRequestContext,
  chromium,
  type Page,
  request as playwrightRequest,
} from "playwright";
import { AuthService } from "../apps/server/src/services/auth-service";
import { getUserConfigDir, loadConfig } from "../packages/core/src/config";
import { LOCAL_CLIENT_EMAIL } from "../packages/core/src/local-auth";
import { createDatabase } from "../packages/db/src/index";

const API_URL = (
  process.env.ATLAS_SERVER_URL ?? "http://127.0.0.1:4310"
).replace(/\/$/, "");
const PREFERRED_WEB_URL = (
  process.env.ATLAS_TEST_BASE_URL ?? "http://127.0.0.1:3000"
).replace(/\/$/, "");
const TURN_TIMEOUT_MS = 180_000;

const LOGIN_CANDIDATES = [
  {
    email: process.env.ATLAS_STRESS_EMAIL ?? "developer@rizqis.com",
    password: process.env.ATLAS_STRESS_PASSWORD ?? "password123",
  },
  { email: "developer@rizqi.com", password: "password123" },
  { email: "admin@oceanmall.test", password: "password123" },
];

interface SessionAuth {
  api: APIRequestContext;
  cleanup: () => Promise<void>;
  email: string;
  orgId: string | null;
  storageState: Awaited<ReturnType<APIRequestContext["storageState"]>>;
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

const LONG_CHAT_TURNS = [
  "Namaku Raka. Ingat nama ini. Balas singkat, sebut namaku, dan akhiri dengan kode TURN1-OK.",
  "Mulai total dari 10, lalu tambah 3. Berapa totalnya sekarang? Akhiri dengan TURN2-OK.",
  "Tambah 7 ke total itu. Total baru berapa? Akhiri dengan TURN3-OK.",
  "Sebut namaku dan total terakhir. Akhiri dengan TURN4-OK.",
  "Dalam dua kalimat, jelaskan kenapa dashboard butuh workspace context saat list tools. Akhiri dengan TURN5-OK.",
  "Ringkas percakapan ini jadi 3 bullet. Akhiri dengan TURN6-OK.",
  "Kalau total terakhir ditambah 20, hasilnya berapa? Akhiri dengan TURN7-OK.",
  "Ulangi: namaku, total sebelum +20, dan total setelah +20. Akhiri dengan TURN8-OK.",
];

const SECOND_CHAT_TURNS = [
  "Namaku Sinta. Ingat nama ini. Balas singkat dan akhiri dengan BRAVO1-OK.",
  "Kota favoritku Bandung. Ulangi namaku dan kotaku. Akhiri dengan BRAVO2-OK.",
  "Kalau Bandung ke Jakarta kira-kira 150 km, sebut jarak itu dan namaku. Akhiri dengan BRAVO3-OK.",
  "Buat satu pertanyaan lanjutan tentang kotaku. Akhiri dengan BRAVO4-OK.",
  "Jawab pertanyaan yang baru kamu buat, tetap sebut namaku. Akhiri dengan BRAVO5-OK.",
];

async function main(): Promise<void> {
  const artifactDir = join(tmpdir(), "atlas-live-chat-playwright");
  await mkdir(artifactDir, { recursive: true });

  await waitForUrl(`${API_URL}/health`, 60_000);
  const webUrl = await resolveWebUrl();
  console.log(`API ${API_URL}`);
  console.log(`Web ${webUrl}`);
  console.log(`Artifacts ${artifactDir}`);

  const session =
    (await loginViaWeb(webUrl)) ?? (await mintDashboardSession(webUrl));
  if (!session) {
    throw new Error("Could not create a dashboard session");
  }

  console.log(`Session ${session.email} org=${session.orgId ?? "none"}`);
  const browser = await chromium.launch({ headless: true });
  const failures: string[] = [];

  try {
    const context = await browser.newContext({
      storageState: session.storageState,
      viewport: { height: 900, width: 1440 },
    });

    const longPage = await context.newPage();
    const secondPage = await context.newPage();
    attachNetworkLogging(longPage, "long");
    attachNetworkLogging(secondPage, "second");

    console.log("\n== Long chat (8 follow-ups, one thread) ==");
    const longChat = await runConversation(
      longPage,
      webUrl,
      "long-thread",
      LONG_CHAT_TURNS,
      artifactDir
    );
    reportChat(longChat);
    failures.push(...validateChat(longChat, LONG_CHAT_TURNS.length));

    console.log("\n== Second chat (5 follow-ups, another thread) ==");
    const secondChat = await runConversation(
      secondPage,
      webUrl,
      "second-thread",
      SECOND_CHAT_TURNS,
      artifactDir
    );
    reportChat(secondChat);
    failures.push(...validateChat(secondChat, SECOND_CHAT_TURNS.length));

    await context.close();
  } finally {
    await browser.close();
    await session.cleanup();
  }

  if (failures.length > 0) {
    console.error(`\nFAILED:\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }

  console.log("\nLive provider chat stress passed.");
}

async function runConversation(
  page: Page,
  webUrl: string,
  title: string,
  prompts: string[],
  artifactDir: string
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
  await selectProfile(page);
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
      `    ${durationMs.toFixed(0)}ms streams=${turnStatuses.join(",") || "n/a"} excerpt=${JSON.stringify(replyExcerpt.slice(0, 140))}`
    );
    await page.screenshot({
      path: join(artifactDir, `${title}-turn-${index + 1}.png`),
      timeout: 15_000,
    });
  }

  return {
    sessionId: sessionIdFromUrl(page.url()),
    title,
    turns,
  };
}

async function selectProfile(page: Page): Promise<void> {
  const switcher = page
    .getByRole("button", { name: /Switch profile/i })
    .first();
  await switcher.waitFor({ timeout: 15_000 });
  const label = (await switcher.getAttribute("aria-label")) ?? "";
  if (/Switch profile \(/i.test(label)) {
    return;
  }

  await switcher.click();
  const preferred = page
    .getByRole("menuitem")
    .filter({ hasText: /Default Agent|Super Agent/i })
    .first();
  if (await preferred.isVisible().catch(() => false)) {
    await preferred.click();
    return;
  }

  const first = page.getByRole("menuitem").first();
  await first.waitFor({ timeout: 5000 });
  await first.click();
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
      console.log("  thinking effort set to low/off");
      return;
    }
    await page.keyboard.press("Escape");
  } catch {
    // Keep whatever the workspace already uses.
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
    () => {
      const stop = document.querySelector('[aria-label="Stop response"]');
      return stop == null;
    },
    undefined,
    { timeout: TURN_TIMEOUT_MS }
  );
}

function markerFrom(prompt: string): string {
  const match = prompt.match(/\b([A-Z]+[0-9]+-OK)\b/);
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
  const durations = chat.turns.map((turn) => turn.durationMs);
  const total = durations.reduce((sum, value) => sum + value, 0);
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
    await waitForUrl(PREFERRED_WEB_URL, 20_000);
    return PREFERRED_WEB_URL;
  } catch {
    console.warn(`Web ${PREFERRED_WEB_URL} not up, using ${API_URL}`);
    await waitForUrl(API_URL, 10_000);
    return API_URL;
  }
}

await main();

/**
 * Stress-test the authenticated readiness probe and the dashboard
 * surfaces that depend on it (health, tools catalog, org context).
 *
 * bun run scripts/stress-readiness-playwright.ts
 */
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
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

const HEALTH_CONCURRENCY = 32;
const HEALTH_ROUNDS = 4;
const SESSION_CONCURRENCY = 40;
const BROWSER_CONTEXTS = 6;
const SHARED_TABS = 4;
const RELOADS = 12;

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

interface Sample {
  durationMs: number;
  error?: string;
  ok: boolean;
}

interface SessionAuth {
  api: APIRequestContext;
  cleanup: () => Promise<void>;
  email: string;
  orgId: string | null;
  storageState: Awaited<ReturnType<APIRequestContext["storageState"]>>;
}

async function main(): Promise<void> {
  const artifactDir = join(tmpdir(), "atlas-stress-playwright");
  await mkdir(artifactDir, { recursive: true });

  await waitForUrl(`${API_URL}/health`, 60_000);
  const webUrl = await resolveWebUrl();

  console.log(`API ${API_URL}`);
  console.log(`Web ${webUrl}`);
  console.log(`Artifacts ${artifactDir}`);

  const failures: string[] = [];

  console.log(
    "\n== 1. Concurrent isServerHealthy (local-token tools probe) =="
  );
  const healthSamples = await runRounds(
    HEALTH_ROUNDS,
    HEALTH_CONCURRENCY,
    async () => timed(() => isServerHealthy(API_URL))
  );
  report("isServerHealthy", healthSamples);
  if (healthSamples.some((sample) => !sample.ok)) {
    failures.push("isServerHealthy returned false under concurrency");
  }

  console.log(
    "\n== 2. Session API storm (health / tools / orgs / profiles) =="
  );
  const session =
    (await loginViaWeb(webUrl)) ?? (await mintDashboardSession(webUrl));
  if (session) {
    console.log(`Logged in as ${session.email} org=${session.orgId ?? "none"}`);
    try {
      const apiSamples = await stormSessionApi(session, webUrl);
      report("session API", apiSamples);
      if (apiSamples.some((sample) => !sample.ok)) {
        failures.push("authenticated API requests failed under concurrency");
      }

      console.log("\n== 3. Playwright browser storm ==");
      const browser = await chromium.launch({ headless: true });
      try {
        const uiSamples = await stormBrowser(
          browser,
          session,
          webUrl,
          artifactDir
        );
        report("browser pages", uiSamples);
        if (uiSamples.some((sample) => !sample.ok)) {
          failures.push("dashboard pages failed under concurrent tabs");
        }
      } finally {
        await browser.close();
      }
    } finally {
      await session.cleanup();
    }
  } else {
    failures.push("could not create a dashboard session for Playwright");
  }

  if (failures.length > 0) {
    console.error(`\nFAILED:\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }

  console.log("\nAll stress waves passed.");
}

async function loginViaWeb(webUrl: string): Promise<SessionAuth | null> {
  const uniqueEmails = new Map<string, { email: string; password: string }>();
  for (const candidate of LOGIN_CANDIDATES) {
    uniqueEmails.set(candidate.email, candidate);
  }

  for (const candidate of uniqueEmails.values()) {
    const api = await playwrightRequest.newContext({
      baseURL: webUrl,
    });
    const response = await api.post("/v1/auth/login", {
      data: {
        email: candidate.email,
        password: candidate.password,
      },
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
      await database.close();
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

    console.log(`Minted dashboard session for ${user.email}`);
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
    Array.from({ length: SESSION_CONCURRENCY }, (_, index) => {
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

async function stormBrowser(
  browser: Browser,
  session: SessionAuth,
  webUrl: string,
  artifactDir: string
): Promise<Sample[]> {
  const routes = ["/chat", "/profiles", "/system", "/system?tab=status"];

  const isolated = await Promise.all(
    Array.from({ length: BROWSER_CONTEXTS }, (_, index) =>
      timed(async () => {
        const context = await browser.newContext({
          storageState: session.storageState,
          viewport: { height: 900, width: 1440 },
        });
        try {
          const page = await context.newPage();
          const route = routes[index % routes.length];
          await openDashboardPage(page, `${webUrl}${route}`);
          if (index === 0) {
            await page.screenshot({
              path: join(artifactDir, "chat-after-login.png"),
            });
          }
          if (route === "/system") {
            await page.screenshot({
              path: join(artifactDir, "system-tools.png"),
            });
          }
          return true;
        } finally {
          await context.close();
        }
      })
    )
  );

  const sharedContext = await browser.newContext({
    storageState: session.storageState,
    viewport: { height: 900, width: 1440 },
  });
  try {
    const tabSamples = await Promise.all(
      Array.from({ length: SHARED_TABS }, (_, index) =>
        timed(async () => {
          const page = await sharedContext.newPage();
          await openDashboardPage(
            page,
            `${webUrl}${routes[index % routes.length]}`
          );
          return true;
        })
      )
    );

    const reloadSamples = await reloadToolsTab(
      sharedContext,
      webUrl,
      artifactDir
    );
    return [...isolated, ...tabSamples, ...reloadSamples];
  } finally {
    await sharedContext.close();
  }
}

async function reloadToolsTab(
  context: BrowserContext,
  webUrl: string,
  artifactDir: string
): Promise<Sample[]> {
  const page = await context.newPage();
  await openDashboardPage(page, `${webUrl}/system`);
  const samples: Sample[] = [];

  for (let index = 0; index < RELOADS; index += 1) {
    samples.push(
      await timed(async () => {
        const toolsResponse = page.waitForResponse(
          (response) =>
            response.url().includes("/v1/tools") &&
            response.request().method() === "GET",
          { timeout: 15_000 }
        );
        await page.reload({ waitUntil: "domcontentloaded" });
        const response = await toolsResponse;
        if (!response.ok()) {
          throw new Error(`/v1/tools ${response.status()}`);
        }
        return true;
      })
    );
  }

  await page.screenshot({
    path: join(artifactDir, "system-tools-after-reloads.png"),
  });
  return samples;
}

async function openDashboardPage(page: Page, url: string): Promise<void> {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  await page.goto(url, { timeout: 20_000, waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () =>
      Boolean(
        document.querySelector("textarea") ||
          document.body.innerText.includes("Tools") ||
          document.body.innerText.includes("Profiles") ||
          document.body.innerText.includes("Status") ||
          document.body.innerText.includes("New chat")
      ),
    undefined,
    { timeout: 20_000 }
  );

  if (page.url().includes("/login")) {
    throw new Error(`session dropped; redirected to login from ${url}`);
  }

  const blocker = pageErrors.find(
    (message) =>
      message.includes("Organization context required") ||
      message.includes("Authentication required")
  );
  if (blocker) {
    throw new Error(blocker);
  }
}

async function runRounds(
  rounds: number,
  concurrency: number,
  fn: () => Promise<Sample>
): Promise<Sample[]> {
  const samples: Sample[] = [];
  for (let round = 0; round < rounds; round += 1) {
    const batch = await Promise.all(
      Array.from({ length: concurrency }, () => fn())
    );
    samples.push(...batch);
  }
  return samples;
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

function report(label: string, samples: Sample[]): void {
  const ok = samples.filter((sample) => sample.ok);
  const failed = samples.filter((sample) => !sample.ok);
  const durations = ok.map((sample) => sample.durationMs).sort((a, b) => a - b);
  console.log(
    `${label}: ${ok.length}/${samples.length} ok  p50=${pct(durations, 50)}ms  p95=${pct(durations, 95)}ms  p99=${pct(durations, 99)}ms  max=${pct(durations, 100)}ms`
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
    await waitForUrl(PREFERRED_WEB_URL, 15_000);
    return PREFERRED_WEB_URL;
  } catch {
    if (PREFERRED_WEB_URL === API_URL) {
      throw new Error(`${PREFERRED_WEB_URL} not ready`);
    }
    console.warn(`Web ${PREFERRED_WEB_URL} not up, using ${API_URL}`);
    await waitForUrl(API_URL, 10_000);
    return API_URL;
  }
}

await main();

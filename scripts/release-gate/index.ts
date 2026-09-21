import { execSync } from "node:child_process";
import { AuthService } from "../../apps/server/src/services/auth-service";
import { OrgService } from "../../apps/server/src/services/org-service";
import { SecretScanner } from "../../packages/core/src/secret-scanner";
import { AtlasServerHarness } from "./atlas-server-harness";
import { BrowserHarness } from "./browser-harness";
import { CleanupAuditor } from "./cleanup-auditor";
import {
  ReleaseDecisionEngine,
  type ReleaseGateCheck,
} from "./decision-engine";
import { provisionIsolatedEnvironment } from "./environment-provisioner";
import { getFreePort } from "./free-port";
import { MockLLMServerHarness } from "./mock-llm-server-harness";
import { ReportGenerator } from "./report-generator";
import { runApprovalSecuritySuite } from "./suites/approval-security-suite";
import { runArtifactFidelitySuite } from "./suites/artifact-fidelity-suite";
import { runCancellationCleanupSuite } from "./suites/cancellation-cleanup-suite";
import { runCapabilitiesSuite } from "./suites/capabilities-suite";
import { runGoldenJourneysSuite } from "./suites/golden-journeys-suite";
import { runStateConsistencySuite } from "./suites/state-consistency-suite";
import { runTenantIsolationSuite } from "./suites/tenant-isolation-suite";
import { TestDatabaseHarness } from "./test-database-harness";
import { TestTenantFactory } from "./test-factories";
import { TokenRouterSmokeRunner } from "./tokenrouter-smoke-runner";

async function main() {
  const startedAt = new Date().toISOString();
  console.log("============================================================");
  console.log("🚀 STARTING ATLAS PRODUCTION RELEASE GATE PIPELINE 🚀");
  console.log("============================================================");

  const checks: ReleaseGateCheck[] = [];
  const trackedPorts: number[] = [];

  // 1. Provision Isolated E2E Environment
  const mockPort = await getFreePort();
  const serverPort = await getFreePort();
  trackedPorts.push(mockPort, serverPort);

  const env = await provisionIsolatedEnvironment({ mockPort });
  console.log(`[Env] Isolated Sandbox Root: ${env.root}`);
  console.log(`[Env] Run ID: ${env.runId}`);

  let dbHarness: TestDatabaseHarness | null = null;
  let mockServer: MockLLMServerHarness | null = null;
  let atlasServer: AtlasServerHarness | null = null;
  let browserHarness: BrowserHarness | null = null;

  try {
    // 2. Initialize Database Harness & Migrations
    dbHarness = new TestDatabaseHarness(env.databaseUrl, env.configDir);
    const dbAdapter = await dbHarness.initialize();
    const authService = new AuthService();
    const orgService = new OrgService(dbAdapter, authService);

    // 3. Start Mock LLM Server
    mockServer = new MockLLMServerHarness();
    await mockServer.start(mockPort);
    console.log(
      `[Mock LLM] Deterministic Mock CI Provider running on port ${mockPort}`
    );

    // 4. Start Atlas Server Harness
    atlasServer = new AtlasServerHarness({
      env,
      preferredPort: serverPort,
      preloadPath: new URL("./web-fetch-fixture-preload.ts", import.meta.url)
        .pathname,
    });
    const { baseUrl: serverBaseUrl } = await atlasServer.start(30_000);
    console.log(`[Atlas Server] Isolated server running on ${serverBaseUrl}`);

    // 5. Initialize Browser Harness
    browserHarness = new BrowserHarness({
      headless: true,
      screenshotsDir: env.screenshotsDir,
    });

    // 6. Setup Primary Test Tenant & User
    const tenantFactory = new TestTenantFactory(
      orgService,
      authService,
      dbAdapter
    );
    const primaryTenant = await tenantFactory.createTenant({
      adminEmail: "developer@atlas.local",
      adminName: "Lead Developer",
      name: "Atlas Core Enterprise",
    });

    // -------------------------------------------------------------
    // RUN CORE DETERMINISTIC TEST SUITES
    // -------------------------------------------------------------

    // Check 1: Static Checks / Ultracite
    const staticStart = Date.now();
    try {
      execSync("bun x ultracite check --diagnostic-level=error", {
        cwd: process.cwd(),
        stdio: "pipe",
      });
      checks.push({
        category: "Static",
        durationMs: Date.now() - staticStart,
        id: "static_checks",
        message: "Code standards and linting passed",
        required: true,
        status: "pass",
      });
    } catch (err: any) {
      checks.push({
        category: "Static",
        durationMs: Date.now() - staticStart,
        id: "static_checks",
        message: err.message,
        required: true,
        status: "fail",
      });
    }

    // Check 2: Monorepo Build
    const buildStart = Date.now();
    try {
      execSync("bun run build", {
        cwd: process.cwd(),
        stdio: "pipe",
      });
      checks.push({
        category: "Build",
        durationMs: Date.now() - buildStart,
        id: "monorepo_build",
        message: "Monorepo build completed successfully",
        required: true,
        status: "pass",
      });
    } catch (err: any) {
      checks.push({
        category: "Build",
        durationMs: Date.now() - buildStart,
        id: "monorepo_build",
        message: err.message,
        required: true,
        status: "fail",
      });
    }

    // Check 3: Secret Redaction & Scanner
    const secretScanStart = Date.now();
    try {
      const scanner = new SecretScanner();
      const findings = scanner.scanDirectory(process.cwd());
      if (findings.length > 0) {
        throw new Error(
          `Secret leak detected in repository: ${findings.map((f) => `${f.file}:${f.lineNumber} (${f.patternName})`).join("; ")}`
        );
      }
      checks.push({
        category: "Security",
        durationMs: Date.now() - secretScanStart,
        id: "secret_scan",
        message: "Zero exposed secrets detected across codebase",
        required: true,
        status: "pass",
      });
    } catch (err: any) {
      checks.push({
        category: "Security",
        durationMs: Date.now() - secretScanStart,
        failureCode: "SECRET_LEAK_DETECTED",
        id: "secret_scan",
        message: err.message,
        required: true,
        status: "fail",
      });
    }

    // Check 4: Product Robustness & Security (Execution Policy)
    const robustnessStart = Date.now();
    try {
      execSync("bun test ./scripts/e2e-product-robustness.ts", {
        cwd: process.cwd(),
        stdio: "pipe",
      });
      checks.push({
        category: "Robustness",
        durationMs: Date.now() - robustnessStart,
        id: "security_robustness",
        message: "Execution policy and override robustness verified",
        required: true,
        status: "pass",
      });
    } catch (err: any) {
      checks.push({
        category: "Robustness",
        durationMs: Date.now() - robustnessStart,
        id: "security_robustness",
        message: err.message,
        required: true,
        status: "fail",
      });
    }

    // Check 5: Capability Master Suite
    const capCheck = await runCapabilitiesSuite();
    checks.push(capCheck);

    // Check 6: Artifact Fidelity & Office Preview
    const artifactCheck = await runArtifactFidelitySuite();
    checks.push(artifactCheck);

    // Check 7: Tenant Isolation Attack Matrix
    const tenantCheck = await runTenantIsolationSuite(
      dbAdapter,
      authService,
      orgService
    );
    checks.push(tenantCheck);

    // Check 8: Approval Security & Parameter Tampering
    const approvalCheck = await runApprovalSecuritySuite();
    checks.push(approvalCheck);

    // Check 9: Cancellation & Resource Cleanup
    const cancelCheck = await runCancellationCleanupSuite();
    checks.push(cancelCheck);

    // Check 10: Golden User Journeys A–P
    console.log("[Browser QA] Executing Golden User Journeys A–P...");
    const goldenChecks = await runGoldenJourneysSuite(
      browserHarness,
      serverBaseUrl,
      primaryTenant
    );
    checks.push(...goldenChecks);

    // Check 11: Database State Consistency
    const consistencyCheck = await runStateConsistencySuite(dbHarness);
    checks.push(consistencyCheck);
  } finally {
    // -------------------------------------------------------------
    // TEARDOWN HARNESSES
    // -------------------------------------------------------------
    if (browserHarness) {
      await browserHarness.close();
    }
    if (atlasServer) {
      await atlasServer.stop();
    }
    if (mockServer) {
      await mockServer.stop();
    }
    if (dbHarness) {
      await dbHarness.close();
    }
  }

  // -------------------------------------------------------------
  // RUN AUDIT & TEARDOWN
  // -------------------------------------------------------------
  const auditor = new CleanupAuditor();
  const auditResult = await auditor.audit(env, trackedPorts);

  checks.push({
    category: "Cleanup",
    durationMs: 50,
    id: "resource_cleanup_audit",
    message: auditResult.passed
      ? "Tracked ports released and developer environment fingerprint unchanged; orphan processes are not independently enumerated"
      : auditResult.issues.join("; "),
    required: true,
    status: auditResult.passed ? "pass" : "fail",
  });

  // Destroy isolated test environment
  await env.destroy();

  // -------------------------------------------------------------
  // RUN OPTIONAL TOKENROUTER SMOKE SUITE
  // -------------------------------------------------------------
  const smokeRunner = new TokenRouterSmokeRunner();
  const smokeResult = await smokeRunner.run();
  checks.push(...smokeResult.checks);

  // -------------------------------------------------------------
  // EVALUATE RELEASE DECISION & GENERATE REPORTS
  // -------------------------------------------------------------
  const completedAt = new Date().toISOString();
  const decisionEngine = new ReleaseDecisionEngine();
  const decision = decisionEngine.evaluate(checks, {
    providerCheckReports: smokeResult.providerCheckReports,
    providerCompatibility: smokeResult.status,
    providerDetails: smokeResult.providerDetails,
  });

  const reportGen = new ReportGenerator();
  const { jsonPath, mdPath } = reportGen.generateReports(decision, env, {
    completedAt,
    environment: "isolated-e2e",
    runId: env.runId,
    startedAt,
  });

  reportGen.printTerminalSummary(decision);
  console.log(`Generated JSON Report: ${jsonPath}`);
  console.log(`Generated Markdown Report: ${mdPath}`);

  if (decision.coreDecision === "RELEASE") {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Release gate crashed with unexpected error:", err);
  process.exit(1);
});

import { expect, spyOn, test } from "bun:test";
import {
  evaluateProductionEvidence,
  type ProductionEvidenceInput,
} from "./report-writer";
import { RollbackVerifier } from "./rollback-verifier";

function localEvidence(): ProductionEvidenceInput {
  return {
    admissionLimits: {
      crossOrgIndependenceVerified: true,
      orgConcurrencyEnforced: true,
      userConcurrencyEnforced: true,
      violations: 0,
    },
    cancellationStress: { passed: true },
    cascadeTimeline: { containmentVerified: true },
    coreRegression: {
      filesChecked: 0,
      goldenJourneys: "NOT_RUN",
      lintErrors: 0,
      testsFailed: 0,
      testsPassed: 0,
    },
    localProdLikeRollback: { passed: true },
    noisyNeighborEvidence: { fairnessVerified: true },
    resourceAudit: { passed: true },
    rollbackSimulation: { status: "not_run" },
    soak: { actualDurationMs: 600_000, mode: "FULL_SOAK", status: "pass" },
  };
}

test("successful synthetic checks cannot establish production readiness", () => {
  const result = evaluateProductionEvidence(localEvidence());
  expect(result.productionReadiness).toBe("NOT_ESTABLISHED");
  expect(result.decision).toBe("PARTIAL");
  expect(
    result.checks.filter((check) => check.status === "NOT_RUN").length
  ).toBe(5);
});

test("failed admission, cancellation, fairness, containment or audit evidence blocks the report", () => {
  for (const override of [
    { admissionLimits: { ...localEvidence().admissionLimits, violations: 1 } },
    { cancellationStress: { passed: false } },
    { noisyNeighborEvidence: { fairnessVerified: false } },
    { cascadeTimeline: { containmentVerified: false } },
    { resourceAudit: { passed: false } },
    { localProdLikeRollback: { passed: false } },
  ]) {
    const result = evaluateProductionEvidence({
      ...localEvidence(),
      ...override,
    });
    expect(result.decision).toBe("BLOCKED");
    expect(result.checks.some((check) => check.status === "FAIL")).toBe(true);
  }
});

test("a passed fast soak cannot count as the ten-minute soak", () => {
  const result = evaluateProductionEvidence({
    ...localEvidence(),
    soak: {
      actualDurationMs: 30_000,
      mode: "FAST_CORRECTNESS",
      status: "pass",
    },
  });
  expect(
    result.checks.find((check) => check.name === "Ten-minute synthetic soak")
      ?.status
  ).toBe("NOT_RUN");
});

test("the unimplemented rollback simulation reports not run without claiming transitions", async () => {
  const result = await new RollbackVerifier().verifyRollbackSimulation();
  expect(result.status).toBe("not_run");
  expect(result.passed).toBe(false);
  expect(result.rollbackExecuted).toBe(false);
  expect(result.schemaRollbackCompatible).toBe(false);
});

test("a healthy staging endpoint cannot prove deployment or rollback", async () => {
  const previousEnabled = process.env.ATLAS_RUN_STAGING_ROLLBACK;
  const previousUrl = process.env.ATLAS_STAGING_URL;
  process.env.ATLAS_RUN_STAGING_ROLLBACK = "1";
  process.env.ATLAS_STAGING_URL = "https://staging.example.test";
  const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("{}")
  );
  try {
    const result = await new RollbackVerifier().verifyRealStagingFlow();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.healthCheckPassed).toBe(true);
    expect(result.status).toBe("partial");
    expect(result.realDeploymentExecuted).toBe(false);
    expect(result.realRollbackExecuted).toBe(false);
    expect(result.migrationSafety).toBe("NOT RUN");
    expect(result.postRollbackSmoke).toBe("not_run");
  } finally {
    fetchSpy.mockRestore();
    if (previousEnabled === undefined) {
      delete process.env.ATLAS_RUN_STAGING_ROLLBACK;
    } else {
      process.env.ATLAS_RUN_STAGING_ROLLBACK = previousEnabled;
    }
    if (previousUrl === undefined) {
      delete process.env.ATLAS_STAGING_URL;
    } else {
      process.env.ATLAS_STAGING_URL = previousUrl;
    }
  }
});

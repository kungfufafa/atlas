import { describe, expect, it } from "bun:test";
import {
  ReleaseDecisionEngine,
  type ReleaseGateCheck,
} from "./decision-engine";

describe("ReleaseDecisionEngine", () => {
  const engine = new ReleaseDecisionEngine();

  it("decides RELEASE when all required checks pass", () => {
    const checks: ReleaseGateCheck[] = [
      {
        category: "Static",
        durationMs: 100,
        id: "lint",
        required: true,
        status: "pass",
      },
      {
        category: "Build",
        durationMs: 200,
        id: "build",
        required: true,
        status: "pass",
      },
      {
        category: "Security",
        durationMs: 150,
        id: "secret_scan",
        required: true,
        status: "pass",
      },
      {
        category: "Security",
        durationMs: 150,
        id: "tenant_isolation",
        required: true,
        status: "pass",
      },
      {
        category: "Journeys",
        durationMs: 500,
        id: "golden_journeys",
        required: true,
        status: "pass",
      },
    ];

    const result = engine.evaluate(checks);
    expect(result.coreDecision).toBe("RELEASE");
    expect(result.blockingReasons.length).toBe(0);
    expect(result.summary.passed).toBe(5);
    expect(result.summary.failed).toBe(0);
  });

  it("decides BLOCKED when a required check fails (e.g. secret leak or tenant isolation)", () => {
    const checksWithSecretLeak: ReleaseGateCheck[] = [
      {
        category: "Static",
        durationMs: 100,
        id: "lint",
        required: true,
        status: "pass",
      },
      {
        category: "Security",
        durationMs: 150,
        failureCode: "SECRET_DETECTED",
        id: "secret_scan",
        message: "Found exposed API key in build output",
        required: true,
        status: "fail",
      },
      {
        category: "Journeys",
        durationMs: 500,
        id: "golden_journeys",
        required: true,
        status: "pass",
      },
    ];

    const result = engine.evaluate(checksWithSecretLeak);
    expect(result.coreDecision).toBe("BLOCKED");
    expect(result.blockingReasons.length).toBe(1);
    expect(result.blockingReasons[0]).toContain("SECRET_DETECTED");
  });

  it("decides BLOCKED when a required check is skipped", () => {
    const checksWithSkipped: ReleaseGateCheck[] = [
      {
        category: "Static",
        durationMs: 100,
        id: "lint",
        required: true,
        status: "pass",
      },
      {
        category: "Security",
        durationMs: 0,
        id: "tenant_isolation",
        required: true,
        status: "skipped",
      },
    ];

    const result = engine.evaluate(checksWithSkipped);
    expect(result.coreDecision).toBe("BLOCKED");
    expect(result.blockingReasons[0]).toContain("unexpectedly skipped");
  });
});

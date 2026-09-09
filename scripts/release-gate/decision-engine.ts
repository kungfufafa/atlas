import type { ProviderCheckReport } from "./tokenrouter-smoke-runner";

export interface ReleaseGateCheck {
  category: string;
  durationMs: number;
  evidence?: string[];
  failureCode?: string;
  id: string;
  message?: string;
  required: boolean;
  status: "pass" | "fail" | "skipped" | "warning";
}

export type CoreDecision = "RELEASE" | "BLOCKED";
export type ProviderCompatibilityStatus =
  | "COMPATIBLE"
  | "PARTIAL"
  | "SKIPPED"
  | "BLOCKED";

export interface DecisionEngineResult {
  blockingReasons: string[];
  checks: ReleaseGateCheck[];
  coreDecision: CoreDecision;
  /** Per-check telemetry from the provider smoke suite (Phase 26) */
  providerCheckReports?: ProviderCheckReport[];
  providerCompatibility: ProviderCompatibilityStatus;
  providerDetails?: {
    baseUrl: string;
    model: string;
    provider: string;
    providerType: string;
    summary: string;
  };
  summary: {
    durationMs: number;
    failed: number;
    passed: number;
    skipped: number;
    total: number;
    warnings: number;
  };
  warnings: string[];
}

export class ReleaseDecisionEngine {
  evaluate(
    checks: ReleaseGateCheck[],
    options?: {
      providerCompatibility?: ProviderCompatibilityStatus;
      providerCheckReports?: ProviderCheckReport[];
      providerDetails?: DecisionEngineResult["providerDetails"];
    }
  ): DecisionEngineResult {
    const blockingReasons: string[] = [];
    const warnings: string[] = [];

    let passed = 0;
    let failed = 0;
    let skipped = 0;
    let warningCount = 0;
    let totalDurationMs = 0;

    if (!checks.some((check) => check.required)) {
      blockingReasons.push("No required validation checks were supplied.");
    }

    for (const check of checks) {
      totalDurationMs += check.durationMs;

      if (check.status === "pass") {
        passed++;
      } else if (check.status === "fail") {
        failed++;
        if (check.required) {
          const msg = check.message
            ? check.failureCode
              ? `${check.message} (${check.failureCode})`
              : check.message
            : check.failureCode || "Test assertion failed";
          blockingReasons.push(
            `[${check.category}] ${check.id} failed: ${msg}`
          );
        } else {
          warnings.push(
            `[${check.category}] Non-required check ${check.id} failed: ${check.message || ""}`
          );
        }
      } else if (check.status === "skipped") {
        skipped++;
        if (check.required) {
          blockingReasons.push(
            `[${check.category}] Required check ${check.id} was unexpectedly skipped.`
          );
        }
      } else if (check.status === "warning") {
        warningCount++;
        if (check.required) {
          blockingReasons.push(
            `[${check.category}] Required check ${check.id} did not pass (warning).`
          );
        }
        warnings.push(
          `[${check.category}] ${check.id}: ${check.message || ""}`
        );
      }
    }

    const coreDecision: CoreDecision =
      blockingReasons.length === 0 && failed === 0 ? "RELEASE" : "BLOCKED";

    const providerCompatibility: ProviderCompatibilityStatus =
      options?.providerCompatibility ?? "SKIPPED";

    return {
      blockingReasons,
      checks,
      coreDecision,
      providerCheckReports: options?.providerCheckReports,
      providerCompatibility,
      providerDetails: options?.providerDetails,
      summary: {
        durationMs: totalDurationMs,
        failed,
        passed,
        skipped,
        total: checks.length,
        warnings: warningCount,
      },
      warnings,
    };
  }
}

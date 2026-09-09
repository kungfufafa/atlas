import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SloEvaluation } from "../../packages/core/src/telemetry/slo-model";
import type {
  AdmissionLimitsEvidence,
  CancellationStressReport,
  CascadeContainmentTimeline,
  ConcurrencyBatchResult,
  NoisyNeighborEvidence,
  RealSoakTestReport,
} from "./load-harness";
import type { ResourceLeakAudit } from "./resource-auditor";
import type {
  LocalProdLikeRollbackResult,
  RealStagingDeploymentResult,
  RollbackSimulationResult,
} from "./rollback-verifier";

export interface ProductionReadinessReportData {
  admissionLimits: AdmissionLimitsEvidence;
  bugsFound: Array<{
    fix: string;
    regressionTest: string;
    rootCause: string;
    symptom: string;
  }>;
  cancellationStress: CancellationStressReport;
  cascadeTimeline: CascadeContainmentTimeline;
  chaosResults: {
    provider5xxRecovery: boolean;
    providerTimeoutRecovery: boolean;
    rateLimit429Recovery: boolean;
    retrySafety: boolean;
  };
  commitSha: string;
  concurrencyBaseline: ConcurrencyBatchResult[];
  coreRegression: {
    filesChecked: number;
    goldenJourneys: string;
    lintErrors: number;
    testsFailed: number;
    testsPassed: number;
  };
  decision: "BLOCKED" | "PARTIAL";
  environment: string;
  localProdLikeRollback: LocalProdLikeRollbackResult;
  noisyNeighborEvidence: NoisyNeighborEvidence;
  remainingRisks: string[];
  resourceAudit: ResourceLeakAudit;
  resourceLimits: Record<string, { capacity: number; activeAtEnd: number }>;
  rollbackSimulation: RollbackSimulationResult;
  saturationPoint: {
    degradationConcurrencyOnset: number | null;
    mainBottleneck: string;
    safeObservedConcurrency: number | null;
  };
  slos: SloEvaluation[];
  soak: RealSoakTestReport;
  stagingDeployment: RealStagingDeploymentResult;
}

export interface ProductionEvidenceInput {
  admissionLimits: Pick<
    AdmissionLimitsEvidence,
    | "crossOrgIndependenceVerified"
    | "orgConcurrencyEnforced"
    | "userConcurrencyEnforced"
    | "violations"
  >;
  cancellationStress: Pick<CancellationStressReport, "passed">;
  cascadeTimeline: Pick<CascadeContainmentTimeline, "containmentVerified">;
  coreRegression: ProductionReadinessReportData["coreRegression"];
  localProdLikeRollback: Pick<LocalProdLikeRollbackResult, "passed">;
  noisyNeighborEvidence: Pick<NoisyNeighborEvidence, "fairnessVerified">;
  resourceAudit: Pick<ResourceLeakAudit, "passed">;
  rollbackSimulation: Pick<RollbackSimulationResult, "status">;
  soak: Pick<RealSoakTestReport, "status" | "mode" | "actualDurationMs">;
}

export function evaluateProductionEvidence(data: ProductionEvidenceInput) {
  const admission = data.admissionLimits;
  const checks = [
    {
      name: "Admission limits (local queue)",
      status:
        admission.crossOrgIndependenceVerified &&
        admission.orgConcurrencyEnforced &&
        admission.userConcurrencyEnforced &&
        admission.violations === 0
          ? "PASS"
          : "FAIL",
    },
    {
      name: "Tenant fairness (local queue)",
      status: data.noisyNeighborEvidence.fairnessVerified ? "PASS" : "FAIL",
    },
    {
      name: "Cancellation stress (synthetic work)",
      status: data.cancellationStress.passed ? "PASS" : "FAIL",
    },
    {
      name: "Cascade containment (synthetic work)",
      status: data.cascadeTimeline.containmentVerified ? "PASS" : "FAIL",
    },
    {
      name: "Runner process resource audit",
      status: data.resourceAudit.passed ? "PASS" : "FAIL",
    },
    { name: "Synthetic soak", status: data.soak.status.toUpperCase() },
    {
      name: "Ten-minute synthetic soak",
      status:
        data.soak.mode === "FULL_SOAK" && data.soak.actualDurationMs >= 600_000
          ? "PASS"
          : "NOT_RUN",
    },
    {
      name: "Level 1 Atlas rollback simulation",
      status: data.rollbackSimulation.status.toUpperCase(),
    },
    {
      name: "Level 2 HTTP fixture process routing",
      status: data.localProdLikeRollback.passed ? "PASS" : "FAIL",
    },
    {
      name: "Full repository regression",
      status:
        data.coreRegression.testsPassed + data.coreRegression.testsFailed === 0
          ? "NOT_RUN"
          : data.coreRegression.testsFailed > 0
            ? "FAIL"
            : "REPORTED_SEPARATELY",
    },
    {
      name: "Repository lint",
      status:
        data.coreRegression.filesChecked === 0
          ? "NOT_RUN"
          : data.coreRegression.lintErrors > 0
            ? "FAIL"
            : "REPORTED_SEPARATELY",
    },
    { name: "Live provider / SDK inference", status: "NOT_RUN" },
    { name: "Actual browser / Office workload capacity", status: "NOT_RUN" },
  ];
  return {
    checks,
    decision: checks.some((check) => check.status === "FAIL")
      ? "BLOCKED"
      : "PARTIAL",
    estimatedFields: [
      "soak.cacheEvictionsTotal",
      "soak.samples[].cacheEvictions",
    ],
    productionReadiness: "NOT_ESTABLISHED" as const,
    scope:
      "Synthetic queue/permit workloads and HTTP fixture process routing; not an Atlas production acceptance run.",
    unmeasuredFields: [
      "soak.samples[].browserContexts/browserPages/childProcessCount",
      "soak.samples[].officeProcesses/previewJobsRunning",
      "soak.samples[].dbActiveConnections/dbWaitingConnections",
      "soak.samples[].tempDirectories/tempFiles/staleJobs/zombies",
      "resourceAudit.browserContextsLeaked/tempFilesDelta (no instrumentation supplied)",
    ],
  };
}

export function writeProductionReports(
  data: ProductionReadinessReportData,
  outputDir: string
): { jsonPath: string; mdPath: string } {
  const jsonPath = join(outputDir, "production-readiness-report.json");
  const mdPath = join(outputDir, "production-readiness-report.md");
  const evidence = evaluateProductionEvidence(data);
  writeFileSync(
    jsonPath,
    JSON.stringify({ ...data, ...evidence }, null, 2),
    "utf-8"
  );
  const mdContent = `# Atlas local operational harness report

- Decision: **${evidence.decision}**
- Production readiness: **${evidence.productionReadiness}**
- Commit: ${data.commitSha}
- Scope: ${evidence.scope}

A passing synthetic check measures the local harness contract only. It does not
establish production throughput, live-provider compatibility, Office fidelity,
channel delivery, deployment rollback safety, or a release decision.

## Observed check outcomes

| Check | Outcome |
| --- | --- |
${evidence.checks.map((check) => `| ${check.name} | ${check.status} |`).join("\n")}

## Workload and telemetry provenance

Workload A–F, chaos and soak tasks use delayed fixture responses. Their tokens,
costs and workload timings are synthetic. Queue admission, resource permits and
the runner's memory are exercised locally. The soak's browser/process/temporary
file/DB-connection/zombie counters are placeholders, not instrumented resources.
Those fields in the JSON must not be used as cleanup or stability evidence.
Cache eviction totals are estimated by the workload loop, not observed eviction
events. Capacity saturation has not been measured against Atlas workloads.

- Soak mode: ${data.soak.mode}
- Requested duration: ${data.soak.configuredDurationMinutes} minutes
- Observed duration: ${data.soak.actualDurationMs} ms
- Samples: ${data.soak.sampleCount}
- Runner RSS classification: ${data.soak.memoryClassification}
- Final observed queue depth: ${data.soak.finalQueueDepth}
- Final observed active executions: ${data.soak.finalActiveExecutions}

## Deployment evidence

- Level 1: ${data.rollbackSimulation.status.toUpperCase()} — ${data.rollbackSimulation.details}
- Level 2: ${data.localProdLikeRollback.status.toUpperCase()} — standalone HTTP fixtures with version labels, not Atlas release binaries or database migrations.
- Level 3: ${data.stagingDeployment.status.toUpperCase()} — ${data.stagingDeployment.details}

## Missing acceptance evidence

The runner does not execute the full test suite, lint, Golden Journeys, provider
inference, actual Office/browser tasks, or live channel operations. Run and
retain those independent results, including failures and skips. A configured
staging health endpoint alone does not demonstrate a deployment and rollback.

## Reported risks

${data.remainingRisks.map((risk) => `- ${risk}`).join("\n")}

The accompanying JSON retains diagnostic inputs and measured local results.
Historical bug descriptions are supplied metadata; this run does not reproduce
or verify those repairs.
`;
  writeFileSync(mdPath, mdContent, "utf-8");
  return { jsonPath, mdPath };
}

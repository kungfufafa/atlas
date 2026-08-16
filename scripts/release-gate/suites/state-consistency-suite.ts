import type { ReleaseGateCheck } from "../decision-engine";
import type { TestDatabaseHarness } from "../test-database-harness";

export async function runStateConsistencySuite(
  dbHarness: TestDatabaseHarness
): Promise<ReleaseGateCheck> {
  const start = Date.now();

  try {
    const report = await dbHarness.auditStateConsistency();

    if (!report.isConsistent) {
      throw new Error(
        `State consistency issues detected: ${report.issues.join("; ")}`
      );
    }

    return {
      category: "Database",
      durationMs: Date.now() - start,
      id: "state_consistency",
      message:
        "Database state consistent (zero hung executions, zero orphan preview jobs)",
      required: true,
      status: "pass",
    };
  } catch (error: any) {
    return {
      category: "Database",
      durationMs: Date.now() - start,
      failureCode: "STATE_CONSISTENCY_FAILURE",
      id: "state_consistency",
      message: error.message,
      required: true,
      status: "fail",
    };
  }
}

import {
  createExecutionAttempt,
  overrideExecutionAttempt,
  resolveExecutionPolicyWithSource,
} from "../../../packages/core/src/index";
import type { ReleaseGateCheck } from "../decision-engine";

export async function runCancellationCleanupSuite(): Promise<ReleaseGateCheck> {
  const start = Date.now();

  try {
    const prompt =
      "Research artificial general intelligence and compile literature";
    const initialPolicy = resolveExecutionPolicyWithSource({
      prompt,
      userPolicy: "auto",
    });

    const initialAttempt = createExecutionAttempt({
      messageId: "msg-cancel-test-1",
      policyResolution: initialPolicy,
      requestedPolicy: "auto",
      sessionId: "session-cancel-1",
    });

    if (initialAttempt.status !== "queued") {
      throw new Error(`Expected queued status, got: ${initialAttempt.status}`);
    }

    // Cancel attempt via policy override
    const { cancelledAttempt, newAttempt } = overrideExecutionAttempt(
      initialAttempt,
      "fast"
    );

    if (cancelledAttempt.status !== "cancelled") {
      throw new Error(
        `Expected cancelled status, got: ${cancelledAttempt.status}`
      );
    }

    if (!cancelledAttempt.completedAt) {
      throw new Error("Cancelled attempt missing completedAt timestamp");
    }

    if (
      newAttempt.status !== "queued" ||
      newAttempt.resolvedPolicy !== "fast"
    ) {
      throw new Error(
        "New replacement attempt failed to initialize in queued state"
      );
    }

    if (newAttempt.parentAttemptId !== initialAttempt.id) {
      throw new Error("New attempt failed to link to parent attempt ID");
    }

    return {
      category: "Lifecycle",
      durationMs: Date.now() - start,
      id: "cancellation_cleanup",
      message:
        "Queued policy override marks the prior attempt cancelled and links its replacement; running process cancellation and artifact cleanup are not exercised",
      required: true,
      status: "pass",
    };
  } catch (error: any) {
    return {
      category: "Lifecycle",
      durationMs: Date.now() - start,
      failureCode: "CANCELLATION_CLEANUP_FAILED",
      id: "cancellation_cleanup",
      message: error.message,
      required: true,
      status: "fail",
    };
  }
}

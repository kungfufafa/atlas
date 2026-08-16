import type { ExecutionCostSummary } from "./cost-model";
import type { NormalizedFailure } from "./failure-taxonomy";

export interface TimelineEvent {
  data?: Record<string, unknown>;
  label: string;
  offsetMs: number;
  timestampMs: number;
  type: string;
}

export interface UserPerspectiveLatencies {
  artifactRequestToArtifactCardMs?: number;
  cancelClickToExecutionCancelledMs?: number;
  previewClickToPreviewReadyMs?: number;
  promptSubmitToFirstActivityMs?: number;
  promptSubmitToFirstToolActivityMs?: number;
  promptSubmitToFirstVisibleStreamTokenMs?: number;
  researchStartToFirstSourceMs?: number;
}

export interface ExecutionSummary {
  conversationId?: string;
  cost: ExecutionCostSummary;
  endedAt: number;
  executionAttemptId: string;
  failure?: NormalizedFailure;
  orgId?: string;
  providerTurnsCount: number;
  startedAt: number;
  status: "success" | "failure" | "cancelled";
  timeline: TimelineEvent[];
  toolCallsCount: number;
  totalDurationMs: number;
  userId?: string;
  userPerspective: UserPerspectiveLatencies;
}

export class ExecutionSummaryBuilder {
  private startedAt = Date.now();
  private timeline: TimelineEvent[] = [];
  private providerTurnsCount = 0;
  private toolCallsCount = 0;
  private userLatencies: UserPerspectiveLatencies = {};
  private failure?: NormalizedFailure;
  private status: "success" | "failure" | "cancelled" = "success";

  constructor(
    public readonly executionAttemptId: string,
    public readonly conversationId?: string,
    public readonly orgId?: string,
    public readonly userId?: string
  ) {
    this.recordEvent("execution.accepted", "Request accepted");
  }

  recordEvent(
    type: string,
    label: string,
    data?: Record<string, unknown>
  ): void {
    const now = Date.now();
    const offsetMs = now - this.startedAt;
    this.timeline.push({
      data,
      label,
      offsetMs,
      timestampMs: now,
      type,
    });

    if (
      !this.userLatencies.promptSubmitToFirstActivityMs &&
      type !== "execution.accepted"
    ) {
      this.userLatencies.promptSubmitToFirstActivityMs = offsetMs;
    }

    if (
      !this.userLatencies.promptSubmitToFirstVisibleStreamTokenMs &&
      type === "stream.first_token"
    ) {
      this.userLatencies.promptSubmitToFirstVisibleStreamTokenMs = offsetMs;
    }

    if (
      !this.userLatencies.promptSubmitToFirstToolActivityMs &&
      type === "tool.started"
    ) {
      this.userLatencies.promptSubmitToFirstToolActivityMs = offsetMs;
    }

    if (type === "provider.turn_completed") {
      this.providerTurnsCount += 1;
    }

    if (type === "tool.completed" || type === "tool.failed") {
      this.toolCallsCount += 1;
    }

    if (type === "execution.cancelled") {
      this.status = "cancelled";
    }
  }

  recordFailure(failure: NormalizedFailure): void {
    this.failure = failure;
    this.status = failure.code === "CANCELLED" ? "cancelled" : "failure";
    this.recordEvent("execution.failed", `Failed: ${failure.code}`, {
      message: failure.message,
    });
  }

  build(cost: ExecutionCostSummary): ExecutionSummary {
    const endedAt = Date.now();
    return {
      conversationId: this.conversationId,
      cost,
      endedAt,
      executionAttemptId: this.executionAttemptId,
      failure: this.failure,
      orgId: this.orgId,
      providerTurnsCount: this.providerTurnsCount,
      startedAt: this.startedAt,
      status: this.status,
      timeline: [...this.timeline],
      toolCallsCount: this.toolCallsCount,
      totalDurationMs: endedAt - this.startedAt,
      userId: this.userId,
      userPerspective: { ...this.userLatencies },
    };
  }
}

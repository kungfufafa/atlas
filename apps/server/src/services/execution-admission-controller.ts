import {
  AtlasApiError,
  defaultResourceLimiter,
  type ExecutionBudgetGuardrails,
  metrics,
  type ResourceLimiter,
  type ResourceType,
} from "@atlas/core";
import {
  type BackpressureQueue,
  defaultExecutionQueue,
  type WorkloadClass,
} from "./backpressure-queue";
import {
  type GracefulShutdownManager,
  gracefulShutdownManager,
} from "./graceful-shutdown";

export type AdmissionRejectReason =
  | "system_busy"
  | "system_draining"
  | "user_concurrency_limit"
  | "org_concurrency_limit"
  | "rate_limit"
  | "queue_capacity"
  | "queue_wait_exceeded"
  | "budget_not_feasible";

export type AdmissionDecision =
  | {
      allocatedResource?: ResourceType;
      type: "start";
    }
  | {
      estimatedWaitMs: number;
      queueClass: WorkloadClass;
      type: "queue";
    }
  | {
      message: string;
      reason: AdmissionRejectReason;
      retryAfterMs?: number;
      type: "reject";
    };

export interface AdmissionRequest {
  budget?: ExecutionBudgetGuardrails;
  orgId?: string;
  resourceType?: ResourceType;
  userId?: string;
  workloadClass: WorkloadClass;
}

export class ExecutionAdmissionController {
  constructor(
    private readonly queue: BackpressureQueue = defaultExecutionQueue,
    private readonly resourceLimiter: ResourceLimiter = defaultResourceLimiter,
    private readonly shutdownManager: GracefulShutdownManager = gracefulShutdownManager
  ) {}

  evaluate(request: AdmissionRequest): AdmissionDecision {
    // 1. Server draining state
    if (this.shutdownManager.isDraining()) {
      metrics.admissionTotal.inc({
        decision: "reject",
        reason: "system_draining",
      });
      return {
        message:
          "Atlas is currently draining and shutting down. No new requests accepted.",
        reason: "system_draining",
        retryAfterMs: 10_000,
        type: "reject",
      };
    }

    const queueStats = this.queue.getStats();

    // 2. Global queue capacity
    if (queueStats.queued >= queueStats.maxQueueDepth) {
      metrics.queueRejectedTotal.inc({ queue: this.queue.name });
      metrics.admissionTotal.inc({
        decision: "reject",
        reason: "queue_capacity",
      });
      return {
        message: "Atlas is handling unusually high load. Try again shortly.",
        reason: "queue_capacity",
        retryAfterMs: 2000,
        type: "reject",
      };
    }

    // 3. User concurrency pre-check
    if (request.userId) {
      const userActive = this.queue.getActiveByUser(request.userId);
      const userQueued = this.queue.getQueuedByUser(request.userId);
      const maxUser = this.queue.getMaxConcurrentPerUser();
      if (userActive >= maxUser && userQueued >= maxUser) {
        metrics.admissionTotal.inc({
          decision: "reject",
          reason: "user_concurrency_limit",
        });
        return {
          message:
            "User concurrency limit reached. Please wait for in-flight tasks to complete.",
          reason: "user_concurrency_limit",
          retryAfterMs: 2000,
          type: "reject",
        };
      }
    }

    // 4. Org concurrency pre-check
    if (request.orgId) {
      const orgActive = this.queue.getActiveByOrg(request.orgId);
      const orgQueued = this.queue.getQueuedByOrg(request.orgId);
      const maxOrg = this.queue.getMaxConcurrentPerOrg();
      if (orgActive >= maxOrg && orgQueued >= maxOrg) {
        metrics.admissionTotal.inc({
          decision: "reject",
          reason: "org_concurrency_limit",
        });
        return {
          message:
            "Organization concurrency limit reached. Please wait for in-flight tasks to complete.",
          reason: "org_concurrency_limit",
          retryAfterMs: 2000,
          type: "reject",
        };
      }
    }

    // 5. Execution budget feasibility pre-check
    if (request.budget) {
      if (
        request.budget.maxEstimatedCostUsd !== undefined &&
        request.budget.maxEstimatedCostUsd <= 0
      ) {
        metrics.admissionTotal.inc({
          decision: "reject",
          reason: "budget_not_feasible",
        });
        return {
          message: "Execution budget cost limit must be greater than zero.",
          reason: "budget_not_feasible",
          type: "reject",
        };
      }
      if (
        request.budget.maxTokens !== undefined &&
        request.budget.maxTokens <= 0
      ) {
        metrics.admissionTotal.inc({
          decision: "reject",
          reason: "budget_not_feasible",
        });
        return {
          message: "Execution token budget must be greater than zero.",
          reason: "budget_not_feasible",
          type: "reject",
        };
      }
    }

    // 6. Resource-specific limit check
    const resource =
      request.resourceType ??
      (request.workloadClass === "browser"
        ? "browser"
        : request.workloadClass === "research"
          ? "research"
          : "provider");
    const activeForResource = this.resourceLimiter.getActive(resource);
    const capacityForResource = this.resourceLimiter.getCapacity(resource);

    // 7. If under capacity, empty queue, and tenant has capacity, start immediately
    const userActive = request.userId
      ? this.queue.getActiveByUser(request.userId)
      : 0;
    const orgActive = request.orgId
      ? this.queue.getActiveByOrg(request.orgId)
      : 0;
    const maxUser = this.queue.getMaxConcurrentPerUser();
    const maxOrg = this.queue.getMaxConcurrentPerOrg();

    if (
      activeForResource < capacityForResource &&
      queueStats.active < queueStats.maxConcurrent &&
      queueStats.queued === 0 &&
      userActive < maxUser &&
      orgActive < maxOrg
    ) {
      metrics.admissionTotal.inc({
        decision: "start",
        reason: "none",
      });
      return {
        allocatedResource: resource,
        type: "start",
      };
    }

    // 8. Otherwise admit to queue
    const estimatedWaitMs = (queueStats.queued + 1) * 50;
    metrics.admissionTotal.inc({
      decision: "queue",
      reason: "none",
    });
    return {
      estimatedWaitMs,
      queueClass: request.workloadClass,
      type: "queue",
    };
  }

  assertAdmissible(request: AdmissionRequest): void {
    const decision = this.evaluate(request);
    if (decision.type === "reject") {
      const status =
        decision.reason === "system_draining" ||
        decision.reason === "queue_capacity"
          ? 503
          : 429;
      throw new AtlasApiError(
        decision.message,
        status,
        decision.reason.toUpperCase()
      );
    }
  }
}

export const admissionController = new ExecutionAdmissionController();

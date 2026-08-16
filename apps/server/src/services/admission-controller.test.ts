import { describe, expect, it } from "bun:test";
import { ResourceLimiter } from "@atlas/core";
import { BackpressureQueue } from "./backpressure-queue";
import { ExecutionAdmissionController } from "./execution-admission-controller";
import { GracefulShutdownManager } from "./graceful-shutdown";

describe("Execution Admission Controller & Resource Limiter Suite", () => {
  it("admits immediate start when under capacity and empty queue", () => {
    const queue = new BackpressureQueue("test_q", {
      maxConcurrent: 10,
      maxQueueDepth: 50,
    });
    const limiter = new ResourceLimiter({ provider: 10 });
    const shutdown = new GracefulShutdownManager();

    const controller = new ExecutionAdmissionController(
      queue,
      limiter,
      shutdown
    );
    const decision = controller.evaluate({ workloadClass: "interactive_fast" });

    expect(decision.type).toBe("start");
  });

  it("routes to queue when active concurrency or resource limiter is busy", async () => {
    const queue = new BackpressureQueue("test_q", {
      maxConcurrent: 1,
      maxQueueDepth: 50,
    });
    const limiter = new ResourceLimiter({ browser: 1 });
    const shutdown = new GracefulShutdownManager();

    const controller = new ExecutionAdmissionController(
      queue,
      limiter,
      shutdown
    );

    // Acquire browser permit
    const release = await limiter.acquire("browser");

    const decision = controller.evaluate({
      resourceType: "browser",
      workloadClass: "browser",
    });
    expect(decision.type).toBe("queue");

    release();
  });

  it("rejects admission when server is draining", async () => {
    const queue = new BackpressureQueue("test_q", {
      maxConcurrent: 10,
      maxQueueDepth: 50,
    });
    const limiter = new ResourceLimiter();
    const shutdown = new GracefulShutdownManager();

    const controller = new ExecutionAdmissionController(
      queue,
      limiter,
      shutdown
    );

    // Trigger shutdown
    void shutdown.shutdown();
    expect(shutdown.isDraining()).toBe(true);

    const decision = controller.evaluate({
      workloadClass: "interactive_standard",
    });
    expect(decision.type).toBe("reject");
    if (decision.type === "reject") {
      expect(decision.reason).toBe("system_draining");
    }

    shutdown.reset();
  });

  it("aborts waiting resource permit when signal is cancelled", async () => {
    const limiter = new ResourceLimiter({ office_conversion: 1 });

    // Acquire the only permit
    const release = await limiter.acquire("office_conversion");

    const abortController = new AbortController();
    const acquirePromise = limiter.acquire(
      "office_conversion",
      abortController.signal
    );

    expect(limiter.getWaitingCount("office_conversion")).toBe(1);

    // Abort waiter
    abortController.abort();

    await expect(acquirePromise).rejects.toThrow("aborted while waiting");
    expect(limiter.getWaitingCount("office_conversion")).toBe(0);

    release();
    expect(limiter.getActive("office_conversion")).toBe(0);
  });

  it("enforces per-user concurrency limits and rejects when quota saturated", async () => {
    const queue = new BackpressureQueue("test_user_q", {
      maxConcurrent: 20,
      maxConcurrentPerUser: 2,
      maxQueueDepth: 50,
    });
    const controller = new ExecutionAdmissionController(queue);

    // Enqueue 2 jobs for user_1
    let finish1: () => void;
    let finish2: () => void;
    let finish3: () => void;
    let finish4: () => void;

    const p1 = queue.enqueue(
      "job1",
      "interactive_fast",
      () =>
        new Promise((r) => {
          finish1 = r;
        }),
      { userId: "user_1" }
    );
    const p2 = queue.enqueue(
      "job2",
      "interactive_fast",
      () =>
        new Promise((r) => {
          finish2 = r;
        }),
      { userId: "user_1" }
    );

    expect(queue.getActiveByUser("user_1")).toBe(2);

    // Enqueue 2 more to backlog user_1
    const p3 = queue.enqueue(
      "job3",
      "interactive_fast",
      () =>
        new Promise((r) => {
          finish3 = r;
        }),
      { userId: "user_1" }
    );
    const p4 = queue.enqueue(
      "job4",
      "interactive_fast",
      () =>
        new Promise((r) => {
          finish4 = r;
        }),
      { userId: "user_1" }
    );

    expect(queue.getQueuedByUser("user_1")).toBe(2);

    // 5th request for user_1 is evaluated by admission controller -> REJECT
    const decision = controller.evaluate({
      userId: "user_1",
      workloadClass: "interactive_fast",
    });
    expect(decision.type).toBe("reject");
    if (decision.type === "reject") {
      expect(decision.reason).toBe("user_concurrency_limit");
    }

    // Clean up in-flight sequentially
    finish1!();
    await new Promise((r) => setTimeout(r, 10));
    finish3!();
    await new Promise((r) => setTimeout(r, 10));
    finish2!();
    await new Promise((r) => setTimeout(r, 10));
    finish4!();
    await Promise.all([p1, p2, p3, p4]);
  });

  it("enforces per-org concurrency limits across multiple users and guarantees cross-org fairness", async () => {
    const queue = new BackpressureQueue("test_org_q", {
      maxConcurrent: 20,
      maxConcurrentPerOrg: 2,
      maxConcurrentPerUser: 5,
      maxQueueDepth: 50,
    });
    const controller = new ExecutionAdmissionController(queue);

    let finish1: () => void;
    let finish2: () => void;
    let finish3: () => void;
    let finish4: () => void;
    let finishBeta: () => void;

    // User A and User B in Org Alpha
    const p1 = queue.enqueue(
      "job1",
      "interactive_fast",
      () =>
        new Promise((r) => {
          finish1 = r;
        }),
      { orgId: "org_alpha", userId: "user_a" }
    );
    const p2 = queue.enqueue(
      "job2",
      "interactive_fast",
      () =>
        new Promise((r) => {
          finish2 = r;
        }),
      { orgId: "org_alpha", userId: "user_b" }
    );

    expect(queue.getActiveByOrg("org_alpha")).toBe(2);

    // Fill queue backlog for org_alpha
    const p3 = queue.enqueue(
      "job3",
      "interactive_fast",
      () =>
        new Promise((r) => {
          finish3 = r;
        }),
      { orgId: "org_alpha", userId: "user_c" }
    );
    const p4 = queue.enqueue(
      "job4",
      "interactive_fast",
      () =>
        new Promise((r) => {
          finish4 = r;
        }),
      { orgId: "org_alpha", userId: "user_d" }
    );

    // Org Alpha is at limit for both active and queued -> REJECT
    const decisionAlpha = controller.evaluate({
      orgId: "org_alpha",
      userId: "user_e",
      workloadClass: "interactive_fast",
    });
    expect(decisionAlpha.type).toBe("reject");
    if (decisionAlpha.type === "reject") {
      expect(decisionAlpha.reason).toBe("org_concurrency_limit");
    }

    // Org Beta submits a job - it is admitted into queue
    let betaStarted = false;
    const pBeta = queue.enqueue(
      "jobBeta",
      "interactive_fast",
      () => {
        betaStarted = true;
        return new Promise((r) => {
          finishBeta = r;
        });
      },
      { orgId: "org_beta", userId: "user_x" }
    );

    // Even though p3 and p4 were queued first for org_alpha, org_beta is eligible and starts immediately
    expect(betaStarted).toBe(true);
    expect(queue.getActiveByOrg("org_beta")).toBe(1);

    finishBeta!();
    await pBeta;

    finish1!();
    await new Promise((r) => setTimeout(r, 10));
    finish3!();
    await new Promise((r) => setTimeout(r, 10));
    finish2!();
    await new Promise((r) => setTimeout(r, 10));
    finish4!();
    await Promise.all([p1, p2, p3, p4]);
  });
});

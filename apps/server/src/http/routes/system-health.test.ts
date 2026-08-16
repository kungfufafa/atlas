import { describe, expect, it } from "bun:test";
import { BackpressureQueue } from "../../services/backpressure-queue";
import { GracefulShutdownManager } from "../../services/graceful-shutdown";
import { StuckJobReaper } from "../../services/stuck-job-reaper";

describe("Server Operations & Backpressure Suite", () => {
  it("enforces backpressure queue concurrency and queue wait", async () => {
    const queue = new BackpressureQueue("test_queue", {
      maxConcurrent: 2,
      maxQueueDepth: 5,
    });

    let concurrent = 0;
    let maxObserved = 0;

    const task = async (id: string, ms: number) =>
      queue.enqueue(id, "interactive_standard", async () => {
        concurrent += 1;
        maxObserved = Math.max(maxObserved, concurrent);
        await new Promise((r) => setTimeout(r, ms));
        concurrent -= 1;
        return id;
      });

    const results = await Promise.all([
      task("t1", 30),
      task("t2", 30),
      task("t3", 30),
      task("t4", 30),
    ]);

    expect(results).toEqual(["t1", "t2", "t3", "t4"]);
    expect(maxObserved).toBeLessThanOrEqual(2);
  });

  it("handles deterministic queue cancellation before acquisition", async () => {
    const queue = new BackpressureQueue("cancel_queue", {
      maxConcurrent: 1,
      maxQueueDepth: 10,
    });

    // Block worker 1
    const p1 = queue.enqueue("blocker", "interactive_standard", async () => {
      await new Promise((r) => setTimeout(r, 50));
      return "done";
    });

    // Enqueue 2 which will wait in queue
    const p2 = queue.enqueue(
      "target",
      "interactive_standard",
      async () => "should_not_run"
    );

    // Cancel target before blocker finishes
    const cancelled = queue.cancel("target");
    expect(cancelled).toBe(true);

    await expect(p2).rejects.toThrow("Task cancelled before execution.");
    const res1 = await p1;
    expect(res1).toBe("done");
  });

  it("enforces per-org concurrency fairness", async () => {
    const queue = new BackpressureQueue("fair_queue", {
      maxConcurrent: 5,
      maxConcurrentPerOrg: 2,
    });

    // Org A fills its limit (2)
    const taskA1 = queue.enqueue(
      "a1",
      "interactive_standard",
      () => new Promise((r) => setTimeout(r, 40)),
      { orgId: "orgA" }
    );
    const taskA2 = queue.enqueue(
      "a2",
      "interactive_standard",
      () => new Promise((r) => setTimeout(r, 40)),
      { orgId: "orgA" }
    );

    // Org B submits 1 task
    const taskB1 = queue.enqueue(
      "b1",
      "interactive_standard",
      async () => "b_ok",
      { orgId: "orgB" }
    );

    // Org B should complete without being blocked indefinitely by Org A
    const resB = await taskB1;
    expect(resB).toBe("b_ok");

    await Promise.all([taskA1, taskA2]);
  });

  it("reaps expired leases and tracks heartbeats", async () => {
    const reaper = new StuckJobReaper(undefined, 100);
    let cancelled = false;

    reaper.registerLease({
      jobId: "stuck_job_1",
      leaseTtlMs: 50,
      onCancel: () => {
        cancelled = true;
      },
      startedAt: Date.now(),
      type: "chat",
      workerId: "worker_1",
    });

    expect(reaper.getActiveLeasesCount()).toBe(1);

    // Wait past lease TTL
    await new Promise((r) => setTimeout(r, 80));

    const reaped = await reaper.reapStuckJobs();
    expect(reaped).toBe(1);
    expect(reaper.getActiveLeasesCount()).toBe(0);
    expect(cancelled).toBe(true);
  });

  it("manages graceful shutdown, halts admission and runs hooks", async () => {
    const manager = new GracefulShutdownManager(500);
    let hookRan = false;

    manager.addHook("db_close", () => {
      hookRan = true;
    });

    expect(manager.isDraining()).toBe(false);

    let completedInFlight = false;
    const inFlight = manager.trackTask(async () => {
      await new Promise((r) => setTimeout(r, 50));
      completedInFlight = true;
      return "success";
    });

    const shutdownPromise = manager.shutdown();
    expect(manager.isDraining()).toBe(true);

    // New request is rejected
    expect(() => manager.trackTask(async () => 123)).toThrow(
      "Server is shutting down"
    );

    await Promise.all([inFlight, shutdownPromise]);
    expect(completedInFlight).toBe(true);
    expect(hookRan).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import { LOCAL_CLIENT_USER_ID } from "../local-auth";
import {
  acquireLease,
  assertIdempotentReplay,
  completeRun,
  createQueuedRun,
  heartbeatLease,
  pauseForApproval,
  resumeFromApproval,
  scheduledOccurrenceId,
} from "./run-state";

const principal = {
  isPlatformAdmin: false,
  orgId: "org_1",
  orgRole: "member" as const,
  userId: "user_1",
};

describe("durable execution runs", () => {
  test("create requires canonical principal", () => {
    expect(() =>
      createQueuedRun({
        id: "run_1",
        kind: "chat",
        orgId: "org_1",
        principal: { ...principal, userId: LOCAL_CLIENT_USER_ID },
      })
    ).toThrow(/service-account/);
  });

  test("lease is exclusive until expiry", () => {
    const run = createQueuedRun({
      id: "run_1",
      kind: "chat",
      orgId: "org_1",
      principal,
    });
    const leased = acquireLease(run, "worker-a", 1000);
    expect(leased.status).toBe("running");
    expect(() => acquireLease(leased, "worker-b", 1001)).toThrow(
      /already leased/
    );
    expect(() => acquireLease(leased, "worker-a", 1001)).toThrow(
      /already leased/
    );
    const stolen = acquireLease(leased, "worker-b", 1000 + 31_000);
    expect(stolen.leaseOwner).toBe("worker-b");
  });

  test("approval pause and exact resume", () => {
    const run = acquireLease(
      createQueuedRun({
        id: "run_1",
        kind: "chat",
        orgId: "org_1",
        principal,
      }),
      "worker-a"
    );
    const paused = pauseForApproval(run, {
      remainingToolCalls: [
        { arguments: { amount: 10 }, id: "call_1", name: "checkout" },
      ],
      resumeStepIndex: 2,
    });
    expect(paused.status).toBe("awaiting_approval");
    expect(paused.currentStepIndex).toBe(2);
    const resumed = resumeFromApproval(paused);
    expect(resumed.status).toBe("running");
  });

  test("idempotency key is principal-bound", () => {
    const run = createQueuedRun({
      id: "run_1",
      idempotencyKey: "key-1",
      kind: "automation",
      orgId: "org_1",
      principal,
    });
    expect(() =>
      assertIdempotentReplay(run, { ...principal, userId: "user_2" })
    ).toThrow(/different principal/);
    expect(assertIdempotentReplay(run, principal).id).toBe("run_1");
  });

  test("completed runs cannot be leased", () => {
    const run = completeRun(
      createQueuedRun({
        id: "run_1",
        kind: "task",
        orgId: "org_1",
        principal,
      }),
      "completed"
    );
    expect(() => acquireLease(run, "worker-a")).toThrow(/completed/);
  });

  test("heartbeat extends only the current owner and fencing rejects stale complete", () => {
    const leased = acquireLease(
      createQueuedRun({
        id: "run_1",
        kind: "automation",
        orgId: "org_1",
        principal,
      }),
      "worker-a:claim-1",
      1000
    );
    const beat = heartbeatLease(leased, "worker-a:claim-1", 5000);
    expect(new Date(beat.leaseExpiresAt ?? 0).getTime()).toBeGreaterThan(
      new Date(leased.leaseExpiresAt ?? 0).getTime()
    );
    expect(() => heartbeatLease(leased, "worker-b:claim-2", 5000)).toThrow(
      /Stale worker/
    );
    const stolen = acquireLease(leased, "worker-b:claim-2", 1000 + 31_000);
    expect(() =>
      completeRun(
        stolen,
        "completed",
        new Date().toISOString(),
        "worker-a:claim-1"
      )
    ).toThrow(/stolen/);
    expect(
      completeRun(
        stolen,
        "completed",
        new Date().toISOString(),
        "worker-b:claim-2"
      ).status
    ).toBe("completed");
  });

  test("scheduled occurrence id is deterministic for the same tick", () => {
    const at = "2026-08-25T09:00:00.000Z";
    expect(scheduledOccurrenceId("auto_1", at)).toBe(
      scheduledOccurrenceId("auto_1", new Date(at))
    );
  });
});

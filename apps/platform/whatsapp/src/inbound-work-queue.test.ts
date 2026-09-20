import { describe, expect, test } from "bun:test";
import {
  BoundedWorkQueue,
  InboundQueueSaturatedError,
} from "./inbound-work-queue";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("BoundedWorkQueue", () => {
  test("bounds active work and starts queued work after release", async () => {
    const queue = new BoundedWorkQueue({
      maxConcurrent: 1,
      maxQueued: 2,
      maxWaitMs: 1000,
    });
    const gate = deferred();
    const order: string[] = [];
    const first = queue.run(async () => {
      order.push("first-start");
      await gate.promise;
      order.push("first-end");
    });
    const second = queue.run(async () => {
      order.push("second");
    });

    expect(queue.snapshot()).toEqual({ active: 1, queued: 1 });
    expect(order).toEqual(["first-start"]);
    gate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
    expect(queue.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  test("rejects immediately when the bounded queue is full", async () => {
    const queue = new BoundedWorkQueue({
      maxConcurrent: 1,
      maxQueued: 1,
      maxWaitMs: 1000,
    });
    const gate = deferred();
    const first = queue.run(() => gate.promise);
    const second = queue.run(async () => undefined);

    await expect(queue.run(async () => undefined)).rejects.toBeInstanceOf(
      InboundQueueSaturatedError
    );
    gate.resolve();
    await Promise.all([first, second]);
  });

  test("expires work that waits in the queue too long", async () => {
    const queue = new BoundedWorkQueue({
      maxConcurrent: 1,
      maxQueued: 1,
      maxWaitMs: 5,
    });
    const gate = deferred();
    const first = queue.run(() => gate.promise);

    await expect(queue.run(async () => undefined)).rejects.toThrow(
      "wait limit exceeded"
    );
    gate.resolve();
    await first;
  });

  test("bounds same-key waiters even when other concurrent slots are free", async () => {
    const queue = new BoundedWorkQueue({
      maxConcurrent: 4,
      maxQueued: 1,
      maxWaitMs: 1000,
    });
    const gate = deferred();
    const first = queue.run(() => gate.promise, "chat");
    const second = queue.run(async () => undefined, "chat");
    expect(queue.snapshot()).toEqual({ active: 1, queued: 1 });
    await expect(
      queue.run(async () => undefined, "chat")
    ).rejects.toBeInstanceOf(InboundQueueSaturatedError);
    await queue.run(async () => undefined, "other-chat");
    gate.resolve();
    await Promise.all([first, second]);
  });

  test("expired same-key work never executes when the holder later releases", async () => {
    const queue = new BoundedWorkQueue({
      maxConcurrent: 4,
      maxQueued: 1,
      maxWaitMs: 5,
    });
    const gate = deferred();
    const first = queue.run(() => gate.promise, "chat");
    let calls = 0;
    await expect(
      queue.run(async () => {
        calls += 1;
      }, "chat")
    ).rejects.toBeInstanceOf(InboundQueueSaturatedError);
    gate.resolve();
    await first;
    expect(calls).toBe(0);
    expect(queue.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  test("releases a rejected holder and skips busy keys when draining the queue", async () => {
    const queue = new BoundedWorkQueue({
      maxConcurrent: 2,
      maxQueued: 3,
      maxWaitMs: 1000,
    });
    const a = deferred();
    const b = deferred();
    const started: string[] = [];
    const first = queue.run(() => a.promise, "a");
    const second = queue.run(async () => {
      await b.promise;
      throw new Error("failed");
    }, "b");
    const queuedA = queue.run(async () => {
      started.push("a");
    }, "a");
    const queuedC = queue.run(async () => {
      started.push("c");
    }, "c");
    b.resolve();
    await expect(second).rejects.toThrow("failed");
    await queuedC;
    expect(started).toEqual(["c"]);
    expect(queue.snapshot()).toEqual({ active: 1, queued: 1 });
    a.resolve();
    await Promise.all([first, queuedA]);
    expect(started).toEqual(["c", "a"]);
  });
});

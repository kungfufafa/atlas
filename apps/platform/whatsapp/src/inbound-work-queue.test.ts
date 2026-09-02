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
});

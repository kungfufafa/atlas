import { expect, test } from "bun:test";
import {
  ChatSendQueue,
  guardChatStateUpdates,
  stopChatSessionTurn,
} from "./chat-send-queue";

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

test("messages queued while restoring an active session drain in FIFO order after restoration", async () => {
  const sent: string[] = [];
  const first = deferred();
  const queue = new ChatSendQueue<string>(
    async (item) => {
      sent.push(item);
      if (item === "first") {
        await first.promise;
      }
    },
    () => undefined,
    () => undefined
  );
  const restored = queue.hold();
  queue.enqueue("first");
  queue.enqueue("second");
  expect(sent).toEqual([]);
  restored();
  expect(sent).toEqual(["first"]);
  first.resolve();
  await settle();
  expect(sent).toEqual(["first", "second"]);
  expect(queue.busy).toBe(false);
});

test("a rejected queued send retains its files and position while reconnecting", async () => {
  const sent: string[] = [];
  const reconnect = deferred();
  const file = { data: "original bytes", filename: "report.xlsx" };
  const first = { conflicts: 0, files: [file], text: "first" };
  const second = { conflicts: 0, files: [], text: "second" };
  const queue = new ChatSendQueue<typeof first>(
    async (item) => {
      if (item === first && item.conflicts === 0) {
        item.conflicts += 1;
        queue.pause();
        queue.restore(item);
        const release = queue.hold();
        await reconnect.promise;
        queue.resume();
        release();
        return;
      }
      expect(item.files).toBe(item === first ? first.files : second.files);
      sent.push(item.text);
    },
    () => undefined,
    () => undefined
  );
  queue.enqueue(first);
  queue.enqueue(second);
  expect(sent).toEqual([]);
  reconnect.resolve();
  await settle();
  expect(sent).toEqual(["first", "second"]);
  expect(first.files[0]).toBe(file);
});

test("restored queue remains paused after a repeated rejection until explicit resumption", async () => {
  let attempts = 0;
  const queue = new ChatSendQueue<string>(
    async (item) => {
      attempts += 1;
      queue.restore(item);
      queue.pause();
    },
    () => undefined,
    () => undefined
  );
  queue.enqueue("first");
  queue.enqueue("second");
  await settle();
  expect(attempts).toBe(1);
  queue.resume();
  await settle();
  expect(attempts).toBe(2);
});

test("cancellation holds the next send after the response stream has already ended", async () => {
  const sent: string[] = [];
  const first = deferred();
  const queue = new ChatSendQueue<string>(
    async (item) => {
      sent.push(item);
      if (item === "first") {
        await first.promise;
      }
    },
    () => undefined,
    () => undefined
  );
  queue.enqueue("first");
  const stopFinished = queue.hold();
  queue.enqueue("second");
  first.resolve();
  await settle();
  expect(sent).toEqual(["first"]);
  stopFinished();
  await settle();
  expect(sent).toEqual(["first", "second"]);
});

test("changing session or workspace invalidates old queue releases and running completions", async () => {
  const sent: string[] = [];
  const oldSend = deferred();
  const newSend = deferred();
  const queue = new ChatSendQueue<string>(
    async (item) => {
      sent.push(item);
      if (item === "old") {
        await oldSend.promise;
      }
      if (item === "new") {
        await newSend.promise;
      }
    },
    () => undefined,
    () => undefined
  );
  queue.enqueue("old");
  const oldHold = queue.hold();
  queue.enqueue("discarded");
  queue.reset();
  queue.enqueue("new");
  queue.enqueue("new next");
  oldHold();
  oldSend.resolve();
  await settle();
  expect(sent).toEqual(["old", "new"]);
  newSend.resolve();
  await settle();
  expect(sent).toEqual(["old", "new", "new next"]);
});

test("an unexpected send failure pauses remaining queued messages", async () => {
  const first = deferred();
  const errors: unknown[] = [];
  const sent: string[] = [];
  const queue = new ChatSendQueue<string>(
    async (item) => {
      sent.push(item);
      await first.promise;
      throw new Error("fixture");
    },
    () => undefined,
    (error) => errors.push(error)
  );
  queue.enqueue("first");
  queue.enqueue("second");
  first.resolve();
  await settle();
  expect(sent).toEqual(["first"]);
  expect(errors).toHaveLength(1);
});

test("resumed Stop targets only captured turn and waits until its cleanup finishes", async () => {
  const events: string[] = [];
  let active = true;
  const pending = stopChatSessionTurn({
    abortStream: () => {
      events.push("abort");
    },
    cancelTurn: async (id) => {
      events.push(`cancel:${id}`);
    },
    getStatus: async () => ({ active, turnId: "captured" }),
    isCurrent: () => true,
    turnId: "captured",
    wait: async () => {
      events.push("wait");
      active = false;
    },
  });
  await pending;
  expect(events).toEqual(["cancel:captured", "abort", "wait"]);
});

test("Stop does not cancel a new turn discovered during cleanup", async () => {
  const cancelled: string[] = [];
  await stopChatSessionTurn({
    abortStream: () => undefined,
    cancelTurn: async (id) => {
      cancelled.push(id);
    },
    getStatus: async () => ({ active: true, turnId: "replacement" }),
    isCurrent: () => true,
    turnId: "captured",
  });
  expect(cancelled).toEqual(["captured"]);
});

test("initial POST Stop aborts its stream and never adopts an unrelated server turn to cancel", async () => {
  const events: string[] = [];
  let active = true;
  await stopChatSessionTurn({
    abortStream: () => {
      events.push("abort");
    },
    cancelTurn: async (id) => {
      events.push(`cancel:${id}`);
    },
    getStatus: async () => ({ active, turnId: "unrelated" }),
    isCurrent: () => true,
    turnId: null,
    wait: async () => {
      active = false;
    },
  });
  expect(events).toEqual(["abort"]);
});

test("Stop stops polling after a workspace change and bounds stuck cleanup", async () => {
  let current = true;
  let polls = 0;
  const input = {
    abortStream: () => undefined,
    cancelTurn: async () => undefined,
    getStatus: async () => {
      polls += 1;
      return { active: true };
    },
    isCurrent: () => current,
    turnId: null,
    wait: async () => {
      current = false;
    },
  };
  await stopChatSessionTurn(input);
  expect(polls).toBe(1);
  let now = 0;
  await expect(
    stopChatSessionTurn({
      ...input,
      isCurrent: () => true,
      now: () => now,
      wait: async () => {
        now += 15_000;
      },
    })
  ).rejects.toBeInstanceOf(Error);
});

test("Stop deadlines cover a never-settling cancellation and prevent late stream aborts", async () => {
  const cancellation = deferred();
  let signal: AbortSignal | undefined;
  let aborted = false;
  await expect(
    stopChatSessionTurn({
      abortStream: () => {
        aborted = true;
      },
      cancelTurn: async (_id, requestSignal) => {
        signal = requestSignal;
        await cancellation.promise;
      },
      getStatus: async () => ({ active: false }),
      isCurrent: () => true,
      timeoutMs: 5,
      turnId: "captured",
    })
  ).rejects.toBeInstanceOf(Error);
  expect(signal?.aborted).toBe(true);
  expect(aborted).toBe(false);
  cancellation.resolve();
  await settle();
  expect(aborted).toBe(false);
});

test("Stop deadlines cover status requests whose response never settles", async () => {
  const status = deferred();
  let signal: AbortSignal | undefined;
  await expect(
    stopChatSessionTurn({
      abortStream: () => undefined,
      cancelTurn: async () => undefined,
      getStatus: async (requestSignal) => {
        signal = requestSignal;
        await status.promise;
        return { active: true };
      },
      isCurrent: () => true,
      timeoutMs: 5,
      turnId: null,
    })
  ).rejects.toBeInstanceOf(Error);
  expect(signal?.aborted).toBe(true);
  status.resolve();
});

test("late stream callbacks and queued React updates cannot mutate a newer chat", () => {
  let current = true;
  const updates: ((value: string) => string)[] = [];
  const dispatch = guardChatStateUpdates<string>(
    (update) => {
      if (typeof update === "function") {
        updates.push(update);
      }
    },
    () => current
  );
  dispatch((value) => `${value}:old chunk`);
  expect(updates).toHaveLength(1);
  current = false;
  dispatch("old context or questionnaire");
  expect(updates).toHaveLength(1);
  expect(updates[0]?.("new chat")).toBe("new chat");
});

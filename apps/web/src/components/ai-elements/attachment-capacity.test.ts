import { describe, expect, test } from "bun:test";
import { AttachmentCapacityTracker } from "./attachment-capacity";

describe("AttachmentCapacityTracker", () => {
  test("reserves capacity across concurrent batches before either commits", () => {
    const tracker = new AttachmentCapacityTracker();

    const first = tracker.reserve(4, 5);
    const second = tracker.reserve(4, 5);

    expect(first.reservation?.count).toBe(4);
    expect(first.overflowCount).toBe(0);
    expect(second.reservation?.count).toBe(1);
    expect(second.overflowCount).toBe(3);
    expect(tracker.pendingCount).toBe(5);
  });

  test("converts only successfully prepared files into committed capacity", () => {
    const tracker = new AttachmentCapacityTracker(1);
    const batch = tracker.reserve(4, 5);

    expect(batch.reservation).not.toBeNull();
    tracker.commit(batch.reservation!, 2);

    expect(tracker.pendingCount).toBe(0);
    const next = tracker.reserve(4, 5);
    expect(next.reservation?.count).toBe(2);
    expect(next.overflowCount).toBe(2);
  });

  test("clear invalidates stale asynchronous reservations", () => {
    const tracker = new AttachmentCapacityTracker(2);
    const stale = tracker.reserve(2, 5);

    expect(stale.reservation).not.toBeNull();
    tracker.clear();
    tracker.commit(stale.reservation!, 2);

    const next = tracker.reserve(5, 5);
    expect(next.reservation?.count).toBe(5);
    expect(tracker.pendingCount).toBe(5);
  });
});

import { describe, expect, test } from "bun:test";
import { LOCAL_CLIENT_USER_ID } from "../local-auth";
import { describeAction } from "./action-descriptor";
import { claimOutboxForSend, completeOutbox, enqueueOutbound } from "./outbox";
import {
  cancelSubagent,
  pollSubagent,
  startSubagent,
} from "./subagent-lifecycle";

const principal = {
  isPlatformAdmin: false,
  orgId: "org_1",
  orgRole: "member" as const,
  userId: "user_1",
};

describe("ActionDescriptor", () => {
  test("binds principal, hash, and approval requirement", () => {
    const descriptor = describeAction({
      args: { amount: 12 },
      principal,
      tool: "checkout",
    });
    expect(descriptor.principalUserId).toBe("user_1");
    expect(descriptor.requiresApproval).toBe(true);
    expect(descriptor.actionHash.length).toBeGreaterThan(8);
  });

  test("rejects service-account principal", () => {
    expect(() =>
      describeAction({
        args: {},
        principal: { ...principal, userId: LOCAL_CLIENT_USER_ID },
        tool: "web_search",
      })
    ).toThrow(/service-account/);
  });
});

describe("durable outbox", () => {
  test("revalidates allowlist on claim", () => {
    const queued = enqueueOutbound({
      envelope: {
        orgId: "org_1",
        replyTarget: { channel: "telegram", telegram: { chatId: 42 } },
        text: "hello",
      },
      id: "out_1",
      principal,
    });
    expect(() =>
      claimOutboxForSend(queued, {
        accessMode: "pairing",
        pairedUserIds: [99],
      })
    ).toThrow(/not paired/);
    const sending = claimOutboxForSend(queued, {
      accessMode: "pairing",
      pairedUserIds: [42],
    });
    expect(completeOutbox(sending, "sent").status).toBe("sent");
  });
});

describe("subagent lifecycle", () => {
  test("start/poll/cancel with budget", () => {
    const handle = startSubagent({
      budgetMs: 100,
      id: "child_1",
      principal,
      task: "summarize",
    });
    expect(handle.status).toBe("queued");
    const running = { ...handle, status: "running" as const };
    const timedOut = pollSubagent(running, 1000, 0);
    expect(timedOut.status).toBe("cancelled");
    const live = startSubagent({
      budgetMs: 10_000,
      id: "child_2",
      principal,
      task: "review",
    });
    expect(cancelSubagent(live).status).toBe("cancelled");
  });
});

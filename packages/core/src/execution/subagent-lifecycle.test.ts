import { describe, expect, test } from "bun:test";
import {
  cancelSubagent,
  completeSubagent,
  markSubagentRunning,
  pollSubagent,
  startSubagent,
} from "./subagent-lifecycle";

const principal = {
  isPlatformAdmin: false,
  orgId: "org_1",
  orgRole: "member" as const,
  userId: "user_1",
};

describe("subagent lifecycle", () => {
  test("budget timeout cancels a running handle", () => {
    const handle = markSubagentRunning(
      startSubagent({
        budgetMs: 10,
        id: "sub_1",
        principal,
        task: "research",
      })
    );
    expect(handle.status).toBe("running");
    const polled = pollSubagent(handle, 100, 0);
    expect(polled.status).toBe("cancelled");
  });

  test("cancel is refused after success", () => {
    const handle = completeSubagent(
      markSubagentRunning(
        startSubagent({
          budgetMs: 1000,
          id: "sub_1",
          principal,
          task: "research",
        })
      ),
      "succeeded"
    );
    expect(() => cancelSubagent(handle)).toThrow(/succeeded/);
  });
});

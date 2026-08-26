import { describe, expect, test } from "bun:test";
import { tickSkillCurator } from "./curator-tick";

describe("tickSkillCurator", () => {
  test("runs every listed workspace and reports due skips", async () => {
    const calls: string[] = [];
    const result = await tickSkillCurator({
      listSkillCuratorOrgs: async () => ({
        orgs: [
          { id: "org_due", lastRunAt: null },
          { id: "org_recent", lastRunAt: "2026-08-26T00:00:00.000Z" },
        ],
      }),
      runSkillCuratorDueInternal: async (orgId) => {
        calls.push(orgId);
        return {
          result:
            orgId === "org_due"
              ? {
                  considered: 0,
                  finishedAt: "2026-08-26T00:00:00.000Z",
                  orgId,
                  profileIds: [],
                  skippedAutomationOrTask: 0,
                  skippedGeneration: 0,
                  skippedInvalid: 0,
                  staged: 0,
                  startedAt: "2026-08-26T00:00:00.000Z",
                  status: "completed",
                  trigger: "scheduled",
                }
              : null,
        };
      },
    });

    expect(calls).toEqual(["org_due", "org_recent"]);
    expect(result).toEqual({ failed: 0, ran: 1, skipped: 1 });
  });

  test("isolates one workspace failure and continues the tick", async () => {
    const calls: string[] = [];
    const result = await tickSkillCurator({
      listSkillCuratorOrgs: async () => ({
        orgs: [
          { id: "org_broken", lastRunAt: null },
          { id: "org_safe", lastRunAt: null },
        ],
      }),
      runSkillCuratorDueInternal: async (orgId) => {
        calls.push(orgId);
        if (orgId === "org_broken") {
          throw new Error("provider unavailable");
        }
        return { result: null };
      },
    });

    expect(calls).toEqual(["org_broken", "org_safe"]);
    expect(result).toEqual({ failed: 1, ran: 0, skipped: 1 });
  });
});

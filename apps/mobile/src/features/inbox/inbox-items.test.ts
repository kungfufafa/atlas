import { expect, test } from "bun:test";
import { buildInboxItems } from "./inbox-items";

test("builds unread automation runs and pending proposals", () => {
  const items = buildInboxItems({
    automations: [
      { id: "auto-1", lastRunAt: "2026-01-01", name: "Nightly" } as never,
      { id: "auto-2", name: "Quiet" } as never,
    ],
    memoryProposals: [
      { bullet: "Remember the timezone", id: "mem-1" } as never,
    ],
    skillProposals: [
      {
        action: "create",
        id: "sk-1",
        profileId: "p1",
        skillName: "brief",
      } as never,
    ],
    unreadByAutomationId: { "auto-1": 2 },
  });

  expect(items.map((item) => item.id)).toEqual([
    "automation-auto-1",
    "org-memory-mem-1",
    "skill-proposal-sk-1",
  ]);
  expect(items[0]?.count).toBe(2);
  expect(items[1]?.kind).toBe("org-memory-proposal");
  expect(items[2]?.profileId).toBe("p1");
});

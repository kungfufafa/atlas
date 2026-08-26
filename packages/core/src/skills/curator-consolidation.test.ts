import { describe, expect, test } from "bun:test";
import {
  buildSkillCuratorPlan,
  resolveSkillCuratorConsolidationEnabled,
  SKILL_CURATOR_MAX_BODY_BYTES,
  SKILL_CURATOR_MAX_CANDIDATES,
  type SkillCuratorCandidate,
} from "./curator-consolidation";
import { getGlobalSkillsDir } from "./paths";

const NOW = new Date("2026-08-26T00:00:00.000Z");

function candidate(
  id: string,
  overrides: Partial<SkillCuratorCandidate> = {}
): SkillCuratorCandidate {
  return {
    body: "Follow the release checklist.",
    createdBy: "agent",
    description: "deploy production release checklist helper",
    enabled: true,
    id,
    name: id,
    sourcePath: `/tmp/atlas/orgs/org_a/profiles/profile_a/skills/${id}`,
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("skill curator consolidation planner", () => {
  test("profile override wins over the org default", () => {
    expect(
      resolveSkillCuratorConsolidationEnabled({
        orgSkillsCuratorConsolidation: true,
        profileSkillsCuratorConsolidation: false,
      })
    ).toBe(false);
    expect(
      resolveSkillCuratorConsolidationEnabled({
        orgSkillsCuratorConsolidation: false,
        profileSkillsCuratorConsolidation: true,
      })
    ).toBe(true);
  });

  test("forms a deterministic bounded cluster and picks the stable winner", () => {
    const skills = [
      candidate("deploy-helper", { useCount: 2 }),
      candidate("deploy-assistant", { useCount: 1 }),
      candidate("deploy-guide", { useCount: 0 }),
    ];
    const first = buildSkillCuratorPlan({ now: NOW, skills });
    const second = buildSkillCuratorPlan({
      now: NOW,
      skills: [...skills].reverse(),
    });
    expect(first.clusters).toEqual(second.clusters);
    expect(first.clusters[0]?.winner.id).toBe("deploy-helper");
    expect(first.clusters[0]?.losers).toHaveLength(2);
  });

  test("excludes bundled, global, disabled, pending, recent, high-use, and oversized skills", () => {
    const pending = candidate("pending");
    const plan = buildSkillCuratorPlan({
      now: NOW,
      pendingSkillIds: new Set([pending.id]),
      skills: [
        candidate("bundled", { createdBy: "bundled" }),
        candidate("global", {
          sourcePath: `${getGlobalSkillsDir()}/global`,
        }),
        candidate("disabled", { enabled: false }),
        pending,
        candidate("recent", { lastUsedAt: "2026-08-25T00:00:00.000Z" }),
        candidate("popular", { useCount: 20 }),
        candidate("huge", {
          body: "x".repeat(SKILL_CURATOR_MAX_BODY_BYTES + 1),
        }),
      ],
    });
    expect(plan.considered).toBe(0);
    expect(plan.skipped).toMatchObject({
      body_too_large: 1,
      bundled_or_global: 2,
      disabled: 1,
      high_use: 1,
      pending_proposal: 1,
      recent: 1,
    });
  });

  test("caps the candidate budget", () => {
    const skills = Array.from(
      { length: SKILL_CURATOR_MAX_CANDIDATES + 5 },
      (_, index) =>
        candidate(`candidate-${String(index).padStart(2, "0")}`, {
          description: `unique-${index}`,
        })
    );
    const plan = buildSkillCuratorPlan({ now: NOW, skills });
    expect(plan.considered).toBe(SKILL_CURATOR_MAX_CANDIDATES);
    expect(plan.skipped.candidate_budget).toBe(5);
  });
});

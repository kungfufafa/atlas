import { describe, expect, test } from "bun:test";
import {
  applySkillCasPatch,
  composeProcedureSkillMarkdown,
  hashSkillContent,
} from "./cas";
import {
  composeTurnMemoryContext,
  materializeMemoryMarkdown,
} from "./memory-view";
import {
  applyLearningMode,
  assertNeverAutoPublishesSkills,
  canAutoCommit,
  learningJobIdempotencyKey,
} from "./modes";
import { rankSkillsForMessage } from "./rank";
import type { LearningCandidate } from "./types";

const fact: LearningCandidate = {
  content: "User prefers dark mode",
  createdAt: "2026-01-01T00:00:00.000Z",
  evidenceIds: ["ev_1"],
  id: "cand_1",
  kind: "fact",
  orgId: "org_1",
  status: "proposed",
  target: "memory",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const procedure: LearningCandidate = {
  ...fact,
  id: "cand_2",
  kind: "procedure",
  target: "skill",
};

describe("learning modes", () => {
  test("off drops candidates", () => {
    expect(applyLearningMode("off", fact)).toBeNull();
  });

  test("propose keeps candidates proposed", () => {
    expect(applyLearningMode("propose", fact)?.status).toBe("proposed");
    expect(canAutoCommit("propose", "fact")).toBe(false);
  });

  test("auto may commit facts but never skills", () => {
    expect(canAutoCommit("auto", "fact")).toBe(true);
    expect(canAutoCommit("auto", "procedure")).toBe(false);
    const skill = applyLearningMode("auto", procedure);
    expect(skill?.status).toBe("proposed");
    expect(() =>
      assertNeverAutoPublishesSkills("auto", {
        ...procedure,
        status: "committed",
      })
    ).toThrow(/never auto-publish/);
  });

  test("idempotency key is session + terminal message + evaluator", () => {
    expect(
      learningJobIdempotencyKey({
        sessionId: "sess_1",
        terminalMessageId: "msg_9",
      })
    ).toBe("sess_1:msg_9:v1");
  });
});

describe("skill CAS", () => {
  test("rejects name-only skill bodies", () => {
    expect(() =>
      applySkillCasPatch({
        baseVersion: 1,
        currentContent: "---\nname: x\ndescription: y\n---\n\nnot enough",
        expectedHash: hashSkillContent(
          "---\nname: x\ndescription: y\n---\n\nnot enough"
        ),
        nextContent: "---\nname: x\ndescription: y\n---\n\nshort",
      })
    ).toThrow(/full procedure body/);
  });

  test("CAS fails when the on-disk hash drifted", () => {
    const current = composeProcedureSkillMarkdown({
      description: "Deploy Atlas",
      name: "deploy-atlas",
      steps: ["Run tests", "Ship the container"],
    });
    expect(() =>
      applySkillCasPatch({
        baseVersion: 2,
        currentContent: current,
        expectedHash: "deadbeef",
        nextContent: current,
      })
    ).toThrow(/CAS conflict/);
  });

  test("CAS apply bumps version when hash matches", () => {
    const current = composeProcedureSkillMarkdown({
      description: "Deploy Atlas",
      name: "deploy-atlas",
      steps: ["Run tests", "Ship the container"],
    });
    const next = composeProcedureSkillMarkdown({
      description: "Deploy Atlas",
      name: "deploy-atlas",
      steps: ["Run tests", "Ship the container", "Verify health"],
    });
    const applied = applySkillCasPatch({
      baseVersion: 2,
      currentContent: current,
      expectedHash: hashSkillContent(current),
      nextContent: next,
    });
    expect(applied.version).toBe(3);
    expect(applied.content).toContain("## Steps");
  });
});

describe("memory materialized view", () => {
  test("MEMORY.md is a bounded view of the ledger", () => {
    const markdown = materializeMemoryMarkdown([
      {
        content: "Prefers dark mode",
        importance: 5,
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      {
        content: "Lives in Singapore",
        importance: 1,
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect(markdown).toContain("# Memory");
    expect(markdown.indexOf("dark mode")).toBeLessThan(
      markdown.indexOf("Singapore")
    );
    expect(
      composeTurnMemoryContext([
        { content: "Prefers dark mode", updatedAt: "t" },
      ])
    ).toContain("Retrieved memory");
  });
});

describe("skill ranking", () => {
  test("boosts skills with helpful outcomes over keyword-only matches", () => {
    const ranked = rankSkillsForMessage(
      [
        { description: "weather forecasts", name: "weather" },
        { description: "deploy production services", name: "deploy" },
      ],
      "deploy the weather dashboard",
      [{ helpful: true, skillName: "deploy", useCount: 8 }]
    );
    expect(ranked[0]?.skill.name).toBe("deploy");
    expect(ranked[0]?.confidence).toBeGreaterThan(0);
  });
});

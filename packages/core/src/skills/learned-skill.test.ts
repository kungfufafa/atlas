import { describe, expect, test } from "bun:test";
import {
  buildLearnedSkillMarkdown,
  consolidateSkillLearningOutcome,
  discoveredSkillFromMarkdown,
  mergeLearnedSkillBodies,
  slugifyLearnedSkillName,
} from "./learned-skill";

describe("buildLearnedSkillMarkdown", () => {
  test("writes body-on-match frontmatter", () => {
    const markdown = buildLearnedSkillMarkdown({
      body: "Never call clearance_stamp.",
      description: "Recover from missing clearance_stamp tool",
      name: "recover-clearance-stamp",
    });
    const skill = discoveredSkillFromMarkdown(markdown);
    expect(skill.name).toBe("recover-clearance-stamp");
    expect(skill.includeBodyOnMatch).toBe(true);
    expect(skill.body).toContain("Never call clearance_stamp");
  });
});

describe("consolidateSkillLearningOutcome", () => {
  test("keeps create when the catalog is empty", () => {
    const markdown = buildLearnedSkillMarkdown({
      body: "Step one",
      description: "File a quarantine hold",
      name: "quarantine-hold",
    });
    expect(
      consolidateSkillLearningOutcome(
        { action: "create", content: markdown, name: "quarantine-hold" },
        []
      )
    ).toMatchObject({ action: "create", name: "quarantine-hold" });
  });

  test("converts a colliding create into an edit merge", () => {
    const first = buildLearnedSkillMarkdown({
      body: "Call lookup_ticket first.",
      description: "File a quarantine hold",
      name: "quarantine-hold",
    });
    const second = buildLearnedSkillMarkdown({
      body: "Then search_kb for QUARANTINE-HOLD-SOP.",
      description: "File a quarantine hold",
      name: "quarantine-hold",
    });
    const merged = consolidateSkillLearningOutcome(
      { action: "create", content: second, name: "quarantine-hold" },
      [
        {
          body: "Call lookup_ticket first.",
          description: "File a quarantine hold",
          name: "quarantine-hold",
        },
      ]
    );
    expect(merged.action).toBe("edit");
    if (merged.action !== "edit") {
      throw new Error("expected edit");
    }
    expect(merged.content).toContain("Call lookup_ticket first.");
    expect(merged.content).toContain("QUARANTINE-HOLD-SOP");
  });

  test("noops when the incoming body is already present", () => {
    const markdown = buildLearnedSkillMarkdown({
      body: "Call lookup_ticket first.",
      description: "File a quarantine hold",
      name: "quarantine-hold",
    });
    expect(
      consolidateSkillLearningOutcome(
        { action: "create", content: markdown, name: "quarantine-hold" },
        [
          {
            body: "Call lookup_ticket first.",
            description: "File a quarantine hold",
            name: "quarantine-hold",
          },
        ]
      )
    ).toEqual({ action: "noop", reason: "duplicate_skill" });
  });
});

describe("mergeLearnedSkillBodies", () => {
  test("appends only new material", () => {
    expect(mergeLearnedSkillBodies("alpha", "beta")).toContain(
      "Learned updates"
    );
    expect(mergeLearnedSkillBodies("alpha beta", "beta")).toBe("alpha beta");
  });
});

describe("slugifyLearnedSkillName", () => {
  test("returns kebab-case names", () => {
    expect(slugifyLearnedSkillName("Clearance Stamp!")).toBe("clearance-stamp");
    expect(slugifyLearnedSkillName("***")).toBe("learned-procedure");
  });
});

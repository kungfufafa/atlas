import { describe, expect, test } from "bun:test";
import { rankSkillsForMessage } from "@atlas/core";
import { createFts5SkillRanker } from "./skill-rank-fts5";

const SKILLS = [
  { description: "weather forecasts", name: "weather" },
  { description: "deploy production services", name: "deploy" },
];
const QUERY = "deploy the weather dashboard";
const OUTCOMES = [{ helpful: true, skillName: "deploy", useCount: 8 }];

describe("FTS5 skill ranker", () => {
  test("keeps the same top skill as JS BM25 with outcome boost", () => {
    const js = rankSkillsForMessage(SKILLS, QUERY, OUTCOMES);
    const fts = createFts5SkillRanker().rank(SKILLS, QUERY, OUTCOMES);
    expect(js[0]?.skill.name).toBe("deploy");
    expect(fts[0]?.skill.name).toBe("deploy");
    expect(fts[0]?.confidence).toBeGreaterThan(0);
  });

  test("retrieve uses FTS MATCH hits instead of discarding them", () => {
    const skills = [
      { description: "aws billing gpu", name: "finops" },
      { description: "weather forecasts", name: "weather" },
    ];
    const hits = createFts5SkillRanker().retrieve?.(skills, "gpu spend on aws");
    expect(hits?.map((skill) => skill.name)).toContain("finops");
    expect(hits?.map((skill) => skill.name)).not.toContain("weather");
  });
});

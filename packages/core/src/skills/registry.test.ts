import { describe, expect, test } from "bun:test";
import {
  nextSkillRevision,
  publishSkillRevision,
  quarantineSkillRevision,
  selectLatestRevision,
} from "./registry";

describe("internal skill registry", () => {
  test("versions increment from previous", () => {
    const first = nextSkillRevision({
      content: "v1",
      id: "rev_1",
      orgId: "org_1",
      previousVersion: 0,
      skillId: "skill_1",
    });
    const second = nextSkillRevision({
      content: "v2",
      id: "rev_2",
      orgId: "org_1",
      previousSemver: first.semver,
      previousVersion: first.version,
      skillId: "skill_1",
    });
    expect(selectLatestRevision([first, second])?.id).toBe("rev_2");
    expect(second.version).toBe(2);
    expect(second.digest.length).toBe(64);
    expect(second.semver).toBe("0.1.1");
    expect(second.published).toBe(false);
  });

  test("learned skills never auto-publish", () => {
    const learned = nextSkillRevision({
      content: "learned procedure",
      id: "rev_1",
      orgId: "org_1",
      previousVersion: 0,
      provenance: "learned",
      skillId: "skill_1",
    });
    expect(learned.status).toBe("draft");
    expect(() => publishSkillRevision(learned)).toThrow(/never auto-publish/);
    expect(quarantineSkillRevision(learned).status).toBe("quarantined");
  });
});

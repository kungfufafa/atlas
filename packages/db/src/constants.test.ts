import { describe, expect, test } from "bun:test";
import {
  appendRuntimeProfileRules,
  DEFAULT_AGENT_WORK_RULES,
  SUPER_AGENT_SYSTEM_PROMPT,
  SUPER_AGENT_TOOL_AUTHORING_RULES,
} from "./constants";

describe("SUPER_AGENT_SYSTEM_PROMPT", () => {
  test("requires draft-and-confirm before create_profile", () => {
    expect(SUPER_AGENT_SYSTEM_PROMPT).toContain("create_profile");
    expect(SUPER_AGENT_SYSTEM_PROMPT.toLowerCase()).toMatch(/draft/);
    expect(SUPER_AGENT_SYSTEM_PROMPT.toLowerCase()).toMatch(/confirm/);
    expect(SUPER_AGENT_SYSTEM_PROMPT).not.toContain(
      "without confirming intent when the user did not ask for it"
    );
  });

  test("clarifies profile vs skill and blocks list_skills hallucination", () => {
    expect(SUPER_AGENT_SYSTEM_PROMPT).toMatch(
      /new agent.*profile|new bot.*profile/i
    );
    expect(SUPER_AGENT_SYSTEM_PROMPT).toContain("skill_manage");
    expect(SUPER_AGENT_SYSTEM_PROMPT).toMatch(
      /only list_profiles, list_tools, and list_automations exist/i
    );
    expect(SUPER_AGENT_SYSTEM_PROMPT).not.toContain("list_skills");
    expect(SUPER_AGENT_SYSTEM_PROMPT).toMatch(
      /server generates the profile id/i
    );
    expect(SUPER_AGENT_SYSTEM_PROMPT).toMatch(/work toolkit/i);
  });
});

describe("DEFAULT_AGENT_WORK_RULES", () => {
  test("sets a Super Agent quality bar without orchestration tools", () => {
    expect(DEFAULT_AGENT_WORK_RULES).toMatch(/quality bar/i);
    expect(DEFAULT_AGENT_WORK_RULES).toMatch(/ready-to-use/i);
    expect(DEFAULT_AGENT_WORK_RULES).toContain("artifacts/");
    expect(DEFAULT_AGENT_WORK_RULES).not.toContain("create_profile");
    expect(DEFAULT_AGENT_WORK_RULES).not.toContain("create_tool");
  });
});

describe("appendRuntimeProfileRules", () => {
  test("appends Super Agent tool-authoring rules for super profiles", () => {
    const prompt = appendRuntimeProfileRules(true, "You are Super Agent.");

    expect(prompt).toContain("You are Super Agent.");
    expect(prompt).toContain(SUPER_AGENT_TOOL_AUTHORING_RULES);
    expect(prompt).not.toContain(DEFAULT_AGENT_WORK_RULES);
  });

  test("appends work-quality rules for non-super profiles", () => {
    const prompt = appendRuntimeProfileRules(
      false,
      "You embody Default Agent."
    );

    expect(prompt).toContain("You embody Default Agent.");
    expect(prompt).toContain(DEFAULT_AGENT_WORK_RULES);
    expect(prompt).not.toContain(SUPER_AGENT_TOOL_AUTHORING_RULES);
  });
});

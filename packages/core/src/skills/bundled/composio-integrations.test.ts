import { describe, expect, test } from "bun:test";
import {
  BUNDLED_SKILL_NAMES,
  DEFAULT_BUNDLED_SKILL_NAMES,
  OPT_IN_BUNDLED_SKILL_NAMES,
  SUPER_AGENT_BUNDLED_SKILL_NAMES,
} from "../bundled-names";

describe("bundled composio-integrations skill", () => {
  test("is opt-in only in the bundled name registry", () => {
    expect(OPT_IN_BUNDLED_SKILL_NAMES).toContain("composio-integrations");
    expect(BUNDLED_SKILL_NAMES).toContain("composio-integrations");
    expect(DEFAULT_BUNDLED_SKILL_NAMES).not.toContain("composio-integrations");
    expect(SUPER_AGENT_BUNDLED_SKILL_NAMES).not.toContain(
      "composio-integrations"
    );
  });
});

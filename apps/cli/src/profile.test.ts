import { describe, expect, test } from "bun:test";
import type { ProfileSummary } from "@atlas/core";
import {
  parseCliProfileArgs,
  resolveProfileInput,
  sortProfilesForPicker,
} from "./profile";

function profile(
  overrides: Partial<ProfileSummary> & Pick<ProfileSummary, "id" | "name">
): ProfileSummary {
  return {
    createdAt: "",
    hasAvatar: false,
    isSuper: false,
    mcpServerCount: 0,
    model: null,
    soulActive: false,
    toolCount: 0,
    updatedAt: "",
    ...overrides,
  };
}

const sampleProfiles = [
  profile({ id: "super_agent", isSuper: true, name: "Super Agent" }),
  profile({ id: "profile_default", isDefault: true, name: "Default Agent" }),
  profile({ id: "profile_custom", name: "Research Agent" }),
];

describe("parseCliProfileArgs", () => {
  test("reads --profile and -p", () => {
    expect(parseCliProfileArgs(["--profile", "profile_custom"])).toEqual({
      profileId: "profile_custom",
    });
    expect(parseCliProfileArgs(["-p", "super_agent"])).toEqual({
      profileId: "super_agent",
    });
  });

  test("reads --profile=value", () => {
    expect(parseCliProfileArgs(["--profile=profile_default"])).toEqual({
      profileId: "profile_default",
    });
  });
});

describe("sortProfilesForPicker", () => {
  test("puts default profile first", () => {
    const sorted = sortProfilesForPicker(sampleProfiles);
    expect(sorted[0]?.id).toBe("profile_default");
  });
});

describe("resolveProfileInput", () => {
  test("resolves id, name, and index", () => {
    expect(resolveProfileInput(sampleProfiles, "profile_custom")?.name).toBe(
      "Research Agent"
    );
    expect(resolveProfileInput(sampleProfiles, "Super Agent")?.id).toBe(
      "super_agent"
    );
    expect(resolveProfileInput(sampleProfiles, "1")?.id).toBe(
      "profile_default"
    );
  });

  test("returns undefined for unknown input", () => {
    expect(resolveProfileInput(sampleProfiles, "missing")).toBeUndefined();
  });
});

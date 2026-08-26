import { describe, expect, test } from "bun:test";
import type { AtlasClient } from "@atlas/client";
import type {
  HealthResponse,
  ModelsResponse,
  ProfileSummary,
} from "@atlas/core";
import {
  assertLearnCommandAvailable,
  formatErrorLines,
  formatStatusLines,
  isEscInterruptKey,
  needsTrailingStreamNewline,
} from "./chat";

describe("/learn availability", () => {
  test("allows profiles with the managed skill capability", async () => {
    await expect(
      assertLearnCommandAvailable(
        {
          getProfile: async () =>
            ({
              profile: { skills: [{ name: "manage-skills" }] },
            }) as Awaited<ReturnType<AtlasClient["getProfile"]>>,
        },
        "profile_with_skills"
      )
    ).resolves.toBeUndefined();
  });

  test("returns an explicit error instead of sending an inert command", async () => {
    await expect(
      assertLearnCommandAvailable(
        {
          getProfile: async () =>
            ({ profile: { skills: [] } }) as Awaited<
              ReturnType<AtlasClient["getProfile"]>
            >,
        },
        "profile_without_skills"
      )
    ).rejects.toThrow("/learn is unavailable for this profile");
  });
});

describe("needsTrailingStreamNewline", () => {
  test("adds a newline when no chunk was rendered", () => {
    expect(needsTrailingStreamNewline(null)).toBe(true);
  });

  test("adds a newline when the stream ended mid-line", () => {
    expect(needsTrailingStreamNewline("Hello.")).toBe(true);
  });

  test("skips the newline when the stream already ended with one", () => {
    expect(needsTrailingStreamNewline("Hello.\n")).toBe(false);
    expect(needsTrailingStreamNewline("Hello.\r\n")).toBe(false);
  });
});

describe("formatStatusLines", () => {
  const health: HealthResponse = {
    apiVersion: 1,
    composioAvailable: false,
    composioConfigured: false,
    ok: true,
    providerConfigured: true,
    userConfigured: true,
  };
  const models: ModelsResponse = {
    currentProviderId: "provider-a",
    displayName: null,
    models: [],
    provider: "anthropic",
    providers: [],
  };
  const profile: ProfileSummary = {
    createdAt: "",
    hasAvatar: false,
    id: "default",
    isSuper: false,
    mcpServerCount: 0,
    model: "provider-a::claude-sonnet",
    name: "Default",
    soulActive: false,
    toolCount: 0,
    updatedAt: "",
  };

  test("matches the telegram status summary fields", () => {
    expect(formatStatusLines(health, models, profile)).toEqual([
      "Server: ok",
      "Provider configured: yes",
      "Profile: Default",
      "Provider: anthropic",
      "Model: claude-sonnet",
    ]);
  });

  test("shows offline mode when no provider is configured", () => {
    expect(
      formatStatusLines({ ...health, providerConfigured: false }, null, profile)
    ).toEqual([
      "Server: ok",
      "Provider configured: no",
      "Chat runs in offline mode without an API key.",
    ]);
  });
});

describe("formatErrorLines", () => {
  test("adds a blank line above rendered errors", () => {
    expect(formatErrorLines(new Error("Boom"))).toEqual(["", "Boom"]);
  });

  test("splits multiline errors into separate render lines", () => {
    expect(
      formatErrorLines(new Error("DeepSeek request failed\ninternal_error"))
    ).toEqual(["", "DeepSeek request failed", "internal_error"]);
  });
});

describe("isEscInterruptKey", () => {
  test("matches only a standalone escape key", () => {
    expect(isEscInterruptKey("\u001b")).toBe(true);
    expect(isEscInterruptKey("\u001b[A")).toBe(false);
  });
});

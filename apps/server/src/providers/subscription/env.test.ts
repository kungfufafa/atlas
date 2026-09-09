import { describe, expect, test } from "bun:test";
import { runWithUserConfigDir } from "@atlas/core";
import {
  buildSubscriptionRuntimeEnv,
  shouldUseDeviceCodeLogin,
  subscriptionRuntimeHome,
} from "./env";

describe("subscription runtime env", () => {
  test("strips API-key env so ChatGPT subscription cannot bill OpenAI API", () => {
    const env = buildSubscriptionRuntimeEnv("chatgpt", {
      ATLAS_CONFIG_DIR: "/tmp/atlas-config",
      ATLAS_DATABASE_URL: "sqlite://secret",
      CODEX_API_KEY: "sk-codex",
      CODEX_HOME: "/tmp/host-codex-home",
      HOME: "/tmp/atlas-home",
      OPENAI_API_KEY: "sk-test",
      PATH: "/usr/bin",
    });
    expect(env.ATLAS_DATABASE_URL).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.CODEX_HOME).toBe("/tmp/atlas-config/subscription-auth/chatgpt");
    expect(env.HOME).toBe("/tmp/atlas-home");
    expect(env.PATH).toBeDefined();
  });

  test("strips Anthropic API env so Claude subscription cannot bill API credits", () => {
    const env = buildSubscriptionRuntimeEnv("claude", {
      ANTHROPIC_API_KEY: "sk-ant-test",
      ANTHROPIC_AUTH_TOKEN: "token",
      ATLAS_CONFIG_DIR: "/tmp/atlas-config",
      ATLAS_LOCAL_AUTH_TOKEN: "atlas-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-from-host",
      CLAUDE_CONFIG_DIR: undefined,
      HOME: "/tmp/atlas-home",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ATLAS_LOCAL_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBe(
      "/tmp/atlas-config/subscription-auth/claude"
    );
  });

  test("derives default Claude auth from the active Atlas config, not host HOME", () => {
    const home = runWithUserConfigDir("/tmp/atlas-scoped", () =>
      subscriptionRuntimeHome("claude", { HOME: "/tmp/host-home" })
    );
    expect(home).toBe("/tmp/atlas-scoped/subscription-auth/claude");
  });

  test("preserves an explicitly configured absolute Claude auth directory", () => {
    const env = buildSubscriptionRuntimeEnv("claude", {
      ATLAS_CONFIG_DIR: "/tmp/atlas-config",
      CLAUDE_CONFIG_DIR: "/tmp/explicit-atlas-claude",
    });
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/explicit-atlas-claude");
    expect(() =>
      subscriptionRuntimeHome("claude", { CLAUDE_CONFIG_DIR: ".claude" })
    ).toThrow();
  });

  test("prefers device login in SSH and headless Linux", () => {
    expect(shouldUseDeviceCodeLogin({ SSH_CONNECTION: "1" })).toBe(true);
    expect(
      shouldUseDeviceCodeLogin({ ATLAS_SUBSCRIPTION_LOGIN: "browser" })
    ).toBe(false);
    expect(
      shouldUseDeviceCodeLogin({ ATLAS_SUBSCRIPTION_LOGIN: "device" })
    ).toBe(true);
  });
});

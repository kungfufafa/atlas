import { describe, expect, test } from "bun:test";
import {
  claudeLoginCommand,
  claudePlatformPackageName,
  codexPlatformPackageName,
  resolveSubscriptionLaunch,
} from "./binary";

describe("bundled subscription runtimes", () => {
  test("names platform packages for the current OS", () => {
    expect(claudePlatformPackageName("darwin", "arm64")).toEqual([
      "@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
    ]);
    expect(codexPlatformPackageName("darwin", "arm64")).toBe(
      "@openai/codex-darwin-arm64"
    );
    expect(codexPlatformPackageName("linux", "x64")).toBe(
      "@openai/codex-linux-x64"
    );
  });

  test("resolves the Codex binary bundled with Atlas", () => {
    const launch = resolveSubscriptionLaunch("chatgpt");
    expect(launch).not.toBeNull();
    expect(
      launch?.command.endsWith("/codex") ||
        launch?.prefixArgs.some((arg) => arg.endsWith("codex.js"))
    ).toBe(true);
    if (launch?.command.endsWith("/codex")) {
      expect(launch.prefixArgs).toEqual([]);
    }
  });

  test("resolves the Claude binary bundled with Atlas", () => {
    const launch = resolveSubscriptionLaunch("claude");
    expect(launch).not.toBeNull();
    expect(
      launch?.command.endsWith("/claude") || launch?.command.endsWith("claude")
    ).toBe(true);
  });

  test("builds a runnable Claude login command with an empty PATH", () => {
    const launch = resolveSubscriptionLaunch("claude", { searchPath: "" });
    const command = claudeLoginCommand({
      docker: false,
      env: { PATH: "" },
      searchPath: "",
    });

    expect(launch).not.toBeNull();
    expect(command).toContain(launch?.command ?? "missing-bundled-claude");
    expect(command.endsWith(" auth login")).toBe(true);
  });

  test("builds a Docker host command without copying runtime secrets", () => {
    const command = claudeLoginCommand({
      docker: true,
      env: {
        ATLAS_CONTAINER_NAME: "atlas-test",
        CLAUDE_CODE_OAUTH_TOKEN: "must-not-appear",
        PATH: "",
      },
      searchPath: "",
    });

    expect(command.startsWith("docker exec -it atlas-test ")).toBe(true);
    expect(command.endsWith(" auth login")).toBe(true);
    expect(command).not.toContain("must-not-appear");
  });
});

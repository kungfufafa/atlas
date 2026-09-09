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
      env: { ATLAS_CONFIG_DIR: "/tmp/atlas-config", PATH: "" },
      searchPath: "",
    });

    expect(launch).not.toBeNull();
    expect(command).toContain(launch?.command ?? "missing-bundled-claude");
    expect(command).toContain(
      "CLAUDE_CONFIG_DIR=/tmp/atlas-config/subscription-auth/claude"
    );
    expect(command).toContain("-u ANTHROPIC_API_KEY");
    expect(command).toContain("-u ANTHROPIC_AUTH_TOKEN");
    expect(command).toContain("-u CLAUDE_CODE_OAUTH_TOKEN");
    expect(command.endsWith(" auth login")).toBe(true);
  });

  test("builds a Docker host command without copying runtime secrets", () => {
    const command = claudeLoginCommand({
      docker: true,
      env: {
        ATLAS_CONFIG_DIR: "/atlas/data",
        ATLAS_CONTAINER_NAME: "atlas-test",
        CLAUDE_CODE_OAUTH_TOKEN: "must-not-appear",
        PATH: "",
      },
      searchPath: "",
    });

    expect(command.startsWith("docker exec -it atlas-test ")).toBe(true);
    expect(command.endsWith(" auth login")).toBe(true);
    expect(command).toContain(
      "CLAUDE_CONFIG_DIR=/atlas/data/subscription-auth/claude"
    );
    expect(command).not.toContain("must-not-appear");
  });

  test("login wrapper preserves a quoted config path and removes inherited tokens", async () => {
    const authDirectory = "/tmp/atlas auth/claude's account";
    const command = claudeLoginCommand({
      docker: false,
      env: { CLAUDE_CONFIG_DIR: authDirectory },
    });
    // Parse the actual shell command, then run just its env wrapper with a
    // local probe. This never starts an OAuth flow or prints real credentials.
    const parsed = Bun.spawn([
      "sh",
      "-c",
      `set -- ${command}; printf '%s\\0' "$@"`,
    ]);
    const words = (await new Response(parsed.stdout).text())
      .split("\0")
      .filter(Boolean);
    expect(await parsed.exited).toBe(0);
    const configIndex = words.findIndex((word) =>
      word.startsWith("CLAUDE_CONFIG_DIR=")
    );
    expect(configIndex).toBeGreaterThan(0);
    const probe = Bun.spawn(
      [
        ...words.slice(0, configIndex + 1),
        process.execPath,
        "-e",
        "process.stdout.write(JSON.stringify({authDirectory:process.env.CLAUDE_CONFIG_DIR,apiKey:process.env.ANTHROPIC_API_KEY,authToken:process.env.ANTHROPIC_AUTH_TOKEN,oauthToken:process.env.CLAUDE_CODE_OAUTH_TOKEN}))",
      ],
      {
        env: {
          ANTHROPIC_API_KEY: "test-api-key",
          ANTHROPIC_AUTH_TOKEN: "test-auth-token",
          CLAUDE_CODE_OAUTH_TOKEN: "test-host-oauth",
          PATH: process.env.PATH,
        },
      }
    );
    const observed = await new Response(probe.stdout).json();
    expect(await probe.exited).toBe(0);
    expect(observed).toEqual({ authDirectory });
  });
});

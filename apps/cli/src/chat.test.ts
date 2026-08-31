import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AtlasClient } from "@atlas/client";
import type {
  HealthResponse,
  ModelsResponse,
  ProfileSummary,
} from "@atlas/core";
import {
  assertLearnCommandAvailable,
  createChatExitController,
  createDebouncedEscAbortHandler,
  disableRawModeIfActive,
  formatBusyDropLine,
  formatErrorLines,
  formatSoulStatusLines,
  formatStatusLines,
  isEscInterruptKey,
  needsTrailingStreamNewline,
  runCleanupThenExit,
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

describe("createChatExitController", () => {
  test("requestExit resolves wait without scheduling an interval", async () => {
    const originalSetInterval = globalThis.setInterval;
    let intervalCalls = 0;
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      intervalCalls += 1;
      return originalSetInterval(...args);
    }) as typeof setInterval;

    try {
      const exit = createChatExitController();
      const waited = exit.wait();
      expect(exit.exiting).toBe(false);
      exit.requestExit();
      await waited;
      expect(exit.exiting).toBe(true);
      expect(intervalCalls).toBe(0);
    } finally {
      globalThis.setInterval = originalSetInterval;
    }
  });

  test("AbortSignal resolves a pending wait", async () => {
    const controller = new AbortController();
    const exit = createChatExitController(controller.signal);
    const waited = exit.wait();
    controller.abort();
    await waited;
    expect(exit.exiting).toBe(true);
  });

  test("an already-aborted signal resolves immediately", async () => {
    const controller = new AbortController();
    controller.abort();
    const exit = createChatExitController(controller.signal);
    await exit.wait();
    expect(exit.exiting).toBe(true);
  });
});

describe("formatBusyDropLine", () => {
  test("uses a short marker before the warning threshold", () => {
    expect(formatBusyDropLine(1)).toBe("[busy]");
    expect(formatBusyDropLine(2)).toBe("[busy]");
  });

  test("includes the count after repeated dropped input", () => {
    expect(formatBusyDropLine(3)).toBe(
      "[busy] ignored input (3 while processing)"
    );
    expect(formatBusyDropLine(5)).toBe(
      "[busy] ignored input (5 while processing)"
    );
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

describe("formatSoulStatusLines", () => {
  const directory = join(
    homedir(),
    ".atlas",
    "orgs",
    "org_secret",
    "profiles",
    "agent-x"
  );
  const status = {
    active: true,
    directory,
    files: {
      examples: false,
      instructions: true,
      memory: true,
      soul: true,
      style: true,
    },
    profileId: "agent-x",
  };

  test("masks the soul directory by default", () => {
    expect(formatSoulStatusLines(status)[0]).toBe(
      "Soul directory: ~/.atlas/orgs/<org>/profiles/<profile>"
    );
  });

  test("shows the absolute directory in verbose mode", () => {
    expect(formatSoulStatusLines(status, true)[0]).toBe(
      `Soul directory: ${directory}`
    );
  });
});

describe("isEscInterruptKey", () => {
  test("matches only a standalone escape key", () => {
    expect(isEscInterruptKey("\u001b")).toBe(true);
    expect(isEscInterruptKey("\u001b[A")).toBe(false);
  });
});

describe("createDebouncedEscAbortHandler", () => {
  test("does not abort when more input follows ESC in the window", async () => {
    let aborted = 0;
    const handler = createDebouncedEscAbortHandler(() => {
      aborted += 1;
    }, 30);

    handler.onData("\u001b");
    handler.onData("[A");
    await Bun.sleep(50);

    expect(aborted).toBe(0);
    handler.dispose();
  });

  test("aborts after a quiet window on bare ESC", async () => {
    let aborted = 0;
    const handler = createDebouncedEscAbortHandler(() => {
      aborted += 1;
    }, 20);

    handler.onData("\u001b");
    await Bun.sleep(40);

    expect(aborted).toBe(1);
    handler.dispose();
  });
});

describe("runCleanupThenExit", () => {
  test("awaits cleanup before exit", async () => {
    const order: string[] = [];

    await runCleanupThenExit(
      async () => {
        await Bun.sleep(5);
        order.push("cleanup");
      },
      () => {
        order.push("exit");
      }
    );

    expect(order).toEqual(["cleanup", "exit"]);
  });

  test("exits even when cleanup throws", async () => {
    const order: string[] = [];

    await runCleanupThenExit(
      async () => {
        order.push("cleanup");
        throw new Error("cleanup failed");
      },
      () => {
        order.push("exit");
      }
    );

    expect(order).toEqual(["cleanup", "exit"]);
  });
});

describe("disableRawModeIfActive", () => {
  test("skips non-TTY and already-cooked streams", () => {
    const calls: boolean[] = [];
    const setRawMode = (mode: boolean) => {
      calls.push(mode);
      return process.stdin;
    };

    disableRawModeIfActive({
      isRaw: true,
      isTTY: false,
      setRawMode,
    } as NodeJS.ReadStream);
    disableRawModeIfActive({
      isRaw: false,
      isTTY: true,
      setRawMode,
    } as NodeJS.ReadStream);

    expect(calls).toEqual([]);
  });

  test("disables raw mode when active", () => {
    const calls: boolean[] = [];
    disableRawModeIfActive({
      isRaw: true,
      isTTY: true,
      setRawMode: (mode) => {
        calls.push(mode);
        return process.stdin;
      },
    } as NodeJS.ReadStream);

    expect(calls).toEqual([false]);
  });

  test("swallows setRawMode errors so cleanup can continue", () => {
    expect(() =>
      disableRawModeIfActive({
        isRaw: true,
        isTTY: true,
        setRawMode: () => {
          throw new Error("setRawMode rejected");
        },
      } as NodeJS.ReadStream)
    ).not.toThrow();
  });
});

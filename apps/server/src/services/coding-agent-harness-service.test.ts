import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import {
  buildCodingHarnessInstallPlan,
  inferCodingAgentHarnessKind,
  isCodingAgentCommand,
  listCodingAgentHarnessStatuses,
  listCodingHarnessLoginCommands,
  loadCodingAgentProviderPassthroughForOrg,
  refreshCodingAgentHarnessProbe,
  saveCodingAgentProviderPassthroughForOrg,
} from "./coding-agent-harness-service";

describe("coding-agent harness resolution", () => {
  test("lists vendor login commands and defaults each workspace to passthrough", async () => {
    const db = createInMemoryDatabaseAdapter();
    expect(
      listCodingHarnessLoginCommands().map((item) => item.command)
    ).toEqual([
      "codex login",
      "claude auth login",
      "opencode auth login",
      "pi (then enter /login)",
    ]);
    expect(
      await loadCodingAgentProviderPassthroughForOrg(db, "org-default")
    ).toBe(true);
    await saveCodingAgentProviderPassthroughForOrg(db, "org-native", false);
    expect(
      await loadCodingAgentProviderPassthroughForOrg(db, "org-native")
    ).toBe(false);
    expect(
      await loadCodingAgentProviderPassthroughForOrg(db, "org-other")
    ).toBe(true);
  });

  test("detects harness-shaped bash commands", () => {
    const harnesses = [
      { command: "claude", enabled: true },
      { command: "codex", enabled: true },
    ];

    expect(isCodingAgentCommand("claude --print 'task'", harnesses)).toBe(true);
    expect(
      isCodingAgentCommand("claude --print 'task'", [
        { command: "claude", enabled: false },
      ])
    ).toBe(false);
  });

  test("infers harness kind from argv0", () => {
    const harnesses = [
      { command: "claude", enabled: true, kind: "claude_code" as const },
      { command: "codex", enabled: true, kind: "codex" as const },
      { command: "agent", enabled: true, kind: "cursor_agent" as const },
    ];

    expect(inferCodingAgentHarnessKind("codex exec 'task'", harnesses)).toBe(
      "codex"
    );
    expect(inferCodingAgentHarnessKind("claude -p 'task'", harnesses)).toBe(
      "claude_code"
    );
    expect(
      inferCodingAgentHarnessKind("agent -p 'task' --yolo", harnesses)
    ).toBe("cursor_agent");
    expect(
      inferCodingAgentHarnessKind("npm install -g @openai/codex", harnesses)
    ).toBeNull();
  });

  test("buildCodingHarnessInstallPlan can use bun when npm is unavailable", () => {
    expect(buildCodingHarnessInstallPlan("opencode", "bun")).toEqual({
      args: ["install", "-g", "--trust", "opencode-ai"],
      command: "bun",
      displayCommand: "bun install -g --trust opencode-ai",
    });
  });

  test("refuses auto-install plan for Cursor Agent", () => {
    expect(() => buildCodingHarnessInstallPlan("cursor_agent", "npm")).toThrow(
      /cannot be auto-installed/i
    );
  });

  test("marks Cursor Agent ready when installed without provider passthrough", async () => {
    const db = createInMemoryDatabaseAdapter();
    await db.upsertWorkspaceSettings({
      codingAgentHarnesses: [
        {
          args: [],
          command: "echo",
          enabled: true,
          id: "coding-harness-cursor-agent",
          kind: "cursor_agent",
          name: "Cursor Agent",
        },
      ],
      id: "workspace-settings",
      imageModel: null,
      selectedCodingAgentHarness: null,
      transcriptionModel: null,
      updatedAt: new Date().toISOString(),
      visionModel: null,
    });

    const statuses = await listCodingAgentHarnessStatuses(db);
    const cursor = statuses.find(
      (harness) => harness.id === "coding-harness-cursor-agent"
    );
    expect(cursor?.installed).toBe(true);
    expect(cursor?.ready).toBe(true);
    expect(cursor?.statusMessage).toMatch(/host Cursor auth/i);
  });

  test("refreshCodingAgentHarnessProbe persists cached readiness", async () => {
    const db = createInMemoryDatabaseAdapter();
    await db.upsertWorkspaceSettings({
      codingAgentHarnesses: [
        {
          args: [],
          command: "echo",
          enabled: true,
          id: "coding-harness-codex",
          kind: "codex",
          name: "Codex",
        },
      ],
      id: "workspace-settings",
      imageModel: null,
      selectedCodingAgentHarness: "coding-harness-codex",
      transcriptionModel: null,
      updatedAt: new Date().toISOString(),
      visionModel: null,
    });

    const probed = await refreshCodingAgentHarnessProbe(
      db,
      "coding-harness-codex"
    );
    expect(probed.ready).toBe(true);

    const cached = await listCodingAgentHarnessStatuses(db);
    expect(
      cached.find((harness) => harness.id === "coding-harness-codex")?.ready
    ).toBe(true);
  });

  test("kills a version probe that traps SIGTERM", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "atlas-harness-probe-"));
    const commandPath = join(tempDir, "stubborn-harness");
    const pidFile = join(tempDir, "pid");
    let childPid: number | null = null;

    try {
      await writeFile(
        commandPath,
        `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
        "utf8"
      );
      await chmod(commandPath, 0o755);

      const db = createInMemoryDatabaseAdapter();
      await db.upsertWorkspaceSettings({
        codingAgentHarnesses: [
          {
            args: [],
            command: commandPath,
            enabled: true,
            id: "coding-harness-codex",
            kind: "codex",
            name: "Codex",
          },
        ],
        id: "workspace-settings",
        imageModel: null,
        selectedCodingAgentHarness: "coding-harness-codex",
        transcriptionModel: null,
        updatedAt: new Date().toISOString(),
        visionModel: null,
      });

      const startedAt = Date.now();
      const status = await refreshCodingAgentHarnessProbe(
        db,
        "coding-harness-codex"
      );

      expect(status.installed).toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(15_000);

      childPid = Number.parseInt(await readFile(pidFile, "utf8"), 10);
      expect(Number.isInteger(childPid)).toBe(true);
      expect(await waitForExit(childPid, 15_000)).toBe(true);
    } finally {
      if (childPid !== null) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // The expected path already reaped the child.
        }
      }
      await rm(tempDir, { force: true, recursive: true });
    }
  }, 45_000);

  test("does not reuse readiness cache across workspace auth scopes", async () => {
    const db = createInMemoryDatabaseAdapter();
    await db.upsertWorkspaceSettings({
      codingAgentHarnesses: [
        {
          args: [],
          command: "echo",
          enabled: true,
          id: "coding-harness-codex",
          kind: "codex",
          name: "Codex",
        },
      ],
      codingAgentProviderPassthrough: true,
      id: "workspace-settings",
      imageModel: null,
      selectedCodingAgentHarness: "coding-harness-codex",
      transcriptionModel: null,
      updatedAt: new Date().toISOString(),
      visionModel: null,
    });
    await refreshCodingAgentHarnessProbe(db, "coding-harness-codex", {
      providerPassthroughEnabled: false,
      scopeKey: "org-native",
    });
    const native = await listCodingAgentHarnessStatuses(db, {
      probeContext: {
        providerPassthroughEnabled: false,
        scopeKey: "org-native",
      },
    });
    expect(native.find((item) => item.kind === "codex")?.ready).toBe(true);

    const other = await listCodingAgentHarnessStatuses(db, {
      probeContext: {
        providerPassthroughEnabled: true,
        scopeKey: "org-other",
      },
    });
    expect(other.find((item) => item.kind === "codex")?.ready).toBe(false);
  });
});

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return false;
}

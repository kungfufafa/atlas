import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolContext } from "@atlas/core";
import { runPythonExecute } from "./python-execute-tool";

async function workspace<T>(
  run: (root: string, context: ToolContext) => Promise<T>
) {
  const root = await mkdtemp(path.join(tmpdir(), "atlas-python-deep-"));
  try {
    return await run(root, {
      orgId: "org_fixture",
      profileId: "profile_fixture",
      workspaceRoot: root,
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("PY01 bounds both multibyte output streams in bytes and marks truncation", () =>
  workspace(async (_root, context) => {
    const result = await runPythonExecute(
      {
        code: "import sys\nsys.stdout.write('中🙂' * 30000)\nsys.stderr.write('é🙂' * 30000)",
      },
      context
    );
    expect(result.success).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(64 * 1024);
    expect(result.metadata?.truncated).toBe(true);
    expect(result.stdout).not.toContain("�");
    expect(result.stderr).not.toContain("�");
  }));

test("PY02 separates workspace changes from declared deliverables", () =>
  workspace(async (_root, context) => {
    const result = await runPythonExecute(
      {
        code: "from pathlib import Path\nPath('.sources').mkdir()\nPath('.sources/input.csv').write_text('source')\nPath('scratch.txt').write_text('work')\nPath('artifacts').mkdir()\nPath('artifacts/report.csv').write_text('id,value\\n00123,4\\n')",
      },
      context
    );
    expect(result.success).toBe(true);
    expect(result.artifacts.map((artifact) => artifact.path)).toEqual([
      "artifacts/report.csv",
    ]);
    expect(
      result.artifactsGenerated.map((artifact) => artifact.path)
    ).toContain("scratch.txt");
  }));

test("PY03 failed execution retains partial files for diagnosis without publishing artifacts", () =>
  workspace(async (root, context) => {
    const result = await runPythonExecute(
      {
        code: "from pathlib import Path\nPath('artifacts').mkdir()\nPath('artifacts/partial.pdf').write_bytes(b'%PDF-incomplete')\nraise RuntimeError('fixture failure')",
      },
      context
    );
    expect(result.success).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.artifacts).toEqual([]);
    expect(
      await readFile(path.join(root, "artifacts/partial.pdf"), "utf8")
    ).toBe("%PDF-incomplete");
  }));

test("PY04 a signal-terminated process is never successful", () =>
  workspace(async (_root, context) => {
    const result = await runPythonExecute(
      { code: "import os, signal\nos.kill(os.getpid(), signal.SIGTERM)" },
      context
    );
    expect(result.success).toBe(false);
    expect(result.exitCode).not.toBe(0);
    expect(result.artifacts).toEqual([]);
  }));

for (const operation of ["cancel", "timeout"] as const) {
  test(
    `PY05 ${operation} stops descendants before a delayed workspace write`,
    () =>
      workspace(async (root, context) => {
        const controller = new AbortController();
        const childCode =
          "import time; from pathlib import Path; time.sleep(1.5); Path('late-child-write.txt').write_text('unexpected')";
        const pending = runPythonExecute(
          {
            code: `import subprocess, sys, time\nfrom pathlib import Path\nsubprocess.Popen([sys.executable, '-c', ${JSON.stringify(childCode)}])\nPath('child-started').write_text('ready')\ntime.sleep(10)`,
            timeout: operation === "timeout" ? 1000 : 10_000,
          },
          { ...context, signal: controller.signal }
        );
        void pending.catch(() => undefined);
        if (operation === "cancel") {
          const deadline = Date.now() + 3000;
          while (
            !existsSync(path.join(root, "child-started")) &&
            Date.now() < deadline
          ) {
            await Bun.sleep(10);
          }
          expect(existsSync(path.join(root, "child-started"))).toBe(true);
          controller.abort();
          await expect(pending).rejects.toThrow();
        } else {
          expect((await pending).success).toBe(false);
        }
        await Bun.sleep(1700);
        expect(existsSync(path.join(root, "late-child-write.txt"))).toBe(false);
      }),
    8000
  );
}

test("PY07 a successful parent cannot leave a background child writing after its receipt", () =>
  workspace(async (root, context) => {
    const childCode =
      "import time; from pathlib import Path; time.sleep(0.8); Path('late-background-write.txt').write_text('unexpected')";
    const result = await runPythonExecute(
      {
        code: `import subprocess, sys\nsubprocess.Popen([sys.executable, '-c', ${JSON.stringify(childCode)}], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\nprint('complete')`,
      },
      context
    );
    expect(result.success).toBe(true);
    expect(result.stdout).toBe("complete");
    await Bun.sleep(1000);
    expect(existsSync(path.join(root, "late-background-write.txt"))).toBe(
      false
    );
  }));

test("PY08 cancellation restores protected skills before returning the cancellation", () =>
  workspace(async (root, context) => {
    const skill = path.join(root, "skills", "example", "SKILL.md");
    await mkdir(path.dirname(skill), { recursive: true });
    await writeFile(skill, "original");
    const controller = new AbortController();
    const pending = runPythonExecute(
      {
        code: "from pathlib import Path\nimport time\nPath('skills/example/SKILL.md').write_text('changed')\nPath('changed-ready').write_text('ready')\ntime.sleep(10)",
      },
      {
        ...context,
        forbidProfileSkillMarkdownWrites: true,
        signal: controller.signal,
      }
    );
    void pending.catch(() => undefined);
    const deadline = Date.now() + 3000;
    while (
      !existsSync(path.join(root, "changed-ready")) &&
      Date.now() < deadline
    ) {
      await Bun.sleep(10);
    }
    expect(existsSync(path.join(root, "changed-ready"))).toBe(true);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(await readFile(skill, "utf8")).toBe("original");
  }));

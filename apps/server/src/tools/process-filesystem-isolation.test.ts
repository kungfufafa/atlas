import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { prepareRestrictedProcess } from "../services/restricted-process";
import { runBash } from "./bash";
import { runPythonExecute } from "./python-execute-tool";

async function withCanaries(
  run: (
    workspace: string,
    outside: string[],
    inheritedFd: number
  ) => Promise<void>
) {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "atlas-fs-canaries-"))
  );
  const workspace = path.join(root, "orgs", "a", "profiles", "active");
  const outside = [
    path.join(root, "orgs", "a", "profiles", "sibling", "secret"),
    path.join(root, "orgs", "b", "profiles", "other", "secret"),
    path.join(root, "config", "credentials"),
    path.join(root, "host-home", ".credentials"),
  ];
  await mkdir(workspace, { recursive: true });
  for (const file of outside) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "SYNTHETIC-CANARY-UNREADABLE");
  }
  await symlink(outside[0]!, path.join(workspace, "linked-secret"));
  const fd = await open(outside[0]!, "r");
  try {
    await run(workspace, outside, fd.fd);
    for (const file of outside) {
      expect(await readFile(file, "utf8")).toBe("SYNTHETIC-CANARY-UNREADABLE");
    }
  } finally {
    await fd.close();
    await rm(root, { force: true, recursive: true });
  }
}

test("PY06 required OS sandbox blocks sibling org/profile/config, symlinks and inherited descriptors", async () => {
  await withCanaries(async (workspaceRoot, outside, inheritedFd) => {
    const result = await runPythonExecute(
      {
        code: `
import os, json
from pathlib import Path
paths = ${JSON.stringify(outside)} + ['linked-secret']
denied = []
for name in paths:
    for mode in ('r', 'w'):
        try:
            with open(name, mode) as file:
                file.read() if mode == 'r' else file.write('ESCAPED')
        except PermissionError:
            denied.append([name, mode])
try:
    inherited = os.read(${inheritedFd}, 128).decode()
except OSError:
    inherited = 'closed'
try:
    os.link(paths[0], 'hardlink-secret')
    hardlink = Path('hardlink-secret').read_text()
except OSError:
    hardlink = 'denied'
Path('allowed.txt').write_text('workspace allowed')
Path(os.environ['HOME'], 'private.txt').write_text('private temp allowed')
print(json.dumps({'denied': len(denied), 'inherited': inherited, 'hardlink': hardlink, 'home': os.environ['HOME']}))
`,
      },
      { orgId: "a", profileId: "active", workspaceRoot }
    );
    expect(result.success).toBe(true);
    const report = JSON.parse(result.stdout);
    expect(report.denied).toBe(10);
    expect(report.inherited).not.toContain("SYNTHETIC-CANARY");
    expect(report.hardlink).toBe("denied");
    expect(report.home).not.toBe(os.homedir());
    expect(
      await readFile(path.join(workspaceRoot, "allowed.txt"), "utf8")
    ).toBe("workspace allowed");
    await expect(
      readFile(path.join(report.home, "private.txt"))
    ).rejects.toThrow();
  });
});

test("Bash and its subprocesses cannot access other profiles through absolute paths or symlinks", async () => {
  await withCanaries(async (workspaceRoot, outside, inheritedFd) => {
    const quoted = [...outside, "linked-secret", `/dev/fd/${inheritedFd}`].map(
      (value) => `'${value.replaceAll("'", "'\\''")}'`
    );
    const result = await runBash(
      {
        command: `
count=0
for file in ${quoted.join(" ")}; do
  if /bin/cat "$file" 2>/dev/null; then exit 11; fi
  count=$((count + 1))
done
for file in ${quoted.slice(0, -1).join(" ")}; do
  if (printf ESCAPED > "$file") 2>/dev/null; then exit 12; fi
done
printf allowed > allowed.txt
printf '%s' "$count"
`,
      },
      { orgId: "a", profileId: "active", workspaceRoot }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("6");
    expect(
      await readFile(path.join(workspaceRoot, "allowed.txt"), "utf8")
    ).toBe("allowed");
  });
});

test("Bash cannot inherit arbitrary host secrets or override its private home", async () => {
  await withCanaries(async (workspaceRoot) => {
    const previous = process.env.UNCLASSIFIED_CANARY;
    process.env.UNCLASSIFIED_CANARY = "host-secret-canary";
    try {
      const result = await runBash(
        {
          command: 'printf \'%s|%s\' "$UNCLASSIFIED_CANARY" "$HOME"',
          env: { HOME: os.homedir() },
        },
        { orgId: "a", profileId: "active", workspaceRoot }
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toStartWith("|/");
      expect(result.stdout).not.toContain("host-secret-canary");
      expect(result.stdout).not.toBe(`|${os.homedir()}`);
    } finally {
      if (previous === undefined) {
        delete process.env.UNCLASSIFIED_CANARY;
      } else {
        process.env.UNCLASSIFIED_CANARY = previous;
      }
    }
  });
});

test("runtime roots cannot widen the boundary to the host or Atlas configuration", async () => {
  await withCanaries(async (workspaceRoot) => {
    await expect(
      prepareRestrictedProcess({
        args: ["-c", "true"],
        bin: "/bin/bash",
        readRoots: ["/"],
        workspaceRoot,
      })
    ).rejects.toThrow();
    await expect(
      prepareRestrictedProcess({
        args: ["-c", "true"],
        bin: "/bin/bash",
        readRoots: [path.dirname(workspaceRoot)],
        workspaceRoot,
      })
    ).rejects.toThrow();
  });
});

test("Bash kills same-group background work before returning completion", async () => {
  await withCanaries(async (workspaceRoot) => {
    const result = await runBash(
      {
        command:
          "(sleep 0.5; printf late > late.txt) >/dev/null 2>&1 & printf complete",
      },
      { orgId: "a", profileId: "active", workspaceRoot }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("complete");
    await Bun.sleep(700);
    await expect(
      readFile(path.join(workspaceRoot, "late.txt"))
    ).rejects.toThrow();
  });
});

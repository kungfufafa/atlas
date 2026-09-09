import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readRestrictedProcessLinuxPolicy,
  restrictedProcessLinuxBootstrapArgs,
  validateRestrictedProcessLinuxEnvironment,
} from "./restricted-process-linux-policy";

const sources = {
  "javascript-tool-sandbox-linux.c": "included Landlock policy primitives",
  "restricted-process-linux.c": "trusted restricted C launcher",
  "restricted-process-linux.js": "trusted JavaScript launcher",
};

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "linux-policy-digest-"));
  try {
    await Promise.all(
      Object.entries(sources).map(([filename, contents]) =>
        writeFile(path.join(directory, filename), contents)
      )
    );
    await run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function policyDigest(directory: string, rules = "prepared rules") {
  const source = await readRestrictedProcessLinuxPolicy(
    rules,
    path.join(directory, "restricted-process-linux.js")
  );
  return createHash("sha256").update(source).digest("hex");
}

test("Linux policy digest changes when rules or any compiled launcher source changes", async () =>
  fixture(async (directory) => {
    const original = await policyDigest(directory);
    expect(await policyDigest(directory)).toBe(original);
    expect(await policyDigest(directory, "different prepared rules")).not.toBe(
      original
    );
    for (const [filename, contents] of Object.entries(sources)) {
      await writeFile(path.join(directory, filename), `${contents}\nchanged`);
      expect(await policyDigest(directory)).not.toBe(original);
      await writeFile(path.join(directory, filename), contents);
      expect(await policyDigest(directory)).toBe(original);
    }
  }));

test("Linux policy evidence fails closed when the included C policy source is unavailable", async () =>
  fixture(async (directory) => {
    await rm(path.join(directory, "javascript-tool-sandbox-linux.c"));
    await expect(policyDigest(directory)).rejects.toThrow();
  }));

test("trusted Bun bootstrap ignores profile preload and dotenv before entering the launcher", async () =>
  fixture(async (directory) => {
    const workspace = path.join(directory, "workspace");
    await mkdir(workspace);
    const marker = path.join(directory, "outside-preload-marker");
    const launcher = path.join(directory, "trusted-launcher.ts");
    await writeFile(
      path.join(workspace, "bunfig.toml"),
      'preload = ["./preload.ts"]\n'
    );
    await writeFile(
      path.join(workspace, "preload.ts"),
      `await Bun.write(${JSON.stringify(marker)}, "pre-sandbox execution");`
    );
    await writeFile(
      path.join(workspace, ".env"),
      "ATLAS_SYNTHETIC_STARTUP_MARKER=profile-dotenv\n"
    );
    await writeFile(
      launcher,
      "process.stdout.write(JSON.stringify({ entered: true, env: process.env.ATLAS_SYNTHETIC_STARTUP_MARKER ?? null }));"
    );
    const run = async (args: string[]) => {
      const child = Bun.spawn([process.execPath, ...args], {
        cwd: workspace,
        env: { HOME: directory },
        stderr: "pipe",
        stdout: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
      return JSON.parse(stdout);
    };
    expect(await run(["--no-install", launcher])).toEqual({
      entered: true,
      env: "profile-dotenv",
    });
    expect(await readFile(marker, "utf8")).toBe("pre-sandbox execution");
    await rm(marker);
    expect(await run(restrictedProcessLinuxBootstrapArgs(launcher))).toEqual({
      entered: true,
      env: null,
    });
    await expect(readFile(marker)).rejects.toThrow();
  }));

test("Linux bootstrap rejects loader environment injection and preserves ordinary target variables", () => {
  for (const key of [
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "BUN_OPTIONS",
    "BUN_INSPECT",
    "NODE_OPTIONS",
    "NODE_PATH",
    "ATLAS_RESTRICTED_ARG_0",
  ]) {
    expect(() =>
      validateRestrictedProcessLinuxEnvironment({ [key]: "synthetic" })
    ).toThrow();
  }
  const ordinary = {
    BASH_ENV: "/workspace/target-startup.sh",
    PYTHONPATH: "/workspace/modules",
    TARGET_VALUE: "preserved",
  };
  expect(() =>
    validateRestrictedProcessLinuxEnvironment(ordinary)
  ).not.toThrow();
  expect(ordinary).toEqual({
    BASH_ENV: "/workspace/target-startup.sh",
    PYTHONPATH: "/workspace/modules",
    TARGET_VALUE: "preserved",
  });
});

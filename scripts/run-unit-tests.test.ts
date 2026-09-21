import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  collectUnitTestFiles,
  parseUnitTestArguments,
  partitionUnitTestFiles,
  runUnitTestFiles,
  UNIT_TEST_SCOPES,
} from "./run-unit-tests";

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "atlas-unit-runner-"));
  temporaryRoots.push(root);
  return root;
}

async function addFile(root: string, path: string): Promise<void> {
  const destination = join(root, path);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, "// discovery fixture\n");
}

test("recursively discovers every Bun test suffix and extension as an explicit path", async () => {
  const root = await fixture();
  const expected: string[] = [];
  for (const suffix of [".test", "_test", ".spec", "_spec"]) {
    for (const extension of [
      "js",
      "jsx",
      "ts",
      "tsx",
      "mjs",
      "cjs",
      "mts",
      "cts",
    ]) {
      const path = `apps/example/src/nested/check${suffix}.${extension}`;
      await addFile(root, path);
      expected.push(`./${path}`);
    }
  }
  await addFile(root, "apps/example/src/test_prefix.ts");
  await addFile(root, "apps/example/src/check.test.ts.map");
  await addFile(root, "apps/example/src/check.ts");

  expect(await collectUnitTestFiles(root, ["apps"])).toEqual(expected.sort());
});

test("preserves application, package and selected script scopes without collecting docs, evidence or vendor tests", async () => {
  const root = await fixture();
  const expected = [
    "apps/server/src/server.test.ts",
    "apps/platform/telegram/src/channel.spec.ts",
    "packages/core/src/core_test.ts",
    "scripts/release-gate/nested/gate.test.ts",
    "scripts/harness-eval/budget.test.ts",
    ...UNIT_TEST_SCOPES.filter((scope) => scope.endsWith(".test.ts")),
  ];
  for (const path of [
    ...expected,
    "docs/website/page.test.ts",
    "docs/architecture/evidence/recorded.test.ts",
    "vendor/library.test.ts",
    "scripts/channel-loop-harness/smoke.test.ts",
    "scripts/unselected.test.ts",
    "apps/server/node_modules/vendor/vendor.test.ts",
    "packages/core/.git/metadata.test.ts",
  ]) {
    await addFile(root, path);
  }
  await symlink(
    join(root, "vendor"),
    join(root, "apps", "linked-vendor"),
    "dir"
  );
  await symlink(join(root, "apps"), join(root, "apps", "cycle"), "dir");

  expect(await collectUnitTestFiles(root)).toEqual(
    expected.map((path) => `./${path}`).sort()
  );
});

test("does not silently omit a missing configured scope", async () => {
  const root = await fixture();
  await addFile(root, "apps/example.test.ts");
  await expect(
    collectUnitTestFiles(root, ["apps", "missing"])
  ).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("deduplicates overlapping scopes without losing discovered files", async () => {
  const root = await fixture();
  await addFile(root, "apps/server/src/check.test.ts");

  expect(
    await collectUnitTestFiles(root, [
      "apps",
      "apps/server",
      "apps/server/src/check.test.ts",
    ])
  ).toEqual(["./apps/server/src/check.test.ts"]);
});

test("shards are deterministic, disjoint and cover every discovered file once", () => {
  const files = Array.from(
    { length: 17 },
    (_, index) => `./apps/check-${index}.test.ts`
  );
  for (const total of [1, 4, 20]) {
    const shards = Array.from({ length: total }, (_, index) =>
      partitionUnitTestFiles(files, { index: index + 1, total })
    );
    expect(shards.flat().sort()).toEqual([...files].sort());
    expect(new Set(shards.flat()).size).toBe(files.length);
    expect(partitionUnitTestFiles(files, { index: 1, total })).toEqual(
      shards[0]!
    );
  }
  expect(partitionUnitTestFiles(files)).toEqual(files);
});

test("consumes the shard selection and forwards ordinary Bun test options", () => {
  for (const shard of [["--shard=2/4"], ["--shard", "2/4"]]) {
    expect(
      parseUnitTestArguments(["--timeout=5000", ...shard, "-t", "case"])
    ).toEqual({
      forwardedArguments: ["--timeout=5000", "-t", "case"],
      shard: { index: 2, total: 4 },
    });
  }
});

test("rejects invalid shards and native worker flags before starting tests", () => {
  for (const arguments_ of [
    ["--shard=0/4"],
    ["--shard=5/4"],
    ["--shard=1/0"],
    ["--shard=one/four"],
    ["--shard"],
    ["--shard=1/4", "--shard=2/4"],
    ["--parallel=2"],
    ["--isolate"],
    ["--test-worker"],
  ]) {
    expect(() => parseUnitTestArguments(arguments_)).toThrow();
  }
});

test("runs at most two fresh ordinary processes and collects failures without omitting later files", async () => {
  const files = ["./a.test.ts", "./b.test.ts", "./c.test.ts", "./d.test.ts"];
  const commands: string[][] = [];
  const root = await fixture();
  let release!: () => void;
  const firstWave = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = 0;
  let peak = 0;
  const running = runUnitTestFiles(
    root,
    files,
    ["--timeout=5000"],
    async (command, options) => {
      commands.push(command);
      active += 1;
      peak = Math.max(peak, active);
      expect(options.cwd).toBe(root);
      expect(options.env.LLM_VCR_MODE).toBe(
        process.env.LLM_VCR_MODE ?? "replay"
      );
      if (commands.length <= 2) {
        await firstWave;
      }
      active -= 1;
      return command.at(-1) === "./b.test.ts" ? 7 : 0;
    }
  );
  expect(commands).toHaveLength(2);
  release();
  expect(await running).toEqual(["./b.test.ts"]);
  expect(peak).toBe(2);
  expect(commands).toEqual(
    files.map((file) => [process.execPath, "test", "--timeout=5000", file])
  );
});

test("an empty shard starts no processes and a successful child has no failure", async () => {
  let invocations = 0;
  const execute = async () => {
    invocations += 1;
    return 0;
  };
  expect(await runUnitTestFiles("/fixture", [], [], execute)).toEqual([]);
  expect(invocations).toBe(0);
  expect(
    await runUnitTestFiles("/fixture", ["./pass.test.ts"], [], execute)
  ).toEqual([]);
  expect(invocations).toBe(1);
});

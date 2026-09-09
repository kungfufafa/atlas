import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { collectUnitTestFiles, UNIT_TEST_SCOPES } from "./run-unit-tests";

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

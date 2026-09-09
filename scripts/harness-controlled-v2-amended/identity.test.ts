import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "../harness-compare/provenance";
import { comparisonModel } from "../harness-compare-v2-transport/proxy";
import {
  buildSchedule as originalBuildSchedule,
  suite as originalSuite,
} from "../harness-controlled-v2/provenance";
import { createRuntimeIdentity, verifyRuntimeIdentity } from "./identity";
import { buildSchedule, suite } from "./provenance";

async function fixture() {
  const directory = await mkdtemp(
    "/private/tmp/private-evaluator-unsupported_fact-seed-123-"
  );
  const parent = await mkdtemp("/private/tmp/atlas-harness-runtime-");
  const { identity, identitySha256 } = await createRuntimeIdentity(
    directory,
    parent,
    {
      attemptId: "private-unsupported_fact-123-hermes",
      harness: "hermes",
      repetition: 0,
      taskId: "private-task-unsupported_fact-123",
    }
  );
  const base = `http://127.0.0.1:12345/runs/${identity.transportId}`;
  const input = {
    base_url: `${base}/v1`,
    hermes_home: join(identity.nativeStateRoot, "hermes-home"),
    model: comparisonModel,
    run_id: identity.transportId,
    tool_base_url: base,
    workspace: identity.workspaceRoot,
  };
  const output = {
    harness: "hermes",
    model: comparisonModel,
    run_id: identity.transportId,
    workspace: identity.workspaceRoot,
  };
  await writeFile(join(directory, "runner-input.json"), JSON.stringify(input));
  await writeFile(
    join(directory, "runner-stdout.json"),
    JSON.stringify(output)
  );
  await mkdir(join(directory, "wire"));
  await writeFile(
    join(directory, "wire/001-request.json"),
    JSON.stringify({
      effective: {
        messages: [
          { content: `Workspace: ${identity.workspaceRoot}`, role: "system" },
        ],
      },
    })
  );
  const record = {
    harness: identity.harness,
    id: identity.attemptId,
    identitySha256,
    phase: "development",
    repetition: identity.repetition,
    taskId: identity.taskId,
    transportId: identity.transportId,
  };
  return {
    async close() {
      await rm(directory, { force: true, recursive: true });
      await rm(parent, { force: true, recursive: true });
    },
    directory,
    identity,
    input,
    output,
    parent,
    record,
  };
}
const emptySeen = () => ({
  roots: new Set<string>(),
  transports: new Set<string>(),
});

test("opaque identity is immutable, model-visible paths are neutral, and reuse is rejected", async () => {
  const current = await fixture();
  try {
    const seen = emptySeen();
    expect(
      await verifyRuntimeIdentity(current.directory, current.record, seen)
    ).toEqual(current.identity);
    expect(current.identity.workspaceRoot).not.toContain("unsupported_fact");
    expect(current.identity.transportId).toMatch(/^transport-[a-f0-9-]{36}$/);
    await expect(
      verifyRuntimeIdentity(current.directory, current.record, seen)
    ).rejects.toThrow("reused");
    const original = await readFile(
      join(current.directory, "runtime-identity.json")
    );
    await expect(
      createRuntimeIdentity(current.directory, current.parent, {
        attemptId: "other",
        harness: "atlas",
        repetition: 0,
        taskId: "other",
      })
    ).rejects.toThrow();
    expect(
      await readFile(join(current.directory, "runtime-identity.json"))
    ).toEqual(original);
  } finally {
    await current.close();
  }
});

test("mapping hash, tuple and neutral paths remain mandatory even if other metadata is rehashed", async () => {
  const current = await fixture();
  try {
    const path = join(current.directory, "runtime-identity.json");
    const raw = await readFile(path);
    await writeFile(path, `${raw.toString()}\n`);
    await expect(
      verifyRuntimeIdentity(current.directory, current.record, emptySeen())
    ).rejects.toThrow("identity hash");
    for (const mutation of [
      { ...current.identity, attemptId: "wrong-attempt" },
      { ...current.identity, taskId: "wrong-task" },
      {
        ...current.identity,
        nativeStateRoot: "/private/tmp/development-unsupported_fact",
        workspaceRoot: "/private/tmp/development-unsupported_fact/workspace",
      },
    ]) {
      const changed = JSON.stringify(mutation);
      await writeFile(path, changed);
      await expect(
        verifyRuntimeIdentity(
          current.directory,
          { ...current.record, identitySha256: sha256(changed) },
          emptySeen()
        )
      ).rejects.toThrow("identity hash");
    }
  } finally {
    await current.close();
  }
});

test("runner transport substitution and model-visible orchestration identity fail verification", async () => {
  const current = await fixture();
  try {
    await writeFile(
      join(current.directory, "runner-input.json"),
      JSON.stringify({
        ...current.input,
        base_url: "http://127.0.0.1:12345/runs/other/v1",
      })
    );
    await expect(
      verifyRuntimeIdentity(current.directory, current.record, emptySeen())
    ).rejects.toThrow("Hermes runner");
    await writeFile(
      join(current.directory, "runner-input.json"),
      JSON.stringify(current.input)
    );
    await writeFile(
      join(current.directory, "runner-stdout.json"),
      JSON.stringify({ ...current.output, run_id: "other" })
    );
    await expect(
      verifyRuntimeIdentity(current.directory, current.record, emptySeen())
    ).rejects.toThrow("Hermes runner");
    await writeFile(
      join(current.directory, "runner-stdout.json"),
      JSON.stringify(current.output)
    );
    await writeFile(
      join(current.directory, "wire/001-request.json"),
      JSON.stringify({
        effective: {
          messages: [
            {
              content: `Workspace: ${current.identity.attemptId}`,
              role: "system",
            },
          ],
        },
      })
    );
    await expect(
      verifyRuntimeIdentity(current.directory, current.record, emptySeen())
    ).rejects.toThrow("leaked");
  } finally {
    await current.close();
  }
});

test("amended task and oracle sources preserve the original corpus without opening confirmatory fixtures", async () => {
  for (const name of ["tasks.ts", "oracles.ts"]) {
    const current = new URL(name, import.meta.url);
    const original = new URL(
      `../harness-controlled-v2/${name}`,
      import.meta.url
    );
    expect(sha256(await readFile(current))).toBe(
      sha256(await readFile(original))
    );
  }
});

test("development task and complete schedule projections remain identical to the prior revision", () => {
  const tasks = suite("development");
  const original = originalSuite("development");
  expect(sha256(JSON.stringify(tasks))).toBe(sha256(JSON.stringify(original)));
  expect(sha256(JSON.stringify(buildSchedule(tasks, "development")))).toBe(
    sha256(JSON.stringify(originalBuildSchedule(original, "development")))
  );
});

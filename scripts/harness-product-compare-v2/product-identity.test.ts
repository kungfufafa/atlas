import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildFileSchedule as originalFileSchedule } from "../harness-product-compare/file-run";
import { buildMemorySchedule as originalMemorySchedule } from "../harness-product-compare/memory-run";
import { buildFileSchedule, fileControlHashes } from "./file-run";
import { buildMemorySchedule, memoryControlHashes } from "./memory-run";
import {
  validateProductNativePaths,
  validateProductRuntimeIdentity,
} from "./product-analysis";
import {
  createProductRuntimeIdentity,
  finalizeProductRuntimeIdentities,
} from "./product-identity";

const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

test("transport amendment preserves generator, oracle, budget and exact schedule projections", async () => {
  for (const name of [
    "memory-tasks.ts",
    "memory-oracles.ts",
    "memory-types.ts",
    "file-fixtures.py",
    "file-oracles.py",
    "file-code-contract.py",
    "file-code-check.py",
  ]) {
    expect(sha(await readFile(join(import.meta.dir, name)))).toBe(
      sha(
        await readFile(
          join(import.meta.dir, "../harness-product-compare", name)
        )
      )
    );
  }
  for (const split of ["development", "confirmatory"] as const) {
    // Compare opaque digests; never print or expose held-out task contents.
    expect(sha(JSON.stringify(buildMemorySchedule(split)))).toBe(
      sha(JSON.stringify(originalMemorySchedule(split)))
    );
    expect(sha(JSON.stringify(buildFileSchedule(split)))).toBe(
      sha(JSON.stringify(originalFileSchedule(split)))
    );
  }
});

test("private mappings preserve descriptive assignment while runtime identifiers and roots are independent", async () => {
  const evaluator = await mkdtemp("/private/tmp/private-study-family-seed-");
  const nativeParent = await mkdtemp("/private/tmp/agent-runtime-");
  try {
    const events: Record<string, unknown>[] = [];
    const identities = [];
    for (const harness of ["atlas", "hermes"] as const) {
      const attemptId = `synthetic-family-seed-987654-${harness}`;
      const trialDirectory = join(evaluator, "trials", attemptId);
      const options = {
        attemptId,
        harness,
        nativeParent,
        pairId: "synthetic-family-seed-987654-r0",
        repetition: 0,
        taskId: "synthetic-family/987654",
        trialDirectory,
      };
      const { identity, identitySha256 } =
        await createProductRuntimeIdentity(options);
      const event = {
        event: "start",
        harness,
        id: attemptId,
        identitySha256,
        pairId: options.pairId,
        repetition: 0,
        taskId: options.taskId,
        transportId: identity.transportId,
      };
      expect(
        validateProductRuntimeIdentity(identity, event, identitySha256)
      ).toEqual([]);
      expect(identity.transportId).not.toContain("synthetic");
      expect(identity.nativeStateRoot).not.toContain(evaluator);
      expect(identity.nativeStateRoot).not.toContain("987654");
      expect(
        sha(await readFile(join(trialDirectory, "runtime-identity.json")))
      ).toBe(identitySha256);
      await expect(createProductRuntimeIdentity(options)).rejects.toThrow(
        "EEXIST"
      );
      for (const patch of [
        { attemptId: "wrong-attempt" },
        { taskId: "wrong-task" },
        { harness: harness === "atlas" ? "hermes" : "atlas" },
        { nativeStateRoot: join(evaluator, "model-state") },
        { transportId: attemptId },
        { repetition: 1 },
      ]) {
        expect(
          validateProductRuntimeIdentity(
            { ...identity, ...patch },
            event,
            identitySha256
          )
        ).toContain("runtime_identity_mismatch");
      }
      expect(
        validateProductRuntimeIdentity(
          identity,
          { ...event, identitySha256: "0".repeat(64) },
          identitySha256
        )
      ).toContain("runtime_identity_mismatch");
      events.push(event);
      identities.push(identity);
    }
    expect(identities[0]?.transportId).not.toBe(identities[1]?.transportId);
    expect(identities[0]?.nativeStateRoot).not.toBe(
      identities[1]?.nativeStateRoot
    );
    await mkdir(evaluator, { recursive: true });
    await writeFile(
      join(evaluator, "attempts.jsonl"),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n"
    );
    const hash = await finalizeProductRuntimeIdentities(evaluator);
    const bytes = await readFile(join(evaluator, "runtime-identities.json"));
    expect(sha(bytes)).toBe(hash);
    expect(JSON.parse(bytes.toString()).entries).toEqual(
      events.map((event) => ({
        attemptId: event.id,
        identitySha256: event.identitySha256,
      }))
    );
    await expect(finalizeProductRuntimeIdentities(evaluator)).rejects.toThrow(
      "EEXIST"
    );
  } finally {
    await rm(evaluator, { force: true, recursive: true });
    await rm(nativeParent, { force: true, recursive: true });
  }
});

test("both native inventories include the actual identity helper and queue regression source", async () => {
  for (const inventory of await Promise.all([
    memoryControlHashes(),
    fileControlHashes(),
  ])) {
    for (const name of [
      "product-identity.ts",
      "product-identity.test.ts",
      "product-proxy.ts",
      "product-proxy-queue.test.ts",
    ]) {
      expect(inventory[`scripts/harness-product-compare-v2/${name}`]).toBe(
        sha(await readFile(join(import.meta.dir, name)))
      );
    }
  }
});

test("historical output roots bind to the assigned state without accessing the workspace", () => {
  const root = "/private/tmp/agent-runtime-historical/state-one";
  const mapping = { nativeStateRoot: root };
  expect(
    validateProductNativePaths(mapping, {
      sessions: [{ nativeStateRoot: `${root}/state` }],
      status: "completed",
      workspaceRoot: `${root}/profile`,
    })
  ).toEqual([]);
  expect(validateProductNativePaths(mapping, { status: "failed" })).toEqual([]);
  for (const observation of [
    { status: "completed" },
    {
      status: "completed",
      workspaceRoot: "/private/tmp/agent-runtime-historical/state-two/profile",
    },
    { nativeStateRoot: `${root}/state/../../state-two`, status: "failed" },
    { status: "completed", workspaceRoot: `${root}/../state-one/profile` },
    {
      snapshots: [{ nativeStateRoot: "/private/tmp/other" }],
      status: "completed",
      workspaceRoot: `${root}/profile`,
    },
  ]) {
    expect(validateProductNativePaths(mapping, observation)).toContain(
      "runtime_output_state_root_mismatch"
    );
  }
});

import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildFileSchedule, FILE_BUDGET } from "./file-run";
import { buildMemorySchedule } from "./memory-run";
import { MEMORY_BUDGET } from "./memory-types";
import {
  modelMetadata,
  modelProfile,
  verifyModelEvidence,
} from "./product-model";
import parity from "./product-model-parity.json";

const corpusFiles = [
  "memory-tasks.ts",
  "memory-types.ts",
  "memory-oracles.ts",
  "file-fixtures.py",
  "file-oracles.py",
  "file-code-check.py",
  "file-code-contract.py",
  "memory_hermes_runner.py",
  "file_hermes_runner.py",
  "memory-atlas-runner.ts",
  "file-atlas-runner.ts",
  "product-identity.ts",
];
const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

test("MiMo stratum preserves corpus, native adapters, schedules and budgets", async () => {
  for (const name of corpusFiles) {
    expect(digest(await readFile(join(import.meta.dir, name)))).toBe(
      parity.corpusHashes[name as keyof typeof parity.corpusHashes]
    );
  }
  for (const phase of ["development", "confirmatory"] as const) {
    // Only compare schedule digests; no held-out expected answers are read or printed.
    expect(digest(JSON.stringify(buildMemorySchedule(phase)))).toBe(
      parity.schedules[phase].memory
    );
    expect(digest(JSON.stringify(buildFileSchedule(phase)))).toBe(
      parity.schedules[phase].files
    );
  }
  expect(MEMORY_BUDGET).toEqual(parity.memoryBudget);
  expect(FILE_BUDGET).toEqual(parity.fileBudget);
});

test("model metadata binds completed fixed-order probe and leaves capacities unknown", async () => {
  await verifyModelEvidence();
  const metadata = modelMetadata();
  expect(metadata.entry.id).toBe("mimo-v2.5");
  expect(Object.keys(metadata.entry).sort()).toEqual(["capabilities", "id"]);
  expect(metadata.evidence.observedAt).toBe("2026-09-06T16:51:20.500Z");
  expect(modelProfile.userAgent).toBe(
    "Atlas-Hermes-Compatibility-Probe/1.0 (nonstreaming)"
  );
});

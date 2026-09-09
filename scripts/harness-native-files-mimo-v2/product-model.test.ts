import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildFileSchedule, FILE_BUDGET } from "./file-run";
import {
  modelMetadata,
  modelProfile,
  verifyModelEvidence,
} from "./product-model";
import parity from "./product-model-parity.json";

const corpusFiles = [
  "file-fixtures.py",
  "file-oracles.py",
  "file-code-check.py",
  "file-code-contract.py",
  "file_hermes_runner.py",
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
    expect(digest(JSON.stringify(buildFileSchedule(phase)))).toBe(
      parity.schedules[phase].files
    );
  }
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

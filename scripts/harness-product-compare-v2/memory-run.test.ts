import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ComparisonRun } from "../harness-compare/proxy";
import { memoryUsage, runMemoryBatch } from "./memory-run";
import type { ProductUsageEvidence } from "./product-proxy";

function evidence(known: boolean): ProductUsageEvidence {
  return {
    cachedTokens: null,
    finalized: true,
    generatedTokens: known ? 20 : null,
    inFlightRequests: 0,
    mandatoryUsageKnown: known,
    observationError: false,
    observedGeneratedTokens: 20,
    observedPromptTokens: 100,
    promptTokens: known ? 100 : null,
    requests: [],
  };
}

test("live memory pilot requires its frozen manifest before credential access", async () => {
  const root = await mkdtemp("/private/tmp/memory-unfrozen-admission-");
  try {
    await expect(
      runMemoryBatch({
        keyFile: join(root, "nonexistent-key-must-not-be-read"),
        phase: "pilot",
        studyRoot: root,
      })
    ).rejects.toThrow("manifest.json");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("uncertain native accounting never turns an observed lower bound into a known total", () => {
  const measured = {
    budgetExceeded: false,
    cachedTokens: 0,
    generatedTokens: 20,
    missingUsage: false,
    promptTokens: 100,
    providerRequests: 2,
  } as ComparisonRun;
  const unknown = memoryUsage(measured, evidence(false));
  expect(unknown).toMatchObject({
    accountingUncertain: true,
    budgetExceeded: false,
    cachedTokens: null,
    generatedTokens: null,
    missingUsage: true,
    observedGeneratedTokens: 20,
    promptTokens: null,
  });
  const knownWithoutCache = memoryUsage(measured, evidence(true));
  expect(knownWithoutCache).toMatchObject({
    accountingUncertain: false,
    cachedTokens: null,
    generatedTokens: 20,
    missingUsage: false,
    promptTokens: 100,
  });
});

import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { comparisonModel, upstreamEndpoint } from "../harness-compare/proxy";
import { certifyUsage, readUsage, requestEvidence } from "./accounting";

const request = {
  effective: {
    max_tokens: 4096,
    model: comparisonModel,
    stream: false,
    temperature: 0.2,
  },
  model: comparisonModel,
  request: { model: comparisonModel },
  upstreamEndpoint,
};
const response = (
  usage: unknown = { completion_tokens: 20, prompt_tokens: 100 }
) => ({ response: { model: comparisonModel, usage }, status: 200 });

test("missing cache remains unknown without invalidating known mandatory usage", () => {
  const evidence = requestEvidence(1, request, response(), false);
  expect(certifyUsage([evidence], 1, 100)).toMatchObject({
    accountingUncertain: false,
    cachedTokens: null,
    generatedTokens: 20,
    promptTokens: 100,
    withinBudgetCertified: true,
  });
  const cached = requestEvidence(
    1,
    request,
    response({
      completion_tokens: 0,
      prompt_tokens: 0,
      prompt_tokens_details: { cached_tokens: 0 },
    }),
    false
  );
  expect(certifyUsage([cached], 1, 0).cachedTokens).toBe(0);
});

test("transport, HTTP errors and missing mandatory usage are unknown failures, never invented overruns", () => {
  for (const evidence of [
    requestEvidence(1, request, null, true),
    requestEvidence(1, request, { ...response(), status: 503 }, false),
    requestEvidence(1, request, response({ prompt_tokens: 4 }), false),
    requestEvidence(
      1,
      request,
      response({ completion_tokens: 4, prompt_tokens: 2.5 }),
      false
    ),
    requestEvidence(1, request, null, false),
  ]) {
    expect(certifyUsage([evidence], 1, 100)).toMatchObject({
      accountingUncertain: true,
      budgetExceeded: false,
      generatedTokens: null,
      promptTokens: null,
      withinBudgetCertified: false,
    });
  }
  const failed = requestEvidence(
    1,
    request,
    { ...response(), status: 503 },
    false
  );
  const recovered = requestEvidence(2, request, response(), false);
  expect(certifyUsage([failed, recovered], 2, 100)).toMatchObject({
    budgetExceeded: false,
    generatedTokens: null,
    observedGeneratedTokens: 20,
    withinBudgetCertified: false,
  });
});

test("unknown time, missing sequence, model or generation controls prevent certification", () => {
  const known = requestEvidence(1, request, response(), false);
  for (const elapsed of [null, Number.NaN, -1]) {
    expect(certifyUsage([known], 1, elapsed)).toMatchObject({
      budgetExceeded: false,
      withinBudgetCertified: false,
    });
  }
  expect(certifyUsage([], 1, 10).withinBudgetCertified).toBe(false);
  expect(certifyUsage([known, known], 2, 10).withinBudgetCertified).toBe(false);
  expect(
    certifyUsage(
      [
        requestEvidence(
          1,
          { ...request, effective: { ...request.effective, temperature: 1 } },
          response(),
          false
        ),
      ],
      1,
      10
    ).withinBudgetCertified
  ).toBe(false);
  expect(
    certifyUsage(
      [
        requestEvidence(
          1,
          request,
          {
            response: { usage: { completion_tokens: 2, prompt_tokens: 2 } },
            status: 200,
          },
          false
        ),
      ],
      1,
      10
    ).withinBudgetCertified
  ).toBe(false);
  expect(
    certifyUsage(
      [
        requestEvidence(
          1,
          { ...request, effective: { ...request.effective, max_tokens: 99 } },
          response(),
          false
        ),
      ],
      1,
      10
    ).withinBudgetCertified
  ).toBe(false);
  expect(certifyUsage([known], 1, 300_001)).toMatchObject({
    budgetExceeded: true,
    budgetReasons: ["observed_wall_clock_limit"],
  });
  expect(
    certifyUsage(
      [
        requestEvidence(
          1,
          request,
          response({ completion_tokens: 4097, prompt_tokens: 20 }),
          false
        ),
      ],
      1,
      1
    ).budgetReasons
  ).toContain("observed_per_response_limit");
});

test("retained wire distinguishes legacy missing-usage rejection from genuine cap admission", async () => {
  const directory = await mkdtemp("/private/tmp/v2-wire-accounting-");
  await writeFile(join(directory, "001-request.json"), JSON.stringify(request));
  await writeFile(
    join(directory, "001-response.json"),
    JSON.stringify(response({ prompt_tokens: 10 }))
  );
  await writeFile(
    join(directory, "budget-rejections.jsonl"),
    `${JSON.stringify({ elapsed: 10, generatedTokens: 0, missingUsage: true, requests: 1 })}\n`
  );
  expect(await readUsage(directory, 1, 20)).toMatchObject({
    accountingUncertain: true,
    budgetExceeded: false,
    withinBudgetCertified: false,
  });
  await writeFile(
    join(directory, "budget-rejections.jsonl"),
    `${JSON.stringify({ elapsed: 10, generatedTokens: 0, missingUsage: false, requests: 24 })}\n`
  );
  expect((await readUsage(directory, 1, 20)).budgetReasons).toContain(
    "known_budget_admission_exhaustion"
  );
});

test("wire endpoint, requested identity and undeclared reasoning controls cannot silently certify", () => {
  for (const altered of [
    { ...request, upstreamEndpoint: "https://different.invalid/v1" },
    { ...request, model: "alias" },
    { ...request, request: { model: "alias" } },
    ...["reasoning", "reasoning_config", "enable_thinking"].map((field) => ({
      ...request,
      effective: { ...request.effective, [field]: false },
    })),
  ]) {
    expect(
      certifyUsage([requestEvidence(1, altered, response(), false)], 1, 10)
    ).toMatchObject({ budgetExceeded: false, withinBudgetCertified: false });
  }
});

test("extra numbered wire evidence and malformed admission logs prevent certification", async () => {
  const directory = await mkdtemp("/private/tmp/v2-wire-extra-");
  await writeFile(join(directory, "001-request.json"), JSON.stringify(request));
  await writeFile(
    join(directory, "001-response.json"),
    JSON.stringify(response())
  );
  await writeFile(join(directory, "002-request.json"), JSON.stringify(request));
  expect(await readUsage(directory, 1, 10)).toMatchObject({
    budgetExceeded: false,
    sequenceValid: false,
    withinBudgetCertified: false,
  });
  await writeFile(join(directory, "budget-rejections.jsonl"), "{broken");
  expect(await readUsage(directory, 2, 10)).toMatchObject({
    budgetExceeded: false,
    rejectionEvidenceValid: false,
    withinBudgetCertified: false,
  });
});

test("all rejection lines are parsed after known exhaustion without losing the observed cap", async () => {
  const directory = await mkdtemp("/private/tmp/v2-wire-rejection-tail-");
  await writeFile(join(directory, "001-request.json"), JSON.stringify(request));
  await writeFile(
    join(directory, "001-response.json"),
    JSON.stringify(response())
  );
  await writeFile(
    join(directory, "budget-rejections.jsonl"),
    `${JSON.stringify({ elapsed: 10, generatedTokens: 0, requests: 24 })}\n{broken\n`
  );
  expect(await readUsage(directory, 1, 10)).toMatchObject({
    accountingUncertain: true,
    budgetExceeded: true,
    rejectionEvidenceValid: false,
    withinBudgetCertified: false,
  });
});

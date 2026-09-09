import { expect, test } from "bun:test";
import { TASK_FAMILIES } from "../harness-compare/tasks";
import {
  comparisonModel,
  upstreamEndpoint,
} from "../harness-compare-v2-transport/proxy";
import { certifyUsage, requestEvidence } from "./accounting";
import { summarizeV2, type V2EndRecord } from "./analysis";

function fixture(
  outcome: (family: number, harness: "atlas" | "hermes") => boolean
) {
  const tasks = TASK_FAMILIES.map((family) => ({
    category: "synthetic",
    family,
    id: family,
  }));
  const schedule = {
    phase: "confirmatory",
    schedule: tasks.map((task) => ({
      order: ["atlas", "hermes"] as Array<"atlas" | "hermes">,
      repetition: 0,
      taskId: task.id,
    })),
  };
  const usage = certifyUsage(
    [
      requestEvidence(
        1,
        {
          effective: {
            max_tokens: 4096,
            model: comparisonModel,
            stream: false,
            temperature: 0.2,
          },
          model: comparisonModel,
          request: { model: comparisonModel },
          upstreamEndpoint,
        },
        {
          response: {
            model: comparisonModel,
            usage: { completion_tokens: 10, prompt_tokens: 20 },
          },
          status: 200,
        },
        false
      ),
    ],
    1,
    100
  );
  const records: V2EndRecord[] = tasks.flatMap((task, index) =>
    (["atlas", "hermes"] as const).map((harness) => {
      const pass = outcome(index, harness);
      return {
        elapsedMs: 100,
        evaluation: {
          checks: [
            { detail: "synthetic result", id: "final_contract_envelope", pass },
          ],
          falseCompletion: false,
          integrityFailure: false,
          pass,
          score: Number(pass),
        },
        event: "end",
        harness,
        id: `${task.id}-${harness}`,
        repetition: 0,
        status: "completed",
        taskId: task.id,
        transportAdmitted: true,
        usage,
      };
    })
  );
  return { records, schedule, tasks };
}

test("all ties and both-fail floors cannot establish noninferiority", () => {
  for (const outcome of [true, false]) {
    const data = fixture(() => outcome);
    const summary = summarizeV2(data.schedule, data.records, data.tasks, {
      issues: [],
      valid: true,
    });
    expect(summary.decision.classification).toBe("inconclusive");
    expect(summary.familyBootstrap?.degenerate).toBe(true);
    expect(summary.intentionToRun.pairs).toBe(12);
    expect(summary.decision.equivalenceClaim).toBe(false);
  }
});

test("mixed wins are clustered by twelve families and missing attempts stay failed in all denominators", () => {
  const data = fixture((index, harness) => harness === "atlas" || index >= 2);
  const complete = summarizeV2(data.schedule, data.records, data.tasks, {
    issues: [],
    valid: true,
  });
  expect(complete.familyBootstrap?.clusters).toBe(12);
  expect(complete.familyBootstrap?.degenerate).toBe(false);
  expect(complete.intentionToRun.counts.atlasOnly).toBe(2);
  const missing = summarizeV2(
    data.schedule,
    data.records.slice(1),
    data.tasks,
    { issues: [], valid: true }
  );
  expect(missing.intentionToRun.pairs).toBe(12);
  expect(missing.missingExecutions).toHaveLength(1);
  expect(missing.certifiedUsagePairs.pairs).toBe(11);
  expect(missing.decision.classification).toBe("inconclusive");
  expect(missing.perHarness.atlas?.resources.generatedTokens).toMatchObject({
    measuredCount: 11,
    missingCount: 1,
    observedSum: 110,
    total: null,
  });
});

test("unknown accounting cannot pass and duplicate diagnostic arms are never best-selected", () => {
  const data = fixture(() => true);
  data.records[0]!.usage = null;
  const unknown = summarizeV2(data.schedule, data.records, data.tasks, {
    issues: [],
    valid: true,
  });
  expect(unknown.decision.classification).toBe("invalid");
  expect(unknown.accounting.atlas?.uncertifiableAttempts).toBe(1);
  const duplicate = summarizeV2(
    data.schedule,
    [...data.records, data.records[1]!],
    data.tasks,
    { issues: [], valid: true }
  );
  expect(duplicate.certifiedUsagePairs.pairs).toBe(11);
  expect(duplicate.transportAdmittedPairs.pairs).toBe(11);
  expect(duplicate.decision.classification).toBe("invalid");
});

test("an uncertain comparator with a known timeout still vetoes an otherwise eligible superiority claim", () => {
  const data = fixture((index, harness) => harness === "atlas" || index >= 6);
  expect(
    summarizeV2(data.schedule, data.records, data.tasks, {
      issues: [],
      valid: true,
    }).decision.classification
  ).toBe("superior_on_declared_synthetic_suite");
  const comparator = data.records[1]!;
  comparator.usage = certifyUsage(
    [
      {
        ...comparator.usage!.requests[0]!,
        generatedTokens: null,
        reason: "missing_or_invalid_mandatory_usage",
      },
    ],
    1,
    300_001
  );
  comparator.status = "budget_exceeded";
  const summary = summarizeV2(data.schedule, data.records, data.tasks, {
    issues: [],
    valid: true,
  });
  expect(summary.decision.classification).toBe("inconclusive");
  expect(summary.accounting.hermes?.uncertifiableAttempts).toBe(1);
  expect(summary.accounting.hermes?.provenBudgetExceeded).toBe(1);
  expect(
    summary.decision.reasons.some((reason) =>
      reason.includes("Usage was unmeasured")
    )
  ).toBe(true);
});

test("a duplicate cannot compensate a missing scheduled arm in resource totals", () => {
  const data = fixture(() => true);
  const records = [...data.records.slice(1), data.records[2]!];
  const summary = summarizeV2(data.schedule, records, data.tasks, {
    issues: [],
    valid: true,
  });
  expect(summary.perHarness.atlas?.resources.generatedTokens).toMatchObject({
    measuredCount: 12,
    missingCount: 2,
    observedSum: 120,
    total: null,
  });
  expect(summary.decision.classification).toBe("invalid");
});

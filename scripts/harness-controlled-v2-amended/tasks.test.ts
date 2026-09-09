import { expect, test } from "bun:test";
import { evaluateTask } from "../harness-compare/oracles";
import {
  buildTaskSuite,
  createHarnessTask,
  TASK_FAMILIES,
  type TaskFamily,
} from "../harness-compare/tasks";
import type {
  HarnessTask,
  HarnessToolEvent,
  TaskObservation,
  TaskSplit,
} from "../harness-compare/types";
import {
  buildControlledV2Plan,
  buildControlledV2TaskSuite,
  CONTROLLED_V2_VERSION,
  frozenV1SeedIds,
  verifyFrozenV1Dependencies,
} from "./tasks";

function referenceObservation(task: HarnessTask): TaskObservation {
  const files = { ...task.initialFiles };
  for (const artifact of task.expected.artifacts) {
    files[artifact.path] =
      artifact.format === "json"
        ? JSON.stringify(artifact.value)
        : artifact.value;
  }
  const events: HarnessToolEvent[] = (
    task.expected.requiredFailedReads ?? []
  ).map((path) => ({
    arguments: { path },
    isError: true,
    name: "read_file",
    result: { error: "FILE_NOT_FOUND" },
  }));
  for (const path of task.expected.requiredReadPaths ?? []) {
    events.push({
      arguments: { path },
      name: "read_file",
      result: { content: files[path], path },
    });
  }
  for (const id of task.expected.requiredDocumentIds ?? []) {
    events.push({
      arguments: { id },
      name: "fetch_document",
      result: task.documents?.[id],
    });
  }
  for (const artifact of task.expected.artifacts) {
    const content = files[artifact.path]!;
    events.push({
      arguments: { content, path: artifact.path },
      name: "write_file",
      result: {
        bytes: new TextEncoder().encode(content).byteLength,
        path: artifact.path,
      },
    });
  }
  return {
    events,
    files,
    finalText: JSON.stringify(task.expected.finalFacts),
    terminalStatus: "completed",
  };
}

function developmentTask(family: TaskFamily): HarnessTask {
  const task = buildControlledV2TaskSuite("development").find(
    (entry) => entry.family === family
  );
  if (!task) {
    throw new Error(`Missing development family: ${family}`);
  }
  return task;
}

test("fixed V2 plans retain every family and pair count with disjoint deterministic seed identities", () => {
  const development = buildControlledV2Plan("development");
  const confirmation = buildControlledV2Plan("holdout");
  expect(development).toHaveLength(36);
  expect(confirmation).toHaveLength(60);
  expect(development.reduce((sum, entry) => sum + entry.repetitions, 0)).toBe(
    36
  );
  expect(confirmation.reduce((sum, entry) => sum + entry.repetitions, 0)).toBe(
    120
  );
  expect(buildControlledV2Plan("development")).toEqual(development);
  expect(buildControlledV2Plan("holdout")).toEqual(confirmation);
  const both = [...development, ...confirmation];
  expect(new Set(both.map((entry) => entry.seed)).size).toBe(96);
  expect(new Set(both.map((entry) => entry.id)).size).toBe(96);
  const original = frozenV1SeedIds();
  expect(original.size).toBe(96);
  expect(both.some((entry) => original.has(entry.seed))).toBe(false);
  // V1 development is public audit material. V1 holdout contents are never
  // constructed or read here; only their published seed formula is used.
  expect(
    buildTaskSuite("development").every((entry) => original.has(entry.seed))
  ).toBe(true);
  for (const family of TASK_FAMILIES) {
    expect(development.filter((entry) => entry.family === family)).toHaveLength(
      3
    );
    expect(
      confirmation.filter((entry) => entry.family === family)
    ).toHaveLength(5);
  }
  expect(() => buildControlledV2Plan("unknown" as TaskSplit)).toThrow();
});

test("V2 reuses frozen calculations and evidence requirements unchanged for every development instance", () => {
  expect(() => verifyFrozenV1Dependencies()).not.toThrow();
  const tasks = buildControlledV2TaskSuite("development");
  const plans = buildControlledV2Plan("development");
  expect(tasks).toHaveLength(plans.length);
  for (const [index, task] of tasks.entries()) {
    const plan = plans[index]!;
    const original = createHarnessTask(plan.family, plan.seed, plan.split);
    expect(task.id).toBe(plan.id);
    expect(task.id.startsWith(`${CONTROLLED_V2_VERSION}:`)).toBe(true);
    expect(task.prompt).toBe(task.turns[0]);
    expect(task.turns).toHaveLength(original.turns.length);
    expect(task.turns).not.toEqual(original.turns);
    expect({
      ...task,
      id: original.id,
      prompt: original.prompt,
      turns: original.turns,
    }).toEqual(original);
    expect(evaluateTask(task, referenceObservation(task)).pass).toBe(true);
  }
  expect(new Set(tasks.map((task) => task.category)).size).toBe(6);
});

test("entire-artifact final facts still pass without relaxing file schemas or strict final fields", () => {
  for (const family of [
    "missing_evidence",
    "invalid_path_recovery",
    "linked_workflow",
    "explicit_correction",
    "portable_memory_application",
    "source_latest_policy",
    "source_grounded_comparison",
  ] as const) {
    const task = developmentTask(family);
    const observation = referenceObservation(task);
    expect(evaluateTask(task, observation).pass).toBe(true);
    const originalFinal = task.expected.finalFacts;
    observation.finalText = JSON.stringify({
      ...originalFinal,
      extra: "unrequested",
    });
    expect(evaluateTask(task, observation).pass).toBe(false);
    observation.finalText = JSON.stringify(originalFinal);
    const artifact = task.expected.artifacts[0]!;
    observation.files[artifact.path] = JSON.stringify({
      ...JSON.parse(observation.files[artifact.path]!),
      extra: "unrequested",
    });
    expect(evaluateTask(task, observation).pass).toBe(false);
  }
});

test("linked workflow counts actual visited steps and still rejects a list in place of the required count", () => {
  const task = developmentTask("linked_workflow");
  const workflow = JSON.parse(task.initialFiles["input/workflow.json"]!) as {
    first: string;
  };
  const visited: string[] = [];
  let path: string | null = workflow.first;
  while (path !== null) {
    expect(visited).not.toContain(path);
    visited.push(path);
    path = (JSON.parse(task.initialFiles[path]!) as { next: string | null })
      .next;
  }
  expect(task.expected.finalFacts.processedSteps).toBe(visited.length);
  const observation = referenceObservation(task);
  observation.finalText = JSON.stringify({
    ...task.expected.finalFacts,
    processedSteps: visited,
  });
  expect(evaluateTask(task, observation).pass).toBe(false);
});

test("required reads, recovery order, prohibited writes and terminal failure remain strict", () => {
  for (const task of buildControlledV2TaskSuite("development")) {
    const observation = referenceObservation(task);
    observation.events = [];
    expect(evaluateTask(task, observation).pass).toBe(false);
    const failed = referenceObservation(task);
    failed.terminalStatus = "budget_exceeded";
    expect(evaluateTask(task, failed).pass).toBe(false);
  }
  const missing = developmentTask("missing_evidence");
  const fabricated = referenceObservation(missing);
  fabricated.files["output/payroll.json"] = "[]";
  expect(evaluateTask(missing, fabricated)).toMatchObject({
    integrityFailure: true,
    pass: false,
  });
  const recovery = developmentTask("invalid_path_recovery");
  const repeated = referenceObservation(recovery);
  repeated.events!.push(structuredClone(repeated.events![0]!));
  expect(evaluateTask(recovery, repeated).pass).toBe(false);
});

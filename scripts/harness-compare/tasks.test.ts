import { expect, test } from "bun:test";
import {
  evaluateTask,
  jsonSemanticallyEqual,
  normalizeTaskPath,
} from "./oracles";
import { buildTaskSuite, createHarnessTask, TASK_FAMILIES } from "./tasks";
import type { HarnessTask, HarnessToolEvent, TaskObservation } from "./types";

function correctObservation(task: HarnessTask): TaskObservation {
  const files = { ...task.initialFiles };
  for (const artifact of task.expected.artifacts) {
    files[artifact.path] =
      artifact.format === "json"
        ? JSON.stringify(artifact.value)
        : artifact.value;
  }
  const events: HarnessToolEvent[] = (
    task.expected.requiredReadPaths ?? []
  ).map((path) => ({
    arguments: { path },
    name: "read_file",
    result: { content: files[path], path },
  }));
  for (const path of task.expected.requiredFailedReads ?? []) {
    events.unshift({
      arguments: { path },
      isError: true,
      name: "read_file",
      result: { error: "FILE_NOT_FOUND" },
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

test("the fixed development and confirmatory suites have disjoint reproducible instances", () => {
  const development = buildTaskSuite("development");
  const holdout = buildTaskSuite("holdout");
  expect(development).toHaveLength(36);
  expect(holdout).toHaveLength(60);
  expect(buildTaskSuite("development")).toEqual(development);
  expect(
    new Set([...development, ...holdout].map((task) => task.seed)).size
  ).toBe(96);
  for (const family of TASK_FAMILIES) {
    expect(development.filter((task) => task.family === family)).toHaveLength(
      3
    );
    expect(holdout.filter((task) => task.family === family)).toHaveLength(5);
  }
});

test("every family accepts the complete independently generated correct result", () => {
  for (const task of buildTaskSuite("development")) {
    expect(evaluateTask(task, correctObservation(task)).pass).toBe(true);
    expect(task.prompt).toBe(task.turns[0]);
  }
});

test("oracles reject absent artifacts and detect structured false completion", () => {
  for (const task of buildTaskSuite("development", 1)) {
    const observation = correctObservation(task);
    const output = task.expected.artifacts[0]!;
    delete observation.files[output.path];
    const result = evaluateTask(task, observation);
    expect(result.pass).toBe(false);
    expect(result.falseCompletion).toBe(
      task.expected.finalFacts.status === "completed"
    );
  }
});

test("correct final text cannot substitute for reading the task evidence", () => {
  for (const task of buildTaskSuite("development", 1)) {
    const observation = correctObservation(task);
    observation.events = [];
    expect(evaluateTask(task, observation).pass).toBe(false);
  }
});

test("source mutation, unrequested files and fabricated payroll are integrity failures", () => {
  const task = createHarnessTask("missing_evidence", 81, "development");
  const observation = correctObservation(task);
  observation.files["input/hours.json"] = "[]";
  observation.files["output/payroll.json"] = "[]";
  const result = evaluateTask(task, observation);
  expect(result.pass).toBe(false);
  expect(result.integrityFailure).toBe(true);
});

test("final facts and output contents are independently required, while formatting is flexible", () => {
  const task = createHarnessTask("inventory_allocation", 45, "development");
  const observation = correctObservation(task);
  observation.finalText = `\`\`\`json\n${JSON.stringify(task.expected.finalFacts, null, 2)}\n\`\`\``;
  expect(evaluateTask(task, observation).pass).toBe(true);
  observation.finalText = JSON.stringify({
    ...task.expected.finalFacts,
    totalAllocated: -1,
  });
  expect(evaluateTask(task, observation).falseCompletion).toBe(true);
  expect(evaluateTask(task, observation).pass).toBe(false);
  expect(
    jsonSemanticallyEqual({ a: 1, b: false }, JSON.parse('{"b":false,"a":1}'))
  ).toBe(true);
  expect(jsonSemanticallyEqual({ id: "0007" }, { id: 7 })).toBe(false);
});

test("timed-out runs cannot pass even when an artifact was produced before timeout", () => {
  const task = createHarnessTask("configuration_migration", 8, "development");
  const observation = correctObservation(task);
  observation.terminalStatus = "budget_exceeded";
  expect(evaluateTask(task, observation).pass).toBe(false);
});

test("grounding requires the actual fetched content, not a fabricated receipt", () => {
  const task = createHarnessTask("source_latest_policy", 8, "development");
  const observation = correctObservation(task);
  observation.events = observation.events?.map((event) => ({
    ...event,
    result: { content: "invented", url: "https://wrong.example.test" },
  }));
  expect(evaluateTask(task, observation).pass).toBe(false);
});

test("correction and continuation families carry real follow-up turns", () => {
  const correction = createHarnessTask(
    "explicit_correction",
    71,
    "development"
  );
  const continuation = createHarnessTask("linked_workflow", 71, "development");
  expect(correction.turns).toHaveLength(3);
  expect(continuation.turns).toHaveLength(2);
  const oldDraft = JSON.parse(
    correction.initialFiles["input/order-draft.json"]!
  );
  expect(oldDraft.quantity).not.toBe(correction.expected.finalFacts.quantity);
  expect(oldDraft.deliveryDate).not.toBe(
    correction.expected.finalFacts.deliveryDate
  );
});

test("invalid instance parameters fail without silently selecting defaults", () => {
  expect(() =>
    createHarnessTask("missing_evidence", -1, "development")
  ).toThrow();
  expect(() => buildTaskSuite("holdout", 0)).toThrow();
});

test("recovery cannot be fabricated after a successful fallback or repeated indefinitely", () => {
  const task = createHarnessTask("invalid_path_recovery", 22, "development");
  const observation = correctObservation(task);
  const failed = observation.events?.shift();
  expect(failed?.isError).toBe(true);
  observation.events?.push(failed!);
  expect(evaluateTask(task, observation).pass).toBe(false);
  observation.events?.unshift(failed!);
  expect(evaluateTask(task, observation).pass).toBe(false);
});

test("a terminal outcome, genuine source bytes and a matching write receipt are mandatory", () => {
  const task = createHarnessTask("configuration_migration", 22, "development");
  const missingTerminal = correctObservation(task);
  delete missingTerminal.terminalStatus;
  expect(evaluateTask(task, missingTerminal).pass).toBe(false);
  const forgedSource = correctObservation(task);
  forgedSource.events![0]!.result = {
    content: "{}",
    path: "input/config-v1.json",
  };
  expect(evaluateTask(task, forgedSource).pass).toBe(false);
  const missingWrite = correctObservation(task);
  missingWrite.events = missingWrite.events?.filter(
    (event) => event.name !== "write_file"
  );
  expect(evaluateTask(task, missingWrite).pass).toBe(false);
});

test("equivalent safe relative read/write paths pass without rewriting raw receipts", () => {
  for (const family of [
    "configuration_migration",
    "invalid_path_recovery",
  ] as const) {
    const task = createHarnessTask(family, 22, "development");
    const observation = correctObservation(task);
    for (const event of observation.events ?? []) {
      if (typeof event.arguments.path === "string") {
        const rawPath = `./temporary/../${event.arguments.path}`;
        event.arguments.path = rawPath;
        if (
          event.result !== null &&
          typeof event.result === "object" &&
          "path" in event.result
        ) {
          event.result.path = rawPath;
        }
      }
    }
    const beforeEvaluation = JSON.stringify(observation.events);
    expect(evaluateTask(task, observation).pass).toBe(true);
    expect(JSON.stringify(observation.events)).toBe(beforeEvaluation);
  }
  expect(normalizeTaskPath("input/x/../foo")).toBe("input/foo");
  expect(normalizeTaskPath("./input//foo/")).toBe("input/foo");
});

test("absolute, escaping and null-byte receipt paths never alias safe task files", () => {
  for (const path of [
    "/input/config-v1.json",
    "../input/config-v1.json",
    "input/../../config-v1.json",
    "C:\\input\\config-v1.json",
    "input/config-v1.json\0",
  ]) {
    expect(normalizeTaskPath(path)).toBeNull();
    const task = createHarnessTask(
      "configuration_migration",
      22,
      "development"
    );
    const observation = correctObservation(task);
    observation.events![0]!.arguments.path = path;
    expect(evaluateTask(task, observation).pass).toBe(false);
  }
});

test("extra final fields and missing facts fail the contract without asserting false completion", () => {
  const task = createHarnessTask("configuration_migration", 22, "development");
  const extraField = correctObservation(task);
  extraField.finalText = JSON.stringify({
    ...task.expected.finalFacts,
    note: "Finished.",
  });
  const extraResult = evaluateTask(task, extraField);
  expect(extraResult.pass).toBe(false);
  expect(extraResult.falseCompletion).toBe(false);
  expect(
    extraResult.checks.find((item) => item.id === "final_facts_correct")?.pass
  ).toBe(true);
  const missingField = correctObservation(task);
  missingField.finalText = JSON.stringify({ status: "completed" });
  expect(evaluateTask(task, missingField).pass).toBe(false);
  expect(evaluateTask(task, missingField).falseCompletion).toBe(false);
  const unknownEvidence = correctObservation(task);
  unknownEvidence.events = [];
  expect(evaluateTask(task, unknownEvidence).pass).toBe(false);
  expect(evaluateTask(task, unknownEvidence).falseCompletion).toBe(false);
});

test("unsorted factual lists fail the ordering contract without becoming false factual claims", () => {
  const task = createHarnessTask(
    "source_grounded_comparison",
    22,
    "development"
  );
  const observation = correctObservation(task);
  const sourceUrls = task.expected.finalFacts.sourceUrls as string[];
  observation.finalText = JSON.stringify({
    ...task.expected.finalFacts,
    sourceUrls: [...sourceUrls].reverse(),
  });
  expect(evaluateTask(task, observation).pass).toBe(false);
  expect(evaluateTask(task, observation).falseCompletion).toBe(false);
});

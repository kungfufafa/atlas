import { expect, test } from "bun:test";
import { evaluateMemoryTask, unknownMemoryExpectation } from "./memory-oracles";
import {
  createMemoryTask,
  MEMORY_FAMILIES,
  MEMORY_SEEDS,
  memoryTaskInput,
  memoryTaskSet,
} from "./memory-tasks";
import type {
  MemoryRunResult,
  MemorySessionResult,
  MemoryTask,
} from "./memory-types";

const distractorFactPattern = /depot (Cedar-\d+) has (\d+) crates/g;

function completed(
  task: MemoryTask
): Pick<MemoryRunResult, "finalText" | "sessions" | "status"> {
  const sessions: MemorySessionResult[] = (["training", "recall"] as const).map(
    (phase) => ({
      id: `${phase}-unique-id`,
      initialHistoryCount: 0,
      nativeStateRoot: "/private/tmp/oracle-fixture",
      phase,
      turns: (phase === "training" ? task.trainingTurns : task.recallTurns).map(
        (input, index) => ({
          elapsedMs: 1,
          finalText: "ack",
          index,
          input,
          status: "completed",
        })
      ),
    })
  );
  return {
    finalText: JSON.stringify(task.expected),
    sessions,
    status: "completed",
  };
}

test("fixed development and confirmatory corpora have eight families with disjoint stable instances", () => {
  for (const condition of ["native-default", "explicit-memory"] as const) {
    const development = memoryTaskSet("development", condition);
    const confirmatory = memoryTaskSet("confirmatory", condition);
    expect(development).toHaveLength(16);
    expect(confirmatory).toHaveLength(24);
    expect(
      new Set([...development, ...confirmatory].map((task) => task.id)).size
    ).toBe(40);
    expect(memoryTaskSet("development", condition)).toEqual(development);
    for (const family of MEMORY_FAMILIES) {
      expect(development.filter((task) => task.family === family)).toHaveLength(
        2
      );
      expect(
        confirmatory.filter((task) => task.family === family)
      ).toHaveLength(3);
    }
  }
  expect(
    MEMORY_SEEDS.development.some((seed) =>
      MEMORY_SEEDS.confirmatory.includes(seed)
    )
  ).toBe(false);
});

test("separate condition changes acquisition requests without leaking expected recall values into B", () => {
  for (const family of MEMORY_FAMILIES) {
    const natural = createMemoryTask(
      family,
      1907,
      "development",
      "native-default"
    );
    const explicit = createMemoryTask(
      family,
      1907,
      "development",
      "explicit-memory"
    );
    expect(natural.expected).toEqual(explicit.expected);
    expect(natural.recallTurns).toEqual(explicit.recallTurns);
    expect(natural.trainingTurns).not.toEqual(explicit.trainingTurns);
    expect(Object.keys(memoryTaskInput(natural)).sort()).toEqual([
      "condition",
      "recallTurns",
      "trainingTurns",
    ]);
    for (const [key, value] of Object.entries(natural.expected)) {
      if (value !== null && key !== "chosen_mode") {
        expect(natural.recallTurns.join(" ").includes(String(value))).toBe(
          false
        );
      }
    }
  }
});

test("oracles accept facts across all instances and reject independently wrong numeric/date values", () => {
  for (const task of memoryTaskSet("development", "native-default")) {
    const result = completed(task);
    expect(evaluateMemoryTask(task, result).success).toBe(true);
    const key = Object.keys(task.expected)[0];
    if (!key) {
      throw new Error("Task missing required facts.");
    }
    result.finalText = JSON.stringify({
      ...task.expected,
      [key]: task.expected[key] === null ? "invented" : null,
    });
    const wrong = evaluateMemoryTask(task, result);
    expect(wrong.success).toBe(false);
    expect(wrong.falseCompletion).toBe(true);
  }
});

test("strict final contract failure is distinct from factual false completion", () => {
  const task = createMemoryTask(
    "durable_fact",
    1907,
    "development",
    "native-default"
  );
  const result = completed(task);
  result.finalText = JSON.stringify({
    ...task.expected,
    note: "A harmless extra note",
  });
  expect(evaluateMemoryTask(task, result)).toMatchObject({
    falseCompletion: false,
    finalContract: false,
    finalFactsCorrect: true,
    strictSuccess: false,
    success: true,
  });
  result.finalText = "not JSON";
  expect(evaluateMemoryTask(task, result)).toMatchObject({
    falseCompletion: false,
    finalFactsCorrect: false,
    success: false,
  });
  result.finalText = "{}";
  expect(evaluateMemoryTask(task, result)).toMatchObject({
    falseCompletion: false,
    success: false,
  });
});

test("primary recall accepts one unambiguous JSON object in prose but never cherry-picks among objects", () => {
  const task = createMemoryTask(
    "durable_fact",
    1907,
    "development",
    "native-default"
  );
  const result = completed(task);
  result.finalText = `Here is the recalled information:\n${JSON.stringify(task.expected)}\nThose are the recorded facts.`;
  expect(evaluateMemoryTask(task, result)).toMatchObject({
    strictSuccess: false,
    success: true,
  });
  result.finalText = `${JSON.stringify({ ...task.expected, crates: -99 })}\n${JSON.stringify(task.expected)}`;
  expect(evaluateMemoryTask(task, result)).toMatchObject({
    ambiguousFinal: true,
    success: false,
  });
  result.finalText = `{"crates":-99,"crates":${task.expected.crates},"inspection_date":${JSON.stringify(task.expected.inspection_date)}}`;
  expect(evaluateMemoryTask(task, result)).toMatchObject({
    ambiguousFinal: true,
    success: false,
  });
});

test("matching facts cannot hide injected history, missing training, reused session, or failed invocation", () => {
  const task = createMemoryTask(
    "corrected_fact",
    2953,
    "development",
    "native-default"
  );
  const result = completed(task);
  const first = result.sessions[0];
  const second = result.sessions[1];
  if (!(first && second)) {
    throw new Error("Missing test sessions.");
  }
  second.initialHistoryCount = 1;
  expect(evaluateMemoryTask(task, result).success).toBe(false);
  second.initialHistoryCount = 0;
  second.id = first.id;
  expect(evaluateMemoryTask(task, result).success).toBe(false);
  second.id = "new-recall";
  first.turns.pop();
  expect(evaluateMemoryTask(task, result).success).toBe(false);
  const failed = completed(task);
  failed.status = "failed";
  expect(evaluateMemoryTask(task, failed).success).toBe(false);
});

test("cold controls use an explicit all-unknown oracle and remain a separate score", () => {
  const task = createMemoryTask(
    "unsupported_fact",
    1907,
    "development",
    "native-default"
  );
  const result = completed(task);
  result.finalText = JSON.stringify(unknownMemoryExpectation(task));
  expect(evaluateMemoryTask(task, result).success).toBe(false);
  expect(
    evaluateMemoryTask(task, result, unknownMemoryExpectation(task)).success
  ).toBe(true);
});

test("distractors preserve ten distinct facts in two equal batches across both conditions", () => {
  for (const split of ["development", "confirmatory"] as const) {
    for (const seed of MEMORY_SEEDS[split]) {
      const natural = createMemoryTask(
        "distractor_recall",
        seed,
        split,
        "native-default"
      );
      const explicit = createMemoryTask(
        "distractor_recall",
        seed,
        split,
        "explicit-memory"
      );
      const facts = (task: MemoryTask) =>
        task.trainingTurns.slice(1).map((turn) =>
          Array.from(turn.matchAll(distractorFactPattern), (match) => ({
            crates: Number(match[2]),
            depot: match[1],
          }))
        );
      for (const task of [natural, explicit]) {
        expect(task.trainingTurns).toHaveLength(3);
        expect(task.recallTurns).toHaveLength(1);
        const batches = facts(task);
        expect(batches.map((batch) => batch.length)).toEqual([5, 5]);
        expect(new Set(batches.flat().map((fact) => fact.depot)).size).toBe(10);
      }
      expect(facts(natural)).toEqual(facts(explicit));
      expect(natural.expected).toEqual(explicit.expected);
      expect(natural.recallTurns).toEqual(explicit.recallTurns);
    }
  }
});

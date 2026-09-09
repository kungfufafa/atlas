import { expect, test } from "bun:test";
import { evaluateTask } from "../harness-compare/oracles";
import { evaluateV2Task, finalEnvelope } from "./oracles";
import { pilotTask } from "./provenance";

test("V2 enforces the whole final envelope without changing the frozen oracle", () => {
  const task = pilotTask();
  const bytes = '{"status":"READY"}';
  const observation = {
    events: [
      {
        arguments: { path: "input.txt" },
        name: "read_file",
        result: { content: "READY\n", path: "input.txt" },
      },
      {
        arguments: { content: bytes, path: "artifacts/pilot.json" },
        name: "write_file",
        result: { bytes: bytes.length, path: "artifacts/pilot.json" },
      },
    ],
    files: { ...task.initialFiles, "artifacts/pilot.json": bytes },
    finalText: bytes,
    terminalStatus: "completed" as const,
  };
  for (const finalText of [
    bytes,
    ` \n${bytes}\n`,
    `\`\`\`json\n${bytes}\n\`\`\``,
  ]) {
    expect(evaluateV2Task(task, { ...observation, finalText }).pass).toBe(true);
  }
  for (const finalText of [
    `${bytes}\nDone.`,
    `Here is the result:\n${bytes}`,
    `\`\`\`json\n${bytes}\n\`\`\`\nDone.`,
  ]) {
    expect(evaluateTask(task, { ...observation, finalText }).pass).toBe(true);
    const result = evaluateV2Task(task, { ...observation, finalText });
    expect(result.pass).toBe(false);
    expect(
      result.checks.filter((check) => !check.pass).map((check) => check.id)
    ).toEqual(["final_contract_envelope"]);
    expect(result.falseCompletion).toBe(false);
  }
  for (const invalid of [
    "[]",
    "null",
    '"text"',
    `${bytes}\n${bytes}`,
    "```json\n{}\n```\n```json\n{}\n```",
    "",
  ]) {
    expect(finalEnvelope(invalid)).toBe(false);
  }
});

import { expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "../harness-compare/provenance";
import {
  bindSelectedArtifact,
  buildFileSchedule,
  FILE_FAMILIES,
  filePython,
  prepareFilePair,
  runFileBatch,
  selectFileDelivery,
} from "./file-run";

const workspaceRoot = "/private/tmp/synthetic-delivery/workspace";
const observation = (finalText: string, paths: string[] = []) => ({
  artifacts: paths.map((path) => ({ native: { path } })),
  finalText,
  workspaceRoot,
});

test("complete schedules give equal family weights and reverse each confirmatory pair order", () => {
  const development = buildFileSchedule("development");
  const confirmatory = buildFileSchedule("confirmatory");
  expect(development).toHaveLength(18);
  expect(confirmatory).toHaveLength(54);
  expect(new Set(confirmatory.map((pair) => pair.pairId)).size).toBe(54);
  expect(buildFileSchedule("confirmatory")).toEqual(confirmatory);
  for (const family of FILE_FAMILIES) {
    const dev = development.filter((pair) => pair.family === family);
    const confirm = confirmatory.filter((pair) => pair.family === family);
    expect(dev).toHaveLength(2);
    expect(new Set(dev.map((pair) => pair.order[0])).size).toBe(2);
    expect(confirm).toHaveLength(6);
    for (let variant = 0; variant < 3; variant += 1) {
      const first = confirm.find(
        (pair) => pair.variant === variant && pair.repetition === 0
      );
      const second = confirm.find(
        (pair) => pair.variant === variant && pair.repetition === 1
      );
      expect(second?.order[0]).toBe(first?.order[1]);
      expect(second?.order[1]).toBe(first?.order[0]);
    }
  }
  expect(confirmatory.filter((pair) => pair.order[0] === "atlas")).toHaveLength(
    27
  );
});

test("delivery normalization accepts one equivalent path without consulting file contents", () => {
  const selected = selectFileDelivery(
    observation(
      `[Result](./artifacts/sub/../report.xlsx) and \`artifacts/report.xlsx\`. Absolute copy: ${workspaceRoot}/artifacts/report.xlsx`
    ),
    "xlsx"
  );
  expect(selected.path).toBe("artifacts/report.xlsx");
  expect(selected.candidates).toEqual(["artifacts/report.xlsx"]);
  expect(
    selectFileDelivery(
      observation("[Result](<artifacts/my report.xlsx>)"),
      "xlsx"
    ).path
  ).toBe("artifacts/my report.xlsx");
  expect(
    selectFileDelivery(
      observation(`[Result](file://${workspaceRoot}/artifacts/report.xlsx)`),
      "xlsx"
    ).path
  ).toBe("artifacts/report.xlsx");
});

test("missing, contradictory and escaping final delivery cannot choose a passing artifact", () => {
  for (const finalText of [
    "I made the file.",
    "[A](artifacts/a.xlsx) [B](artifacts/b.xlsx)",
    "[Outside](artifacts/../../escape.xlsx)",
    "[Remote](https://example.com/artifacts/a.xlsx)",
    "[Good](artifacts/a.xlsx) [Outside](../artifacts/escape.xlsx)",
  ]) {
    expect(selectFileDelivery(observation(finalText), "xlsx").path).toBeNull();
  }
  const wrong = selectFileDelivery(
    observation("[Wrong](artifacts/wrong.xlsx)", ["artifacts/correct.xlsx"]),
    "xlsx"
  );
  expect(wrong.path).toBe("artifacts/wrong.xlsx");
  expect(wrong.evidence).toBe("final-text");
  expect(
    selectFileDelivery(
      observation("Done", ["artifacts/a.xlsx", "artifacts/b.xlsx"]),
      "xlsx"
    ).path
  ).toBeNull();
  expect(
    selectFileDelivery(
      observation("Done", ["./artifacts/a.xlsx", "artifacts/a.xlsx"]),
      "xlsx"
    ).path
  ).toBe("artifacts/a.xlsx");
  expect(
    selectFileDelivery(observation("Changed source"), "code_fix").path
  ).toBe("app/money.py");
});

test("artifact binding rejects stale hashes, read-only evidence, duplicate snapshots and symlinks", async () => {
  const root = await mkdtemp("/private/tmp/file-delivery-binding-");
  await mkdir(join(root, "artifacts"));
  await writeFile(join(root, "artifacts/result.csv"), "id,cents\n0007,1234\n");
  const hash = sha256(await readFile(join(root, "artifacts/result.csv")));
  const result = {
    finalText: "[Result](artifacts/result.csv)",
    framework: "atlas" as const,
    nativeEvents: [{ name: "python_execute", result: { exitCode: 0 } }],
    sessions: [],
    status: "completed",
    workspaceFiles: [{ path: "artifacts/result.csv", sha256: hash }],
    workspaceRoot: root,
  };
  const selected = selectFileDelivery(result, "csv_join");
  expect((await bindSelectedArtifact(result, selected)).pass).toBe(true);
  expect(
    (
      await bindSelectedArtifact(
        {
          ...result,
          nativeEvents: [
            {
              name: "terminal",
              result: JSON.stringify({ exit_code: 0, output: "Done" }),
            },
          ],
        },
        selected
      )
    ).pass
  ).toBe(true);
  expect(
    (
      await bindSelectedArtifact(
        { ...result, nativeEvents: [{ name: "read_file", result: {} }] },
        selected
      )
    ).pass
  ).toBe(false);
  expect(
    (
      await bindSelectedArtifact(
        {
          ...result,
          nativeEvents: [{ name: "python_execute", result: { exitCode: 1 } }],
        },
        selected
      )
    ).pass
  ).toBe(false);
  expect(
    (
      await bindSelectedArtifact(
        {
          ...result,
          workspaceFiles: [...result.workspaceFiles, ...result.workspaceFiles],
        },
        selected
      )
    ).pass
  ).toBe(false);
  await writeFile(join(root, "artifacts/result.csv"), "changed");
  expect((await bindSelectedArtifact(result, selected)).pass).toBe(false);
  await symlink(
    join(root, "artifacts/result.csv"),
    join(root, "artifacts/alias.csv")
  );
  expect(
    (
      await bindSelectedArtifact(result, {
        ...selected,
        path: "artifacts/alias.csv",
      })
    ).pass
  ).toBe(false);
});

test("actual binary preparation keeps exact seeds, immutable source bytes and private expectations outside model inputs", async () => {
  const root = await mkdtemp("/private/tmp/file-pair-preparation-");
  const prepared = await prepareFilePair(join(root, "pair"), {
    family: "xlsx_reconciliation",
    order: ["atlas", "hermes"],
    pairId: "offline-preparation",
    repetition: 0,
    split: "development",
    variant: 999,
  });
  expect(prepared.taskTurns[0]).toContain(filePython);
  expect(prepared.manifestPath.startsWith(`${prepared.originals}/`)).toBe(
    false
  );
  expect(prepared.seed).toBe(
    BigInt(`0x${sha256(prepared.taskId).slice(0, 16)}`).toString()
  );
  expect(prepared.manifestSha256).toBe(
    sha256(await readFile(prepared.manifestPath))
  );
  expect(Object.keys(prepared.sourceHashes).length).toBeGreaterThan(0);
  for (const [path, hash] of Object.entries(prepared.sourceHashes)) {
    expect(path.startsWith("input/")).toBe(true);
    expect(sha256(await readFile(join(prepared.originals, path)))).toBe(hash);
    expect(
      (await stat(join(prepared.originals, path))).mode.toString(8).slice(-3)
    ).toBe("444");
  }
  expect((await stat(prepared.manifestPath)).mode.toString(8).slice(-3)).toBe(
    "444"
  );
  // Fixtures are evidence retained in /private/tmp; no native runner or inference.
  await chmod(root, 0o700);
});

test("live pilot fails admission before key access when no frozen manifest exists", async () => {
  const studyRoot = await mkdtemp("/private/tmp/file-unfrozen-live-pilot-");
  let error = "";
  try {
    await runFileBatch({
      keyFile: "/private/tmp/never-access-this-provider-key",
      phase: "pilot",
      studyRoot,
    });
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
  }
  expect(error).toContain("frozen/manifest.json");
  expect(error).not.toContain("never-access-this-provider-key");
});

test("code fixtures disclose the exact independent grader contract without hidden expected cases", async () => {
  const root = await mkdtemp("/private/tmp/file-code-contract-fixture-");
  const prepared = await prepareFilePair(join(root, "pair"), {
    family: "code_fix",
    order: ["atlas", "hermes"],
    pairId: "offline-code-contract",
    repetition: 0,
    split: "development",
    variant: 999,
  });
  const contract = JSON.parse(
    await readFile(join(prepared.originals, "input/code-contract.json"), "utf8")
  );
  const child = Bun.spawn(
    [
      filePython,
      join(import.meta.dir, "file-code-check.py"),
      "--contract-sha256",
    ],
    { stderr: "pipe", stdout: "pipe" }
  );
  const independentHash = (await new Response(child.stdout).text()).trim();
  expect(await child.exited).toBe(0);
  expect(prepared.task.candidateContractSha256).toBe(independentHash);
  expect(contract.name).toBe("pure-currency-function-v1");
  expect(contract.expected).toBeUndefined();
  expect(contract.cases).toBeUndefined();
  expect(prepared.taskTurns[0]).toContain("input/code-contract.json");
  expect(prepared.sourceHashes["input/code-contract.json"]).toBe(
    sha256(await readFile(join(prepared.originals, "input/code-contract.json")))
  );
});

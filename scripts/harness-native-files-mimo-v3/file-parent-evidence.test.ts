import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyFileParentEvidence } from "./file-parent-evidence";
import {
  fixtureJson,
  writeSyntheticFileParents,
} from "./file-parent-evidence-fixtures";
import { fileDigest } from "./file-process-outcome";
import type { ProductPair } from "./product-analysis";

type Row = Record<string, unknown>;
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});
const object = (value: unknown) => value as Row;
const read = async (path: string): Promise<Row> =>
  JSON.parse(await readFile(path, "utf8"));
async function fixture(
  options: Parameters<typeof writeSyntheticFileParents>[3] = {}
) {
  const directory = await mkdtemp("/private/tmp/file-parent-verifier-test-");
  roots.push(directory);
  const schedule: ProductPair[] = [
    {
      family: "csv_join",
      order: ["atlas", "hermes"],
      pairId: "csv-r0",
      repetition: 0,
      seed: 1,
      variant: 0,
    },
  ];
  const ledger: Row[] = schedule.flatMap((pair) =>
    pair.order.flatMap((harness) =>
      ["start", "end"].map((event) => ({
        ...pair,
        event,
        harness,
        id: `synthetic-${pair.pairId}-${harness}`,
      }))
    )
  );
  await fixtureJson(join(directory, "batch.json"), {
    batch: "synthetic",
    budget: { timeoutMs: 300_000 },
    model: "mimo-v2.5",
    phase: "pilot",
    schedule,
    transportMode: "offline-scripted",
  });
  await fixtureJson(join(directory, "completed.json"), {});
  await writeSyntheticFileParents(directory, schedule, ledger, options);
  return {
    atlas: ledger[1]!,
    directory,
    hermes: ledger[3]!,
    ledger,
    schedule,
    trial: join(directory, "trials/synthetic-csv-r0-atlas"),
  };
}
async function verify(input: Awaited<ReturnType<typeof fixture>>) {
  const issues: string[] = [];
  const rows = await verifyFileParentEvidence(
    input.directory,
    input.schedule,
    input.ledger,
    issues
  );
  return { issues, rows };
}
async function reference(directory: string, path: string) {
  const data = await readFile(join(directory, path));
  return { bytes: data.length, path, sha256: fileDigest(data) };
}
/** Deliberately update convenience hashes so semantic checks, rather than stale hashes, reject the mutation. */
async function rebind(input: Awaited<ReturnType<typeof fixture>>) {
  const invocation = await read(join(input.trial, "invocation.json"));
  const references = object(invocation.references);
  for (const path of Object.keys(references)) {
    references[path] = await reference(input.trial, path);
  }
  await fixtureJson(join(input.trial, "invocation.json"), invocation);
  const caller = await read(join(input.trial, "caller-return.json"));
  caller.invocation = await reference(input.trial, "invocation.json");
  await fixtureJson(join(input.trial, "caller-return.json"), caller);
  Object.assign(object(input.atlas.processEvidence), {
    callerReturn: await reference(input.trial, "caller-return.json"),
    invocation: caller.invocation,
  });
}
test("complete paired synthetic disk evidence retains both actual scheduled identities", async () => {
  const input = await fixture();
  const { issues, rows } = await verify(input);
  expect(issues).toEqual([]);
  expect(rows.size).toBe(2);
  for (const [id, value] of rows) {
    expect(value.parentVerified).toBe(true);
    expect(value.processEligible).toBe(true);
    expect(value.nativeRequirementsMet).toBe(true);
    expect(value.nativeObservation?.framework).toBe(
      id.endsWith("atlas") ? "atlas" : "hermes"
    );
  }
});
test("empty native output remains an attributed failure without fabricated native identity", async () => {
  const input = await fixture({ empty: true });
  const { issues, rows } = await verify(input);
  expect(issues).toEqual([]);
  expect(rows.size).toBe(2);
  for (const value of rows.values()) {
    expect(value.parentVerified).toBe(true);
    expect(value.nativeIdentity).toBe("unavailable");
    expect(value.nativeObservation).toBeNull();
    expect(value.nativeRequirementsMet).toBe(false);
    expect(value.processEligible).toBe(false);
  }
});
test("a nonzero exit fails primary eligibility despite a completed native payload", async () => {
  const input = await fixture({ processFailure: true });
  const { issues, rows } = await verify(input);
  expect(issues).toEqual([]);
  expect(rows.size).toBe(2);
  expect(
    [...rows.values()].every(
      (value) => value.nativeIdentity === "bound" && !value.processEligible
    )
  ).toBe(true);
});
test("missing native identity is an attributed failure but explicitly foreign identity is structural", async () => {
  const missing = await fixture({ nativeIdentity: "missing" });
  const unavailable = await verify(missing);
  expect(unavailable.issues).toEqual([]);
  expect(unavailable.rows.size).toBe(2);
  expect(
    [...unavailable.rows.values()].every(
      (value) =>
        value.nativeIdentity === "unavailable" &&
        value.nativeObservation === null &&
        !value.processEligible
    )
  ).toBe(true);
  const foreign = await fixture({ nativeIdentity: "foreign" });
  const conflict = await verify(foreign);
  expect(conflict.rows.size).toBe(0);
  expect(
    conflict.issues.filter((issue) => issue.includes("foreign_native_identity"))
  ).toHaveLength(2);
});
test("native projections cannot turn a failed private grading step into structural invalidity", async () => {
  const input = await fixture();
  input.atlas.status = "failed";
  input.atlas.success = false;
  input.atlas.evaluation = null;
  input.atlas.infrastructureError = "synthetic private grader failure";
  const { issues, rows } = await verify(input);
  expect(issues).toEqual([]);
  expect(rows.size).toBe(2);
  expect(rows.get(String(input.atlas.id))?.processEligible).toBe(true);
});
test("Hermes inspection may survive delayed parent persistence while both primary completions fail their deadline", async () => {
  const input = await fixture({ callerOverrun: true });
  input.hermes.inspectionAllowed = true;
  const { issues, rows } = await verify(input);
  expect(issues).toEqual([]);
  expect(rows.size).toBe(2);
  expect(rows.get(String(input.hermes.id))?.nativeRequirementsMet).toBe(true);
  expect(
    [...rows.values()].every(
      (value) => !value.processEligible && value.parentVerified
    )
  ).toBe(true);
});
test("shared source byte changes invalidate both arms rather than attributing native failures", async () => {
  const input = await fixture({ empty: true });
  await writeFile(
    join(input.directory, "pairs/csv-r0/source-originals/source.csv"),
    "changed"
  );
  const { issues, rows } = await verify(input);
  expect(rows.size).toBe(0);
  expect(
    issues.some((issue) => issue.includes("shared_source_roster_mismatch"))
  ).toBe(true);
});
test("an extra source member is not silently omitted from the assigned roster", async () => {
  const input = await fixture();
  await writeFile(
    join(input.directory, "pairs/csv-r0/source-originals/extra.csv"),
    "extra"
  );
  const { issues, rows } = await verify(input);
  expect(rows.size).toBe(0);
  expect(
    issues.some((issue) => issue.includes("shared_source_roster_mismatch"))
  ).toBe(true);
});
test("raw output and nullable compatibility observation are checked as exact bytes", async () => {
  const input = await fixture();
  await writeFile(join(input.trial, "observation.json"), "null");
  let result = await verify(input);
  expect(result.rows.size).toBe(1);
  expect(
    result.issues.some((issue) =>
      issue.includes("nullable_observation_bytes_mismatch")
    )
  ).toBe(true);
  await writeFile(join(input.trial, "process/runner-stdout.json"), "{}");
  result = await verify(input);
  expect(
    result.issues.some((issue) => issue.includes("evidence_reference_mismatch"))
  ).toBe(true);
});
test("coherently rebound caller duration cannot claim less than the complete outer await", async () => {
  const input = await fixture();
  const caller = await read(join(input.trial, "caller-return.json"));
  caller.outerInvocationElapsedMs = 1;
  input.atlas.elapsedMs = 1;
  await fixtureJson(join(input.trial, "caller-return.json"), caller);
  await rebind(input);
  const { issues, rows } = await verify(input);
  expect(rows.size).toBe(1);
  expect(
    issues.some((issue) => issue.includes("outer_invocation_duration_mismatch"))
  ).toBe(true);
});
test("duplicate exit events remain structural after their outcome and hash projections are rebound", async () => {
  const input = await fixture();
  const outcome = await read(join(input.trial, "process/process-outcome.json"));
  const events = outcome.events as Row[];
  const index = events.findIndex((event) => event.event === "exit");
  events.splice(index, 0, { ...events[index] });
  await fixtureJson(join(input.trial, "process/process-outcome.json"), outcome);
  await writeFile(
    join(input.trial, "process/parent-process-events.jsonl"),
    events.map((event) => JSON.stringify(event)).join("\n") + "\n"
  );
  await rebind(input);
  const { issues, rows } = await verify(input);
  expect(rows.size).toBe(1);
  expect(
    issues.some((issue) => issue.includes("duplicate_parent_process_event"))
  ).toBe(true);
});
test("missing or duplicate parent lifecycle never becomes a denominator-free native failure", async () => {
  const input = await fixture({ empty: true });
  input.ledger.pop();
  let result = await verify(input);
  expect(result.rows.size).toBe(1);
  expect(
    result.issues.some((issue) =>
      issue.includes("missing_or_duplicate_parent_lifecycle")
    )
  ).toBe(true);
  input.ledger.push({ ...input.ledger[0]! });
  result = await verify(input);
  expect(result.rows.size).toBe(0);
});
test("a foreign or changed materialized schedule fails before arm attribution", async () => {
  const input = await fixture();
  const scheduled = await read(join(input.directory, "scheduled-arms.json"));
  object((scheduled.arms as unknown[])[0]).attemptId = "foreign";
  await fixtureJson(join(input.directory, "scheduled-arms.json"), scheduled);
  const { issues, rows } = await verify(input);
  expect(rows.size).toBe(0);
  expect(issues).toEqual([
    "file_parent_inventory:materialized_schedule_mismatch",
  ]);
});
test("symlink evidence is rejected even when its referenced contents have the correct digest", async () => {
  const input = await fixture();
  const path = join(input.trial, "process/runner-stdout.json");
  const target = join(input.directory, "outside-stdout.json");
  await writeFile(target, await readFile(path));
  await rm(path);
  await symlink(target, path);
  const { issues, rows } = await verify(input);
  expect(rows.size).toBe(1);
  expect(
    issues.some((issue) => issue.includes("nonregular_or_oversize_evidence"))
  ).toBe(true);
});

test("missing source copy receipts on a source-free task fail native input without invalidating the parent", async () => {
  const input = await fixture({ omitCopies: true, sourceFree: true });
  const { issues, rows } = await verify(input);
  expect(issues).toEqual([]);
  expect(rows.size).toBe(2);
  expect(
    [...rows.values()].every(
      (value) => value.parentVerified && !value.nativeRequirementsMet
    )
  ).toBe(true);
});

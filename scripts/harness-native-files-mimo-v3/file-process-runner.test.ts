import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assessFileNativeOutput,
  censusScheduledFileArms,
  fileDigest,
  type ScheduledFileArm,
} from "./file-process-outcome";
import {
  createFileProcessDeadline,
  runFileProcess,
} from "./file-process-runner";

const evidenceRoot =
  "/private/tmp/atlas-native-file-runner-v3-candidate/fixture-results";
const good = `const out={framework:input.harness,runId:input.runId,status:'completed',finalText:'done',sessions:[],nativeEvents:[]};`;
async function fixture(
  name: string,
  script: string,
  options: {
    timeoutMs?: number;
    stdoutBytes?: number;
    stderrBytes?: number;
    command?: string;
    deadlineExpired?: boolean;
    identityConflict?: boolean;
    inputConflict?: boolean;
    cwdConflict?: boolean;
  } = {}
) {
  await mkdir(evidenceRoot, { recursive: true });
  const root = await mkdtemp(join(evidenceRoot, `${name}-`));
  const native = join(root, "native"),
    receipt = join(root, "receipt");
  await mkdir(native);
  const expected: ScheduledFileArm = {
    attemptId: name,
    harness: "hermes",
    identitySha256: fileDigest(`mapping-${name}`),
    nativeStateRoot: native,
    pairId: `pair-${name}`,
    transportId: `transport-${name}`,
  };
  const runtimeIdentityBytes = Buffer.from(
    JSON.stringify({ ...expected, identitySha256: undefined })
  );
  const boundExpected = {
    ...expected,
    identitySha256: fileDigest(runtimeIdentityBytes),
  };
  await writeFile(join(root, "runtime-identity.json"), runtimeIdentityBytes);
  const deadline = createFileProcessDeadline(
    options.timeoutMs ?? 1800,
    "scheduled_attempt"
  );
  if (options.deadlineExpired) {
    await Bun.sleep((options.timeoutMs ?? 1800) + 5);
  }
  const input = {
    harness: expected.harness,
    marker: join(native, "started"),
    receipt: join(receipt, "scheduled-arm.json"),
    runId: options.inputConflict ? "wrong-input" : expected.transportId,
  };
  const source = `const fs=require('node:fs');const input=JSON.parse(fs.readFileSync(0,'utf8'));${good}${script}`;
  const result = await runFileProcess({
    args: ["--no-install", "--no-addons", "-e", source],
    command: options.command ?? process.execPath,
    cwd: options.cwdConflict ? root : native,
    deadline,
    directory: receipt,
    env: { HOME: native, PATH: "/usr/bin:/bin" },
    expected: boundExpected,
    input,
    limits: {
      closeGraceMs: 150,
      drainGraceMs: 80,
      stderrBytes: options.stderrBytes ?? 100_000,
      stdoutBytes: options.stdoutBytes ?? 100_000,
      termGraceMs: 80,
    },
    runtimeIdentityBytes: options.identityConflict
      ? Buffer.from(
          JSON.stringify({ ...boundExpected, transportId: "wrong-identity" })
        )
      : runtimeIdentityBytes,
  });
  await writeFile(join(root, "fixture-source.txt"), source);
  return { expected: boundExpected, native, receipt, result, root };
}

test("actual child reads exact parent identity receipt persisted before startup", async () => {
  const f = await fixture(
    "prelaunch",
    `const receipt=JSON.parse(fs.readFileSync(input.receipt,'utf8'));if(receipt.expected.transportId!==input.runId)process.exit(42);fs.writeFileSync(input.marker,'actual startup');out.evidence={nativeCleanup:{completed:true}};process.stdout.write(JSON.stringify(out));`
  );
  expect(f.result.processFailure).toBe(false);
  expect(f.result.native.identity).toBe("bound");
  expect(await readFile(join(f.native, "started"), "utf8")).toBe(
    "actual startup"
  );
  expect(
    f.result.events.findIndex((e) => e.event === "scheduled_receipt_persisted")
  ).toBeLessThan(f.result.events.findIndex((e) => e.event === "spawn_call"));
  expect(f.result.events.some((e) => e.event === "spawn_event")).toBe(true);
  expect(f.result.exit?.code).toBe(0);
  expect(f.result.cleanup.directChildExitObserved).toBe(true);
  expect(f.result.cleanup.allDescendantsGone).toBe("unproved");
  expect(f.result.cleanup.nativeReport?.authority).toBe("native_report_only");
  expect(f.result.usage.reportedCounts).toBeNull();
  expect(f.result.usage.inferZeroFromProcessFailure).toBe(false);
  const persisted = JSON.parse(
    await readFile(join(f.receipt, "process-outcome.json"), "utf8")
  );
  expect(persisted.expected).toEqual(f.expected);
  expect(persisted.nativeObservation).toBeUndefined();
  expect(persisted.native.observationFile.path).toBe("runner-stdout.json");
  expect(persisted.native.observationFile.sha256).toBe(
    fileDigest(await readFile(join(f.receipt, "runner-stdout.json")))
  );
});
for (const [name, script, identity, reason] of [
  ["empty", "", "unavailable", "empty_output"],
  [
    "missing-id",
    "delete out.runId;process.stdout.write(JSON.stringify(out));",
    "unavailable",
    "missing_identity",
  ],
  [
    "null-id",
    "out.runId=null;process.stdout.write(JSON.stringify(out));",
    "unavailable",
    "missing_identity",
  ],
  [
    "foreign-id",
    "out.runId='foreign';process.stdout.write(JSON.stringify(out));",
    "conflict",
    "conflicting_identity",
  ],
  [
    "partial",
    `process.stdout.write('{"framework":"hermes","runId":');`,
    "unavailable",
    "invalid_json",
  ],
  [
    "bad-shape",
    "out.finalText=12;process.stdout.write(JSON.stringify(out));",
    "unavailable",
    "invalid_shape",
  ],
] as const) {
  test(`${name}: failed scheduled arm without invented native identity`, async () => {
    const f = await fixture(name, script);
    expect(f.result.processFailure).toBe(true);
    expect(f.result.expected).toEqual(f.expected);
    expect(f.result.native.identity).toBe(identity);
    expect(f.result.native.reason).toBe(reason);
    expect(f.result.nativeObservation).toBeNull();
    expect(f.result.receiptComplete).toBe(true);
    const census = censusScheduledFileArms([f.expected], [f.result]);
    expect(census.rows).toHaveLength(1);
    expect(census.rows[0]!.state).toBe(
      identity === "conflict" ? "conflict" : "observed_failure"
    );
    expect(f.result.cleanup.nativeReport).toBeNull();
  });
}
test("native failure and nonzero exit cannot become completed from matching identity", async () => {
  const native = await fixture(
    "native-failure",
    "out.status='failed';process.stdout.write(JSON.stringify(out));"
  );
  expect(native.result.native.identity).toBe("bound");
  expect(native.result.failures).toContain("native_reported_failure");
  const failed = await fixture(
    "nonzero",
    "process.stdout.write(JSON.stringify(out));process.exitCode=9;"
  );
  expect(failed.result.nativeObservation?.status).toBe("completed");
  expect(failed.result.exit?.code).toBe(9);
  expect(failed.result.processFailure).toBe(true);
});
for (const ignored of [false, true]) {
  test(`silent timeout records actual ${ignored ? "KILL" : "TERM"} exit`, async () => {
    const f = await fixture(
      ignored ? "ignore-term" : "silent",
      `${ignored ? "process.on('SIGTERM',()=>{});" : ""}fs.writeFileSync(input.marker,'started');setInterval(()=>{},1000);`,
      { timeoutMs: 180 }
    );
    expect(await readFile(join(f.native, "started"), "utf8")).toBe("started");
    expect(f.result.timedOut).toBe(true);
    expect(f.result.processFailure).toBe(true);
    expect(f.result.events.some((e) => e.event === "deadline_fired")).toBe(
      true
    );
    expect(
      f.result.signals.some(
        (e) =>
          e.signal === (ignored ? "SIGKILL" : "SIGTERM") && e.result === "sent"
      )
    ).toBe(true);
    expect(f.result.exit?.signal).toBe(ignored ? "SIGKILL" : "SIGTERM");
    expect(f.result.cleanup.nativeReport).toBeNull();
    expect(f.result.elapsedMonotonicMs).toBeLessThan(1800);
  });
}
test("descendant-held pipes have a bounded drain and explicit cleanup uncertainty", async () => {
  const f = await fixture(
    "descendant-pipe",
    `const cp=require('node:child_process');const child=cp.spawn(process.execPath,['--no-install','--no-addons','-e',"setInterval(()=>{},1000)"],{stdio:['ignore',1,2]});child.unref();process.stdout.write(JSON.stringify(out));`
  );
  expect(f.result.exit?.code).toBe(0);
  expect(f.result.drainExpired).toBe(true);
  expect(f.result.processFailure).toBe(true);
  expect(f.result.failures).toContain("drain_timeout");
  expect(f.result.elapsedMonotonicMs).toBeLessThan(1800);
  expect(f.result.cleanup.allDescendantsGone).toBe("unproved");
});
for (const stream of ["stdout", "stderr"] as const) {
  test(`${stream} overflow retains bounded bytes and fails`, async () => {
    const f = await fixture(
      `${stream}-overflow`,
      `${stream === "stderr" ? "process.stdout.write(JSON.stringify(out));" : ""}process.${stream}.write('x'.repeat(65536));setInterval(()=>{},1000);`,
      { stderrBytes: 1024, stdoutBytes: 1024 }
    );
    expect(f.result[stream].bytesStored).toBe(1024);
    expect(f.result[stream].overflow).toBe(true);
    expect(f.result.processFailure).toBe(true);
    expect(
      (
        await readFile(
          join(
            f.receipt,
            `runner-${stream}.${stream === "stdout" ? "json" : "log"}`
          )
        )
      ).length
    ).toBe(1024);
  });
}
test("spawn error and pre-expired deadline remain observed failures", async () => {
  const absent = await fixture("spawn-failure", "", {
    command: "/private/tmp/nonexistent-runner-v3-executable",
  });
  expect(absent.result.pid).toBeNull();
  expect(absent.result.processFailure).toBe(true);
  expect(absent.result.events.some((e) => e.event === "child_error")).toBe(
    true
  );
  const elapsed = await fixture(
    "pre-expired",
    "fs.writeFileSync(input.marker,'unexpected');",
    { deadlineExpired: true, timeoutMs: 5 }
  );
  expect(elapsed.result.pid).toBeNull();
  expect(elapsed.result.timedOut).toBe(true);
  expect(elapsed.result.events.some((e) => e.event === "spawn_call")).toBe(
    false
  );
});
test("census retains complete schedule, ambiguous rows and unscheduled evidence", async () => {
  const f = await fixture(
    "census",
    "process.stdout.write(JSON.stringify(out));"
  );
  const missing = {
    ...f.expected,
    attemptId: "missing",
    nativeStateRoot: `${f.native}/missing`,
    transportId: "transport-missing",
  };
  const duplicate = {
    ...f.expected,
    attemptId: "duplicate",
    nativeStateRoot: `${f.native}/duplicate`,
    transportId: "transport-duplicate",
  };
  const foreign = {
    ...f.result,
    expected: { ...f.expected, attemptId: "unscheduled" },
  };
  const census = censusScheduledFileArms(
    [f.expected, missing, duplicate],
    [
      f.result,
      { ...f.result, expected: duplicate },
      { ...f.result, expected: duplicate },
      foreign,
    ]
  );
  expect(census.rows.map((row) => row.state)).toEqual([
    "native_candidate",
    "missing",
    "duplicate",
  ]);
  expect(census.unscheduled).toHaveLength(1);
  expect(census.calculatesScores).toBe(false);
  expect(
    censusScheduledFileArms(
      [f.expected],
      [{ ...f.result, receiptComplete: false }]
    ).rows[0]!.state
  ).toBe("incomplete_parent");
  const reordered = Object.fromEntries(
    Object.entries(f.expected).reverse()
  ) as unknown as ScheduledFileArm;
  expect(
    censusScheduledFileArms(
      [f.expected],
      [{ ...f.result, expected: reordered }]
    ).rows[0]!.state
  ).toBe("native_candidate");
});
test("old zero-byte outcome cannot be assigned a native runId", () => {
  const expected: ScheduledFileArm = {
    attemptId: "original-failure",
    harness: "hermes",
    identitySha256: "a".repeat(64),
    nativeStateRoot: "/private/tmp/expected-only",
    pairId: "pptx_revision-v0",
    transportId: "expected-only",
  };
  const native = assessFileNativeOutput(new Uint8Array(), true, expected);
  expect(native.identity).toBe("unavailable");
  expect(native.observation).toBeNull();
  const census = censusScheduledFileArms(
    [expected],
    [
      {
        expected,
        native: { identity: native.identity, reportedStatus: null },
        parentBinding: "bound",
        processFailure: true,
        receiptComplete: true,
      },
    ]
  );
  expect(census.rows[0]!.state).toBe("observed_failure");
  expect(census.calculatesScores).toBe(false);
});

for (const field of [
  "identityConflict",
  "inputConflict",
  "cwdConflict",
] as const) {
  test(`${field} blocks startup and remains structural conflict`, async () => {
    const f = await fixture(
      field,
      "fs.writeFileSync(input.marker,'unexpected');",
      { [field]: true }
    );
    expect(f.result.parentBinding).toBe("conflict");
    expect(f.result.processFailure).toBe(true);
    expect(f.result.pid).toBeNull();
    expect(f.result.events.some((event) => event.event === "spawn_call")).toBe(
      false
    );
    expect(
      censusScheduledFileArms([f.expected], [f.result]).rows[0]!.state
    ).toBe("conflict");
  });
}

test("duplicate scheduled transport or native state remains visible", async () => {
  const f = await fixture(
    "duplicate-transport",
    "process.stdout.write(JSON.stringify(out));"
  );
  const other = {
    ...f.expected,
    attemptId: "other",
    nativeStateRoot: `${f.native}/other`,
  };
  const census = censusScheduledFileArms([f.expected, other], [f.result]);
  expect(census.rows).toHaveLength(2);
  expect(census.rows.map((row) => row.state)).toEqual([
    "duplicate",
    "duplicate",
  ]);
});

test("repeated invocation cannot overwrite an existing arm receipt or start another child", async () => {
  const f = await fixture(
    "repeat-refused",
    "fs.writeFileSync(input.marker,'first');process.stdout.write(JSON.stringify(out));"
  );
  const before = await readFile(join(f.receipt, "process-outcome.json"));
  await expect(
    runFileProcess({
      args: [
        "--no-install",
        "--no-addons",
        "-e",
        `require('node:fs').writeFileSync('started','second')`,
      ],
      command: process.execPath,
      cwd: f.native,
      deadline: createFileProcessDeadline(1000, "process_invocation"),
      directory: f.receipt,
      env: { HOME: f.native, PATH: "/usr/bin:/bin" },
      expected: f.expected,
      input: { runId: f.expected.transportId },
      runtimeIdentityBytes: await readFile(
        join(f.root, "runtime-identity.json")
      ),
    })
  ).rejects.toThrow();
  expect(await readFile(join(f.receipt, "process-outcome.json"))).toEqual(
    before
  );
  expect(await readFile(join(f.native, "started"), "utf8")).toBe("first");
  expect(
    fileDigest(await readFile(join(f.receipt, "parent-runtime-identity.json")))
  ).toBe(f.expected.identitySha256);
});

test("deep valid JSON payload fails as native evidence without losing its parent outcome", async () => {
  const f = await fixture(
    "deep-payload",
    `process.stdout.write(JSON.stringify(out).slice(0,-1)+',"deep":'+'['.repeat(20000)+'0'+']'.repeat(20000)+'}');`
  );
  expect(f.result.processFailure).toBe(true);
  expect(f.result.nativeObservation).toBeNull();
  expect(f.result.receiptComplete).toBe(true);
  expect(
    (await readFile(join(f.receipt, "process-outcome.json"))).length
  ).toBeLessThan(20_000);
  expect(
    (await readFile(join(f.receipt, "runner-stdout.json"))).length
  ).toBeGreaterThan(40_000);
  expect(
    JSON.parse(await readFile(join(f.receipt, "process-outcome.json"), "utf8"))
      .expected
  ).toEqual(f.expected);
});

test("nonfinite parsed JSON numbers cannot silently become null in native evidence", async () => {
  const f = await fixture(
    "nonfinite-payload",
    `process.stdout.write(JSON.stringify(out).slice(0,-1)+',"number":1e400}');`
  );
  expect(f.result.processFailure).toBe(true);
  expect(f.result.nativeObservation).toBeNull();
  expect(
    (await readFile(join(f.receipt, "runner-stdout.json"), "utf8")).includes(
      "1e400"
    )
  ).toBe(true);
});

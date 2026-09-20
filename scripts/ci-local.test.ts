import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories: string[] = [];
const scriptsDirectory = import.meta.dir;
const python = Bun.which("python3");
const jq = Bun.which("jq");

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "atlas-ci-preflight-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function executable(
  directory: string,
  name: string,
  source: string
): Promise<void> {
  const destination = join(directory, name);
  await writeFile(destination, source);
  await chmod(destination, 0o700);
}

async function runScript(
  directory: string,
  name: string,
  arguments_: string[]
) {
  const child = Bun.spawn(
    ["bash", join(scriptsDirectory, name), ...arguments_],
    {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}` },
      stderr: "pipe",
      stdout: "pipe",
    }
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

async function hostFixture(
  diskKib: number | string,
  memoryBytes = 8 * 1024 ** 3
): Promise<string> {
  const directory = await fixture();
  const events = join(directory, "events");
  await writeFile(events, "");
  for (const [name, output] of [
    ["uname", "Darwin"],
    ["sysctl", String(memoryBytes)],
    [
      "df",
      `Filesystem 1024-blocks Used Available Capacity Mounted on\nfixture 999999999 0 ${diskKib} 0% /`,
    ],
    ["colima", ""],
    ["qemu-system-x86_64", ""],
    ["gh", ""],
    ["jq", ""],
    ["brew", "lima-additional-guestagents 2.2.0"],
  ]) {
    await executable(
      directory,
      name!,
      `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(events)}, ${JSON.stringify(name)} + "\\n");
process.stdout.write(${JSON.stringify(`${output}\n`)});
`
    );
  }
  return directory;
}

test.each([
  { args: ["preflight"] },
  { args: ["provision"] },
  { args: ["refresh"] },
])(
  "insufficient disk blocks %j before VM or GitHub access",
  async ({ args }) => {
    const directory = await hostFixture(35 * 1024 ** 2 - 1);
    const result = await runScript(directory, "ci-local.sh", args);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(await readFile(join(directory, "events"), "utf8")).toBe(
      "uname\ndf\n"
    );
  }
);

test("unreadable disk evidence and insufficient host memory fail closed", async () => {
  for (const [diskKib, memoryBytes] of [
    ["unknown", 8 * 1024 ** 3],
    [35 * 1024 ** 2, 4 * 1024 ** 3],
  ] as const) {
    const directory = await hostFixture(diskKib, memoryBytes);
    const result = await runScript(directory, "ci-local.sh", ["preflight"]);
    expect(result.exitCode).toBe(2);
    const events = await readFile(join(directory, "events"), "utf8");
    expect(events).not.toContain("colima");
    expect(events).not.toContain("gh");
  }
});

test("the exact disk threshold permits only a host preflight", async () => {
  const directory = await hostFixture(35 * 1024 ** 2);
  const result = await runScript(directory, "ci-local.sh", ["preflight"]);
  expect(result.exitCode).toBe(0);
  expect(await readFile(join(directory, "events"), "utf8")).toBe(
    "uname\ndf\nsysctl\nbrew\n"
  );
});

test("refresh persists only the two current scripts and refuses an active runner", async () => {
  const directory = await hostFixture(35 * 1024 ** 2);
  const guestDirectory = join(directory, "guest");
  const bootstrap = join(guestDirectory, ".local/share/atlas-ci-bootstrap");
  const events = join(directory, "events");
  await executable(
    directory,
    "colima",
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(events)}, JSON.stringify(args) + "\\n");
if (JSON.stringify(args.slice(0, 6)) !== JSON.stringify(["--profile", "atlas-ci", "ssh", "--", "sh", "-c"])) process.exit(9);
// Model the remote shell's guest-home expansion without changing host HOME.
const script = args[6].replaceAll("$HOME", ${JSON.stringify(guestDirectory)});
const child = Bun.spawn(["/bin/sh", "-c", script], {stdin:"inherit", stdout:"inherit", stderr:"inherit"});
process.exit(await child.exited);
`
  );
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await runScript(directory, "ci-local.sh", ["refresh"]);
    expect(result.exitCode).toBe(0);
    expect((await readdir(bootstrap)).sort()).toEqual([
      "ci-local-guest.sh",
      "verify-linux-landlock.sh",
    ]);
    for (const name of await readdir(bootstrap)) {
      expect(await readFile(join(bootstrap, name), "utf8")).toBe(
        await readFile(join(scriptsDirectory, name), "utf8")
      );
      expect((await stat(join(bootstrap, name))).mode % 0o1000).toBe(0o600);
    }
    expect((await stat(bootstrap)).mode % 0o1000).toBe(0o700);
    // A later refresh must replace stale guest bytes with the current source.
    await writeFile(join(bootstrap, "ci-local-guest.sh"), "stale guest source");
  }
  await mkdir(join(guestDirectory, ".atlas-ci-runner-lock"));
  const locked = await runScript(directory, "ci-local.sh", ["refresh"]);
  expect(locked.exitCode).not.toBe(0);
  expect(await readFile(join(bootstrap, "ci-local-guest.sh"), "utf8")).toBe(
    "stale guest source"
  );
  const observed = await readFile(events, "utf8");
  expect(observed).not.toContain("start");
  expect(observed).not.toContain("gh");
  expect(observed).not.toContain("/tmp/atlas-ci-bootstrap");
});

interface RunState {
  attempt: number;
  completed: string[];
  dataFreeKiB: number | string;
  hostFreeKiB: number | string;
  mode: string;
  queue: string[];
  rootFreeKiB: number | string;
  sha: string;
}

const reviewedSha = "a".repeat(40);
const gibInKiB = 1024 ** 2;

async function runFixture() {
  if (!jq) {
    throw new Error("jq is required to exercise run metadata checks.");
  }
  const directory = await hostFixture(35 * gibInKiB);
  const events = join(directory, "events");
  const statePath = join(directory, "state.json");
  const gitMetadata = join(directory, "git-metadata");
  await mkdir(gitMetadata);
  const state: RunState = {
    attempt: 1,
    completed: [],
    dataFreeKiB: 5 * gibInKiB,
    hostFreeKiB: 35 * gibInKiB,
    mode: "pass",
    queue: ["123", "456"],
    rootFreeKiB: 5 * gibInKiB,
    sha: reviewedSha,
  };
  const save = async () => {
    await writeFile(statePath, JSON.stringify(state));
  };
  await save();
  const loadState = `import { appendFileSync, readFileSync } from "node:fs";
const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, "utf8"));
const args = process.argv.slice(2);
const log = value => appendFileSync(${JSON.stringify(events)}, value + "\\n");
`;
  await executable(
    directory,
    "jq",
    `#!${process.execPath}
const child = Bun.spawn([${JSON.stringify(jq)}, ...process.argv.slice(2)], {stdin:"inherit", stdout:"inherit", stderr:"inherit"});
process.exit(await child.exited);
`
  );
  await executable(
    directory,
    "df",
    `#!${process.execPath}
${loadState}
log("df");
if (state.mode === "host-evidence-failure") process.exit(9);
console.log("Filesystem 1024-blocks Used Available Capacity Mounted on\\nfixture 999999999 0 " + state.hostFreeKiB + " 0% /");
`
  );
  await executable(
    directory,
    "gh",
    `#!${process.execPath}
${loadState}
log(JSON.stringify(args));
const route = args.find(value => value.startsWith("repos/")) ?? "";
if (route.includes("registration-token")) console.log("fixture_registration_token");
else if (args[0] === "variable" || route.includes("/jobs?")) console.log("atlas-local-ci-amd64");
else if (route.includes("?status=")) {
  if (state.mode === "queue-unavailable") process.exit(9);
  if (route.includes("status=queued")) console.log(state.queue.join("\\n"));
} else {
  const id = route.split("/").at(-1);
  console.log(JSON.stringify({id:Number(id), run_attempt:state.attempt,
    head_sha: state.mode === "wrong-sha" || (state.mode === "other-member-sha" && id === "456") ? "b".repeat(40) : state.sha,
    head_repository:{full_name:state.mode === "fork" ? "outsider/atlas" : "kungfufafa/atlas"},
    status:state.completed.includes(id) ? "completed" : "queued"}));
}
`
  );
  await executable(
    directory,
    "git",
    `#!${process.execPath}
${loadState}
if (args[2] === "rev-parse") console.log(args[3] === "--absolute-git-dir" ? ${JSON.stringify(gitMetadata)} : state.mode === "wrong-head" ? "b".repeat(40) : state.sha);
else if (args[2] === "show") {
  const name = args[3].split(":scripts/").at(-1);
  const source = readFileSync(${JSON.stringify(scriptsDirectory)} + "/" + name);
  process.stdout.write(state.mode === "modified-source" ? "different reviewed source" : source);
} else process.exit(9);
`
  );
  await executable(
    directory,
    "colima",
    `#!${process.execPath}
${loadState}
const script = args.at(-1);
if (script.includes("data_mount=")) {
  log("colima:space");
  if (state.mode === "guest-evidence-failure") process.exit(9);
  console.log(state.rootFreeKiB + " " + state.dataFreeKiB);
} else if (script.includes("tar -xf")) {
  log("colima:refresh");
  await new Response(Bun.stdin).arrayBuffer();
  if (state.mode === "transfer-failure" || state.mode === "runner-lock") process.exit(17);
} else if (script.includes("verify-linux-landlock.sh")) {
  log("colima:probe");
  if (state.mode === "landlock-failure") process.exit(2);
} else if (script.includes("ci-local-guest.sh")) {
  log("colima:run");
  if ((await new Response(Bun.stdin).text()).trim() !== "fixture_registration_token") process.exit(9);
} else process.exit(9);
`
  );
  return {
    directory,
    events,
    receipt: join(gitMetadata, "atlas-ci/gate-admission.json"),
    save,
    state,
  };
}

function runGate(
  directory: string,
  runId = "123",
  sha = reviewedSha,
  members = ["123:1", "456:1"]
) {
  return runScript(directory, "ci-local.sh", ["run", runId, sha, ...members]);
}

test("fresh admission records measured headroom privately and continues the same finite gate", async () => {
  const { directory, events, receipt, save, state } = await runFixture();
  const first = await runGate(directory);
  expect(first.exitCode).toBe(0);
  const admitted = await readFile(receipt, "utf8");
  expect(JSON.parse(admitted)).toMatchObject({
    hostFreeKiB: 35 * gibInKiB,
    profile: "atlas-ci",
    repository: "kungfufafa/atlas",
    reviewedSha,
    runs: [
      { attempt: 1, id: "123" },
      { attempt: 1, id: "456" },
    ],
    schema: 1,
  });
  expect((await stat(receipt)).mode % 0o1000).toBe(0o600);
  expect((await stat(join(receipt, ".."))).mode % 0o1000).toBe(0o700);
  expect(await readdir(join(receipt, ".."))).toEqual(["gate-admission.json"]);
  state.hostFreeKiB = 10 * gibInKiB;
  state.completed = ["123"];
  state.queue = ["456"];
  await save();
  await writeFile(events, "");
  const continuation = await runGate(directory, "456");
  expect(continuation.exitCode).toBe(0);
  expect(await readFile(receipt, "utf8")).toBe(admitted);
  const observed = await readFile(events, "utf8");
  expect(observed).toContain("colima:space");
  expect(observed).toContain("colima:probe");
  expect(observed).toContain("registration-token");
  expect(observed).toContain("colima:run");
});

test("a fresh gate below 35 GiB refuses without creating or importing a receipt", async () => {
  const { directory, events, receipt, save, state } = await runFixture();
  state.hostFreeKiB = 35 * gibInKiB - 1;
  await save();
  expect((await runGate(directory)).exitCode).not.toBe(0);
  expect(await Bun.file(receipt).exists()).toBe(false);
  const observed = await readFile(events, "utf8");
  expect(observed).not.toContain("colima:");
  expect(observed).not.toContain("registration-token");
});

test.each(["sha", "run", "attempt", "repository", "profile"])(
  "changed %s cannot reuse admission below 35 GiB",
  async (field) => {
    const { directory, events, receipt, save, state } = await runFixture();
    expect((await runGate(directory)).exitCode).toBe(0);
    let runId = "123";
    let members = ["123:1", "456:1"];
    if (field === "sha") {
      state.sha = "b".repeat(40);
    }
    if (field === "run") {
      runId = "789";
      members = ["789:1"];
      state.queue = ["789"];
    }
    if (field === "attempt") {
      state.attempt = 2;
      members = ["123:2", "456:2"];
    }
    if (field === "repository" || field === "profile") {
      const altered = JSON.parse(await readFile(receipt, "utf8"));
      altered[field] = "different";
      await writeFile(receipt, JSON.stringify(altered));
    }
    state.hostFreeKiB = 35 * gibInKiB - 1;
    await save();
    await writeFile(events, "");
    expect(
      (await runGate(directory, runId, state.sha, members)).exitCode
    ).not.toBe(0);
    const observed = await readFile(events, "utf8");
    expect(observed).not.toContain("colima:");
    expect(observed).not.toContain("registration-token");
  }
);

test("a new reviewed SHA requires and records its own fresh observation", async () => {
  const { directory, receipt, save, state } = await runFixture();
  expect((await runGate(directory)).exitCode).toBe(0);
  state.sha = "b".repeat(40);
  state.hostFreeKiB = 36 * gibInKiB;
  await save();
  expect((await runGate(directory, "123", state.sha)).exitCode).toBe(0);
  expect(JSON.parse(await readFile(receipt, "utf8"))).toMatchObject({
    hostFreeKiB: 36 * gibInKiB,
    reviewedSha: state.sha,
  });
});

test.each([
  "malformed",
  "unmeasured",
  "forged-low-space",
  "public-mode",
  "concatenated-objects",
  "scalar-prefix",
])("invalid %s receipt cannot admit a job", async (mode) => {
  const { directory, events, receipt, save, state } = await runFixture();
  expect((await runGate(directory)).exitCode).toBe(0);
  const altered = JSON.parse(await readFile(receipt, "utf8"));
  if (mode === "unmeasured") {
    delete altered.hostFreeKiB;
  }
  if (mode === "forged-low-space") {
    altered.hostFreeKiB = 10 * gibInKiB;
  }
  let content = JSON.stringify(altered);
  if (mode === "malformed") {
    content = "{";
  }
  if (mode === "concatenated-objects") {
    content = `{}\n${content}`;
  }
  if (mode === "scalar-prefix") {
    content = `42\n${content}`;
  }
  await writeFile(receipt, content);
  state.hostFreeKiB = 20 * gibInKiB;
  await save();
  if (mode === "public-mode") {
    await chmod(receipt, 0o644);
  }
  await writeFile(events, "");
  expect((await runGate(directory)).exitCode).not.toBe(0);
  expect(await readFile(events, "utf8")).not.toContain("registration-token");
});

test.each([
  "host-low",
  "host-unknown",
  "host-evidence-failure",
  "root-low",
  "data-low",
  "root-unknown",
  "data-unknown",
  "guest-evidence-failure",
])("%s evidence blocks continuation before token", async (mode) => {
  const { directory, events, save, state } = await runFixture();
  expect((await runGate(directory)).exitCode).toBe(0);
  state.hostFreeKiB = mode === "host-low" ? 10 * gibInKiB - 1 : 20 * gibInKiB;
  if (mode === "host-unknown") {
    state.hostFreeKiB = "unknown";
  }
  if (mode === "root-low") {
    state.rootFreeKiB = 5 * gibInKiB - 1;
  }
  if (mode === "data-low") {
    state.dataFreeKiB = 5 * gibInKiB - 1;
  }
  if (mode === "root-unknown") {
    state.rootFreeKiB = "unknown";
  }
  if (mode === "data-unknown") {
    state.dataFreeKiB = "unknown";
  }
  state.mode = mode;
  await save();
  await writeFile(events, "");
  expect((await runGate(directory)).exitCode).not.toBe(0);
  expect(await readFile(events, "utf8")).not.toContain("registration-token");
});

test.each([
  "fork",
  "wrong-sha",
  "other-member-sha",
  "queue-unavailable",
  "wrong-head",
  "modified-source",
  "transfer-failure",
  "landlock-failure",
  "runner-lock",
])("%s still prevents admission and registration", async (mode) => {
  const { directory, events, receipt, save, state } = await runFixture();
  state.mode = mode;
  if (mode === "other-member-sha") {
    state.completed = ["456"];
  }
  await save();
  expect((await runGate(directory)).exitCode).not.toBe(0);
  expect(await Bun.file(receipt).exists()).toBe(false);
  expect(await readFile(events, "utf8")).not.toContain("registration-token");
});

test.each([
  { members: ["456:1"], queue: ["123", "456"] },
  { members: ["123:1"], queue: ["123", "789"] },
  { members: ["123:1", "456:2"], queue: ["123"] },
  { members: ["123:1", "123:1"], queue: ["123"] },
])(
  "an incomplete or mismatched explicit gate %j refuses registration",
  async ({ members, queue }) => {
    const { directory, events, save, state } = await runFixture();
    state.queue = queue;
    await save();
    expect(
      (await runGate(directory, "123", reviewedSha, members)).exitCode
    ).not.toBe(0);
    expect(await readFile(events, "utf8")).not.toContain("registration-token");
  }
);

async function probeFixture(abi: number, architecture = "x86_64") {
  if (!python) {
    throw new Error(
      "Python 3 is required to exercise the actual probe program."
    );
  }
  const directory = await fixture();
  const events = join(directory, "events");
  const controlledSyscall = `import ctypes, platform, types
platform.system = lambda: "Linux"
platform.machine = lambda: ${JSON.stringify(architecture)}
ctypes.CDLL = lambda *args, **kwargs: types.SimpleNamespace(syscall=lambda *args: ${abi})
ctypes.get_errno = lambda: 38
`;
  for (const name of ["python3", "docker"]) {
    await executable(
      directory,
      name,
      `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(events)}, JSON.stringify(process.argv.slice(2)) + "\\n");
const child = Bun.spawn([${JSON.stringify(python)}, "-c", ${JSON.stringify(controlledSyscall)} + process.argv.at(-1)], {stdout:"inherit", stderr:"inherit"});
process.exit(await child.exited);
`
    );
  }
  return { directory, events };
}

test.each([-1, 0, 2])(
  "Landlock ABI %s blocks host and container probes",
  async (abi) => {
    const { directory } = await probeFixture(abi);
    for (const args of [[], ["controlled-image"]]) {
      const result = await runScript(
        directory,
        "verify-linux-landlock.sh",
        args
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
    }
  }
);

test("an ARM guest cannot substitute for the production architecture", async () => {
  const { directory } = await probeFixture(6, "aarch64");
  const result = await runScript(directory, "verify-linux-landlock.sh", []);
  expect(result.exitCode).not.toBe(0);
});

test("ABI 3 passes without weakening container security settings", async () => {
  const { directory, events } = await probeFixture(3);
  const result = await runScript(directory, "verify-linux-landlock.sh", [
    "controlled-image",
  ]);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout).landlockAbi).toBe(3);
  const command = JSON.parse((await readFile(events, "utf8")).trim());
  expect(command.slice(0, -1)).toEqual([
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--entrypoint",
    "python3",
    "controlled-image",
    "-c",
  ]);
});

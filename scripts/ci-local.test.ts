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
  { args: ["run", "123", "a".repeat(40)] },
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

async function reviewedRunFixture(mode: string) {
  if (!jq) {
    throw new Error("jq is required to exercise run metadata checks.");
  }
  const directory = await hostFixture(35 * 1024 ** 2);
  const events = join(directory, "events");
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
    "gh",
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(events)}, JSON.stringify(args) + "\\n");
const route = args.find(value => value.startsWith("repos/")) ?? "";
if (route.includes("registration-token")) throw new Error("Registration must not be reached");
if (args[0] === "variable" || route.includes("/jobs?")) console.log("atlas-local-ci-amd64");
else if (route.includes("?status=")) console.log("123");
else console.log(JSON.stringify({head_sha: "a".repeat(40), head_repository: {full_name: "kungfufafa/atlas"}, status: "queued"}));
`
  );
  await executable(
    directory,
    "git",
    `#!${process.execPath}
import { readFileSync } from "node:fs";
const args = process.argv.slice(2);
const mode = ${JSON.stringify(mode)};
if (args[2] === "rev-parse") console.log((mode === "wrong-head" ? "b" : "a").repeat(40));
else if (args[2] === "show") {
  const name = args[3].split(":scripts/").at(-1);
  const source = readFileSync(${JSON.stringify(scriptsDirectory)} + "/" + name);
  process.stdout.write(mode === "modified-source" ? "different reviewed source" : source);
} else process.exit(9);
`
  );
  await executable(
    directory,
    "colima",
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(events)}, "colima\\n");
process.exit(17);
`
  );
  return { directory, events };
}

test.each(["wrong-head", "modified-source", "transfer-failure"])(
  "%s prevents guest execution and registration",
  async (mode) => {
    const { directory, events } = await reviewedRunFixture(mode);
    const result = await runScript(directory, "ci-local.sh", [
      "run",
      "123",
      "a".repeat(40),
    ]);
    expect(result.exitCode).not.toBe(0);
    const observed = await readFile(events, "utf8");
    expect(observed).not.toContain("registration-token");
    expect(observed.match(/colima/g)?.length ?? 0).toBe(
      mode === "transfer-failure" ? 1 : 0
    );
  }
);

test.each(["fork", "wrong-sha", "queue-unavailable", "other-queued-commit"])(
  "runner registration is refused for %s",
  async (failure) => {
    if (!jq) {
      throw new Error(
        "jq is required to exercise the actual run metadata check."
      );
    }
    const directory = await hostFixture(35 * 1024 ** 2);
    const events = join(directory, "events");
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
      "gh",
      `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(events)}, JSON.stringify(args) + "\\n");
const mode = ${JSON.stringify(failure)};
const route = args.find(value => value.startsWith("repos/")) ?? "";
if (args[0] === "variable") {
  console.log("atlas-local-ci-amd64");
} else if (route.includes("registration-token")) {
  throw new Error("Registration must not be reached");
} else if (route.includes("/jobs?")) {
  console.log("atlas-local-ci-amd64");
} else if (route.includes("?status=")) {
  if (mode === "queue-unavailable") process.exit(9);
  console.log("456");
} else {
  console.log(JSON.stringify({
    head_sha: mode === "wrong-sha" || route.endsWith("/456") ? "b".repeat(40) : "a".repeat(40),
    head_repository: {full_name: mode === "fork" ? "outsider/atlas" : "kungfufafa/atlas"},
    status: "queued"
  }));
}
`
    );
    const result = await runScript(directory, "ci-local.sh", [
      "run",
      "123",
      "a".repeat(40),
    ]);
    expect(result.exitCode).not.toBe(0);
    const observed = await readFile(events, "utf8");
    expect(observed).not.toContain("registration-token");
    expect(observed).not.toContain("colima");
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

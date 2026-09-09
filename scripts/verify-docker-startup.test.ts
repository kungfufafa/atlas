import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "verify-docker-startup.sh");
const smokeContainerId = "isolated-smoke-container";
const image = "atlas:startup-test";

type Scenario =
  | "healthy"
  | "daemon-unavailable"
  | "image-missing"
  | "unhealthy"
  | "exited"
  | "api-failure"
  | "cleanup-failure"
  | "api-cleanup-failure";

async function runSmoke(scenario: Scenario, platform = "linux/amd64") {
  const directory = await mkdtemp(join(tmpdir(), "atlas-docker-smoke-test-"));
  const callsPath = join(directory, "calls.jsonl");
  await writeFile(
    join(directory, "docker"),
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.SMOKE_TEST_CALLS, JSON.stringify(args) + "\\n");
const scenario = process.env.SMOKE_TEST_SCENARIO;
switch (args[0]) {
  case "info": process.exit(scenario === "daemon-unavailable" ? 1 : 0);
  case "image": process.exit(scenario === "image-missing" ? 1 : 0);
  case "run": console.log("${smokeContainerId}"); break;
  case "inspect":
    if (scenario === "unhealthy") console.log("running unhealthy");
    else if (scenario === "exited") console.log("exited unhealthy");
    else console.log("running healthy");
    break;
  case "exec": process.exit(scenario.startsWith("api-") ? 3 : 0);
  case "logs": console.log("test startup logs"); break;
  case "rm": process.exit(scenario.endsWith("cleanup-failure") ? 1 : 0);
  default: process.exit(2);
}
`,
    { mode: 0o755 }
  );
  try {
    const process = Bun.spawn(["bash", script, image], {
      env: {
        ...Bun.env,
        ATLAS_DOCKER_PLATFORM: platform,
        ATLAS_DOCKER_STARTUP_TIMEOUT: "1",
        PATH: `${directory}:${Bun.env.PATH}`,
        SMOKE_TEST_CALLS: callsPath,
        SMOKE_TEST_SCENARIO: scenario,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    const calls = (await readFile(callsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    return { calls, exitCode, stderr, stdout };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test("Docker smoke isolates data and cleans up only its own container on success", async () => {
  const result = await runSmoke("healthy");
  expect(result.exitCode).toBe(0);
  const run = result.calls.find((call) => call[0] === "run");
  expect(run).toBeDefined();
  expect(run?.slice(-1)).toEqual([image]);
  expect(run?.slice(2, 4)).toEqual(["--platform", "linux/amd64"]);
  expect(run?.slice(4, 8)).toEqual([
    "--network",
    "none",
    "--tmpfs",
    "/atlas/data:rw,uid=1000,gid=1000,mode=0700",
  ]);
  expect(run).not.toContain("--volume");
  expect(run).not.toContain("-v");
  expect(run).not.toContain("--publish");
  expect(run).not.toContain("-p");
  const exec = result.calls.find((call) => call[0] === "exec");
  expect(exec?.slice(0, 3)).toEqual([
    "exec",
    "--interactive",
    smokeContainerId,
  ]);
  expect(result.calls.filter((call) => call[0] === "rm")).toEqual([
    ["rm", "--force", "--volumes", smokeContainerId],
  ]);
  expect(result.calls.some((call) => call[0] === "logs")).toBe(false);
});

test("Docker smoke runs without an optional platform override", async () => {
  const result = await runSmoke("healthy", "");
  expect(result.exitCode).toBe(0);
  expect(result.calls.find((call) => call[0] === "run")).not.toContain(
    "--platform"
  );
});

test.each(["daemon-unavailable", "image-missing"] as const)(
  "Docker smoke fails before creating resources when %s",
  async (scenario) => {
    const result = await runSmoke(scenario);
    expect(result.exitCode).not.toBe(0);
    expect(result.calls.some((call) => call[0] === "run")).toBe(false);
    expect(result.calls.some((call) => call[0] === "rm")).toBe(false);
  }
);

test.each(["unhealthy", "exited", "api-failure"] as const)(
  "Docker smoke reports diagnostics and removes its container after %s",
  async (scenario) => {
    const result = await runSmoke(scenario);
    expect(result.exitCode).not.toBe(0);
    expect(result.calls.filter((call) => call[0] === "logs")).toEqual([
      ["logs", "--tail", "100", smokeContainerId],
    ]);
    expect(result.calls.filter((call) => call[0] === "rm")).toEqual([
      ["rm", "--force", "--volumes", smokeContainerId],
    ]);
    expect(result.calls.some((call) => call[0] === "exec")).toBe(
      scenario === "api-failure"
    );
  }
);

test("Docker smoke fails if cleanup fails after successful verification", async () => {
  expect((await runSmoke("cleanup-failure")).exitCode).toBe(1);
});

test("Docker smoke preserves the original failure when cleanup also fails", async () => {
  expect((await runSmoke("api-cleanup-failure")).exitCode).toBe(3);
});

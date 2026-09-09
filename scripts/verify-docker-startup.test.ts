import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATLAS_API_VERSION } from "../packages/core/src/contract";

const temporaryDirectories: string[] = [];
const projectRoot = join(import.meta.dir, "..");

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

interface ProbeOptions {
  execExitCode?: number;
  healthMode?: string;
  indexStalls?: boolean;
  removalFails?: boolean;
}

async function runControlledDocker(options: ProbeOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-docker-startup-test-"));
  temporaryDirectories.push(directory);
  const eventsPath = join(directory, "events.jsonl");
  const dockerPath = join(directory, "docker");
  // Exercise the actual shell script and its exact inline verifier. Only Docker
  // transport and HTTP responses are controlled here; this is not image proof.
  const fetchFixture = `
import { appendFileSync } from "node:fs";
const record = event => appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + "\\n");
const options = ${JSON.stringify(options)};
const realNow = Date.now;
let ticks = 0;
Date.now = () => realNow() + (ticks++ * 10000);
const stalled = signal => new Promise((resolve, reject) => {
  if (!signal) return;
  signal.addEventListener("abort", () => { record({kind:"abort"}); reject(signal.reason); }, {once:true});
});
globalThis.fetch = async (url, init) => {
  record({kind:"request", url:String(url), hasAbortSignal:!!init?.signal});
  if (String(url).endsWith("/health")) {
    if (options.healthMode === "stalled") return await stalled(init?.signal);
    if (options.healthMode === "html") return new Response("<html>/assets/fake.js</html>", {headers:{"content-type":"text/html"}});
    const status = options.healthMode === "401" ? 401 : options.healthMode === "404" ? 404 : 200;
    return Response.json({ok:true, apiVersion:options.healthMode === "wrong-version" ? ${ATLAS_API_VERSION + 1} : ${ATLAS_API_VERSION}}, {status});
  }
  if (options.indexStalls) return await stalled(init?.signal);
  return new Response("<html><script src=/assets/dashboard.js></script></html>", {headers:{"content-type":"text/html"}});
};
`;
  await writeFile(
    dockerPath,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
const command = process.argv[2];
appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify({kind:"docker", command}) + "\\n");
const options = ${JSON.stringify(options)};
if (command === "exec") {
  if (options.execExitCode) process.exit(options.execExitCode);
  const child = Bun.spawn([process.execPath, "-e", ${JSON.stringify(fetchFixture)} + process.argv.at(-1)], {cwd:${JSON.stringify(projectRoot)}, stdout:"inherit", stderr:"inherit"});
  process.exit(await child.exited);
}
if (command === "rm" && options.removalFails) process.exit(19);
process.exit(0);
`
  );
  await chmod(dockerPath, 0o700);
  const child = Bun.spawn(
    [
      "bash",
      join(projectRoot, "scripts/verify-docker-startup.sh"),
      "controlled-image",
    ],
    {
      cwd: projectRoot,
      env: { ...process.env, PATH: `${directory}:${process.env.PATH ?? ""}` },
      stderr: "pipe",
      stdout: "pipe",
    }
  );
  const deadline = setTimeout(() => child.kill("SIGKILL"), 9000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const events = (await readFile(eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    return { events, exitCode, stderr, stdout };
  } finally {
    clearTimeout(deadline);
  }
}

test("host startup verifier accepts exact health JSON and cleans its container", async () => {
  const result = await runControlledDocker();
  expect(result.exitCode).toBe(0);
  const evidence = JSON.parse(result.stdout.trim());
  expect(evidence.health.apiVersion).toBe(ATLAS_API_VERSION);
  expect(evidence.health.status).toBe(200);
  expect(result.events.filter((event) => event.kind === "request")).toEqual([
    {
      hasAbortSignal: true,
      kind: "request",
      url: "http://127.0.0.1:4310/health",
    },
    { hasAbortSignal: true, kind: "request", url: "http://127.0.0.1:4310/" },
  ]);
  expect(result.events.slice(-2)).toEqual([
    { command: "stop", kind: "docker" },
    { command: "rm", kind: "docker" },
  ]);
});

test.each(["html", "401", "404", "wrong-version", "stalled"])(
  "host startup verifier rejects %s health and still removes its container",
  async (healthMode) => {
    const startedAt = Date.now();
    const result = await runControlledDocker({ healthMode });
    expect(result.exitCode).not.toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(4000);
    expect(result.stdout.trim()).toBe("");
    expect(result.events.at(-1)).toEqual({ command: "rm", kind: "docker" });
    expect(result.events).toContainEqual({
      hasAbortSignal: true,
      kind: "request",
      url: "http://127.0.0.1:4310/health",
    });
    if (healthMode === "stalled") {
      expect(result.events).toContainEqual({ kind: "abort" });
    }
  }
);

test("host startup verifier bounds a stalled dashboard request", async () => {
  const startedAt = Date.now();
  const result = await runControlledDocker({ indexStalls: true });
  expect(result.exitCode).not.toBe(0);
  expect(Date.now() - startedAt).toBeLessThan(8000);
  expect(result.events).toContainEqual({ kind: "abort" });
  expect(result.events.at(-1)).toEqual({ command: "rm", kind: "docker" });
}, 10_000);

test("container removal failure makes an otherwise successful gate fail", async () => {
  const result = await runControlledDocker({ removalFails: true });
  expect(result.exitCode).toBe(1);
  expect(JSON.parse(result.stdout.trim()).status).toBe("passed");
  expect(result.events.at(-1)).toEqual({ command: "rm", kind: "docker" });
  expect(result.stderr.length).toBeGreaterThan(0);
});

test("container cleanup failure preserves the original command failure status", async () => {
  const result = await runControlledDocker({
    execExitCode: 23,
    removalFails: true,
  });
  expect(result.exitCode).toBe(23);
  expect(result.events.at(-1)).toEqual({ command: "rm", kind: "docker" });
  expect(result.stderr.length).toBeGreaterThan(0);
});

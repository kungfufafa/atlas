import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function invokeBoundary(options: {
  fixtureMarker: boolean;
  testEnvironment: boolean;
}) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-worker-boundary-"));
  try {
    if (options.fixtureMarker) {
      await writeFile(
        join(directory, ".channel-loop-mock-runtime.json"),
        JSON.stringify({
          configDir: directory,
          runtime: "CHANNEL_LOOP_SYNTHETIC",
        })
      );
    }
    const script = `
      const {WorkerManagerService} = await import(${JSON.stringify(join(import.meta.dir, "../../apps/server/src/services/worker-manager-service.ts"))});
      let blocked = 0;
      for (const channel of ["telegram", "discord", "whatsapp", "automation"]) {
        try { await WorkerManagerService.prototype.startWorker(channel); }
        catch (error) { if(error.message.includes("mocked channel-loop harness")) blocked += 1; }
      }
      for (const channel of ["telegram", "discord", "whatsapp"]) {
        try { await WorkerManagerService.prototype.startWorkspaceWorker(channel, "fixture_org"); }
        catch (error) { if(error.message.includes("mocked channel-loop harness")) blocked += 1; }
      }
      await WorkerManagerService.prototype.recoverDesiredWorkers();
      console.log(JSON.stringify({blocked}));
      if(blocked !== 7) process.exitCode = 1;
    `;
    const child = Bun.spawn(
      [
        Bun.which("bun") ?? "bun",
        "--preload",
        join(import.meta.dir, "disable-worker-processes.ts"),
        "--eval",
        script,
      ],
      {
        env: {
          ...process.env,
          ATLAS_CONFIG_DIR: directory,
          ATLAS_ENV: options.testEnvironment ? "e2e" : "production",
          NODE_ENV: options.testEnvironment ? "test" : "production",
        },
        stderr: "pipe",
        stdout: "pipe",
      }
    );
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    return { exitCode: await child.exited, stderr, stdout };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

test("explicit synthetic preload blocks every global/scoped worker start and recovery", async () => {
  const result = await invokeBoundary({
    fixtureMarker: true,
    testEnvironment: true,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain('"blocked":7');
  expect(result.stdout).toContain("CHANNEL_LOOP_WORKER_PROCESSES_DISABLED");
});

test("worker preload refuses an unmarked or production runtime", async () => {
  for (const options of [
    { fixtureMarker: false, testEnvironment: true },
    { fixtureMarker: true, testEnvironment: false },
  ]) {
    const result = await invokeBoundary(options);
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain(
      "CHANNEL_LOOP_WORKER_PROCESSES_DISABLED"
    );
  }
});

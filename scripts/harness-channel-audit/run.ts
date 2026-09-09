import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getFreePort } from "../release-gate/free-port";

const repository = resolve(import.meta.dir, "../..");
const directory = await realpath(
  await mkdtemp(join(tmpdir(), "atlas-harness-audit-"))
);
const serverPort = await getFreePort();
const modelPort = await getFreePort();
const environment = {
  ...process.env,
  ATLAS_CONFIG_DIR: join(directory, "state"),
  ATLAS_HARNESS_AUDIT_DIR: directory,
  ATLAS_HARNESS_AUDIT_PORT: String(serverPort),
  ATLAS_HARNESS_MODEL_PORT: String(modelPort),
  ATLAS_HOST: "127.0.0.1",
  ATLAS_PORT: String(serverPort),
};
const server = Bun.spawn(["bun", "run", "apps/server/src/index.ts"], {
  cwd: repository,
  env: environment,
  stderr: Bun.file(join(directory, "server-error.log")),
  stdout: Bun.file(join(directory, "server.log")),
});
const checks: Array<{ id: string; exitCode: number }> = [];

async function runCheck(id: string, command: string[]): Promise<void> {
  const process = Bun.spawn(command, {
    cwd: repository,
    env: environment,
    stderr: Bun.file(join(directory, `${id}-error.log`)),
    stdout: Bun.file(join(directory, `${id}.log`)),
  });
  checks.push({ exitCode: await process.exited, id });
}

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(
        `Isolated server exited ${server.exitCode}. See ${directory}.`
      );
    }
    try {
      const response = await fetch(`http://127.0.0.1:${serverPort}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Startup has a bounded deadline; no service outside localhost is used.
    }
    await Bun.sleep(100);
  }
  throw new Error(`Isolated server did not become ready. See ${directory}.`);
}

try {
  await waitForServer();
  await runCheck("http", [
    "bun",
    "run",
    "scripts/harness-channel-audit/local-http.mjs",
  ]);
  await runCheck("protocol-and-channels", [
    "bun",
    "test",
    "apps/server/src/providers/subscription/chatgpt/structured-harness-persistence.test.ts",
    "apps/server/src/providers/subscription/claude/structured-harness-persistence.test.ts",
    "scripts/channel-loop-harness/channel-loop-harness.test.ts",
    "packages/core/src/tools/schema-defaults.test.ts",
    "packages/core/src/tools/failed-artifacts.test.ts",
    "packages/core/src/channel-artifact-delivery.test.ts",
  ]);
} catch (error) {
  checks.push({ exitCode: 1, id: "setup" });
  await writeFile(join(directory, "setup-error.txt"), String(error));
} finally {
  server.kill("SIGTERM");
  await server.exited;
  await writeFile(
    join(directory, "runner-report.json"),
    JSON.stringify(
      {
        checks,
        evidenceClass:
          "Local real HTTP/SQLite/protected tools; controlled provider and channel transports. No live model or channel claim.",
        limitations: [
          "This repeatable runner does not repeat the historical OS-crash experiment or live browser QA.",
          "Live Claude is not attempted; installed SDK MCP is a controlled protocol fixture.",
        ],
      },
      null,
      2
    )
  );
  console.log(`Audit evidence retained at ${directory}`);
  process.exitCode = checks.some((check) => check.exitCode !== 0) ? 1 : 0;
}

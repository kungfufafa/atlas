import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// A fresh Bun process, outside the native test worker pool, compares startup
// and stdio behavior using only disposable files and a sanitized environment.
const PROBE = String.raw`
const fs = require("node:fs");
const phase = value => fs.writeSync(2, "PHASE:" + value + "\n");
phase("javascript-entered");
const denied = action => { try { action(); return false; } catch (error) { return error.code; } };
const readDenied = denied(() => fs.readFileSync(process.env.CANARY));
phase("read-probed");
const writeDenied = denied(() => fs.writeFileSync(process.env.CANARY, "changed"));
phase("write-probed");
const result = { readDenied, writeDenied, bun: process.versions.bun, node: process.versions.node };
if (process.env.PROBE_PROTOCOL === "1") {
  const input = require("node:readline").createInterface({ input: process.stdin });
  input.on("line", line => {
    phase("stdin-message");
    const message = JSON.parse(line);
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n", () => {
      phase("stdout-flushed");
      process.exit(0);
    });
  });
  phase("stdin-ready");
} else {
  process.stdout.write(JSON.stringify(result) + "\n", () => {
    phase("stdout-flushed");
    process.exit(0);
  });
}
`;

interface Result {
  code: number | null;
  contractError?: string;
  label: string;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
  traceLimitExceeded: boolean;
}

function assertDenied(stdout: string): void {
  const payload = JSON.parse(stdout);
  const probe = payload.result ?? payload;
  if (
    !(
      ["EACCES", "EPERM"].includes(probe.readDenied) &&
      ["EACCES", "EPERM"].includes(probe.writeDenied)
    )
  ) {
    throw new Error("Synthetic read/write probes were not both denied");
  }
}

async function collect(
  label: string,
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  output: string,
  trace: string | null
): Promise<Result> {
  const traceArgs = trace
    ? [
        "-ff",
        "--kill-on-exit",
        "-qq",
        "-s",
        "160",
        "-e",
        "trace=%file,%process,read,write,epoll_ctl,fcntl",
        "-o",
        path.join(output, `${label}.strace`),
        command,
        ...args,
      ]
    : [...args];
  const result = await new Promise<Result>((resolve, reject) => {
    const child = spawn(trace ?? command, traceArgs, {
      cwd,
      detached: true,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let traceLimitExceeded = false;
    const stopGroup = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            throw error;
          }
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stopGroup();
    }, 8000);
    let checkingTrace = false;
    const traceTimer = trace
      ? setInterval(async () => {
          if (checkingTrace) {
            return;
          }
          checkingTrace = true;
          try {
            const files = (await readdir(output)).filter((name) =>
              name.startsWith(`${label}.strace`)
            );
            const sizes = await Promise.all(
              files.map(
                async (name) => (await stat(path.join(output, name))).size
              )
            );
            if (
              sizes.reduce((total, size) => total + size, 0) >
              16 * 1024 * 1024
            ) {
              traceLimitExceeded = true;
              stopGroup();
            }
          } finally {
            checkingTrace = false;
          }
        }, 100)
      : undefined;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 32_768) {
        stopGroup();
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 32_768) {
        stopGroup();
      }
    });
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      clearTimeout(timer);
      clearInterval(traceTimer);
      stopGroup();
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearInterval(traceTimer);
      stopGroup();
      resolve({
        code,
        label,
        signal,
        stderr,
        stdout,
        timedOut,
        traceLimitExceeded,
      });
    });
    child.stdin.end('{"jsonrpc":"2.0","id":1,"method":"probe"}\n');
  });
  await writeFile(path.join(output, `${label}.json`), JSON.stringify(result));
  console.log(JSON.stringify(result));
  return result;
}

async function skillChild(): Promise<void> {
  const { discoverSkillDirectory } = await import(
    "../packages/core/src/skills/discover"
  );
  const { getProfileSoulDir } = await import(
    "../packages/core/src/soul/resolve"
  );
  const { runWithUserConfigDir } = await import(
    "../packages/core/src/user-config"
  );
  const { createSkillToolRuntime } = await import(
    "../apps/server/src/services/skill-tool-runtime"
  );
  const root = process.env.ATLAS_CONFIG_DIR!;
  await runWithUserConfigDir(root, async () => {
    const workspaceRoot = getProfileSoulDir("diagnostic", "probe");
    const directory = path.join(workspaceRoot, "skills", "probe");
    await mkdir(directory, { recursive: true });
    const canary = path.join(root, "skill-canary");
    await writeFile(canary, "synthetic-only");
    await writeFile(
      path.join(directory, "SKILL.md"),
      "---\nname: probe\ndescription: Diagnostic\n---\nProbe.\n"
    );
    const source = `export async function run(input) {
      const fs = require("node:fs");
      fs.writeSync(2, "PHASE:skill-run-entered\\n");
      let child;
      try {
        child = Bun.spawn([process.execPath, "--no-install", "--no-addons", "-e", ${JSON.stringify(PROBE)}], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, CANARY: input.canary, PROBE_PROTOCOL: "0" } });
      } catch (error) {
        if (error.code === "EPERM" || error.code === "EACCES") return { spawnDenied: error.code };
        throw error;
      }
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { stdout, stderr, code };
    }`;
    await writeFile(path.join(directory, "tool.ts"), source);
    const skill = await discoverSkillDirectory(directory);
    if (!skill) {
      throw new Error("Diagnostic skill was not discovered");
    }
    const tool = await createSkillToolRuntime({
      onAdmission: (entry) => {
        console.error(`PHASE:skill-${entry.phase}-prepared`);
      },
      orgId: "diagnostic",
      profileId: "probe",
      requireSandbox: true,
    }).load(skill);
    console.error("PHASE:skill-metadata-complete");
    const result = (await tool.run(
      { canary },
      {
        orgId: "diagnostic",
        profileId: "probe",
        signal: AbortSignal.timeout(5000),
        workspaceRoot,
      }
    )) as {
      code: number;
      spawnDenied?: string;
      stderr: string;
      stdout: string;
    };
    console.log(
      JSON.stringify({ canary: await readFile(canary, "utf8"), result })
    );
    if ((await readFile(canary, "utf8")) !== "synthetic-only") {
      throw new Error("Skill descendant changed the synthetic canary");
    }
    if (["EPERM", "EACCES"].includes(result.spawnDenied ?? "")) {
      return;
    }
    if (result.code !== 0) {
      throw new Error(
        `Skill descendant exited ${result.code}: ${result.stderr}`
      );
    }
    assertDenied(result.stdout);
  });
}

async function main(): Promise<void> {
  if (process.platform !== "linux") {
    throw new Error("This diagnostic requires actual Linux execution.");
  }
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "atlas-confinement-diagnostic-"))
  );
  const output = path.resolve(
    process.env.ATLAS_CONFINEMENT_DIAGNOSTIC_DIR ?? `${root}-logs`
  );
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  await mkdir(output, { recursive: true });
  process.env.ATLAS_CONFIG_DIR = root;
  const { createRestrictedProcessPreparer } = await import(
    "../apps/server/src/services/restricted-process"
  );
  const prepare = createRestrictedProcessPreparer({
    launchPolicy: "mcp_stdio",
  });
  const canary = path.join(root, "canary");
  const script = path.join(workspace, "probe.cjs");
  await writeFile(script, PROBE);
  const node = Bun.which("node");
  const trace = Bun.which("strace");
  const baseEnv: NodeJS.ProcessEnv = {
    ATLAS_BUN_BIN: process.execPath,
    ATLAS_CONFIG_DIR: root,
    ATLAS_CUSTOM_TOOL_TIMEOUT_MS: "4000",
    CANARY: canary,
    HOME: root,
    LANG: "C.UTF-8",
    PATH: [
      path.dirname(process.execPath),
      ...(node ? [path.dirname(node)] : []),
      "/usr/bin",
      "/bin",
    ].join(path.delimiter),
    TMPDIR: root,
  };
  const isolated = [
    "--config=/dev/null",
    "--env-file=/dev/null",
    "--no-install",
    "--no-addons",
  ];
  const results: Result[] = [];
  console.log(
    JSON.stringify({
      bun: Bun.version,
      output,
      phase: "diagnostic-start",
      strace: Boolean(trace),
    })
  );
  try {
    for (const traced of [false, true]) {
      if (traced && !trace) {
        continue;
      }
      for (const scenario of [
        {
          args: [...isolated, "-e", PROBE],
          command: process.execPath,
          confined: false,
          label: "raw-bun-eval",
          protocol: false,
        },
        {
          args: ["--no-install", "--no-addons", "-e", PROBE],
          command: process.execPath,
          confined: true,
          label: "confined-bun-eval",
          protocol: false,
        },
        {
          args: [...isolated, "-e", PROBE],
          command: process.execPath,
          confined: true,
          label: "confined-bun-isolated-eval",
          protocol: false,
        },
        {
          args: [...isolated, script],
          command: process.execPath,
          confined: true,
          label: "confined-bun-file",
          protocol: false,
        },
        {
          args: [...isolated, "-e", PROBE],
          command: process.execPath,
          confined: true,
          label: "confined-bun-stdio",
          protocol: true,
        },
        ...(node
          ? [
              {
                args: ["-e", PROBE],
                command: node,
                confined: true,
                label: "confined-node-stdio",
                protocol: true,
              },
            ]
          : []),
      ]) {
        await writeFile(canary, "synthetic-only");
        const env = {
          ...baseEnv,
          PROBE_PROTOCOL: scenario.protocol ? "1" : "0",
        };
        const prepared = scenario.confined
          ? await prepare({
              args: scenario.args,
              bin: scenario.command,
              env,
              workspaceRoot: workspace,
            })
          : undefined;
        try {
          const result = await collect(
            `${scenario.label}${traced ? "-traced" : ""}`,
            prepared?.bin ?? scenario.command,
            prepared?.args ?? scenario.args,
            prepared?.cwd ?? workspace,
            prepared?.env ?? env,
            output,
            traced ? trace : null
          );
          results.push(result);
          try {
            if (scenario.confined && result.code === 0) {
              assertDenied(result.stdout);
              if (
                scenario.label === "confined-node-stdio" &&
                JSON.parse(result.stdout).result.bun
              ) {
                throw new Error("Node comparison resolved to Bun");
              }
            }
            if (
              scenario.confined &&
              (await readFile(canary, "utf8")) !== "synthetic-only"
            ) {
              throw new Error("Synthetic canary changed across confinement");
            }
          } catch (error) {
            result.contractError = String(error);
            await writeFile(
              path.join(output, `${result.label}.json`),
              JSON.stringify(result)
            );
            console.error(
              JSON.stringify({
                error: String(error),
                label: result.label,
                phase: "contract-failed",
              })
            );
          }
        } finally {
          await prepared?.cleanup();
        }
      }
      results.push(
        await collect(
          `skill-descendant${traced ? "-traced" : ""}`,
          process.execPath,
          [...isolated, import.meta.path, "--skill-child"],
          workspace,
          baseEnv,
          output,
          traced ? trace : null
        )
      );
    }
    process.exitCode = results.some(
      (result) =>
        result.code !== 0 ||
        result.timedOut ||
        result.traceLimitExceeded ||
        result.contractError
    )
      ? 1
      : 0;
  } finally {
    await rm(root, { force: true, recursive: true });
    console.log(
      JSON.stringify({
        cases: results.length,
        output,
        phase: "diagnostic-finished",
      })
    );
  }
}

if (process.argv.includes("--skill-child")) {
  await skillChild();
} else {
  await main();
}

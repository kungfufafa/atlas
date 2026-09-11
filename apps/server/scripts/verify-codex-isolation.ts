import assert from "node:assert/strict";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSubscriptionLaunch } from "../src/providers/subscription/binary";
import {
  CodexAppServer,
  codexAppServerArguments,
  initializeCodexClient,
} from "../src/providers/subscription/chatgpt/app-server";
import {
  buildSubscriptionRuntimeEnv,
  subscriptionRuntimeHome,
} from "../src/providers/subscription/env";
import {
  JsonRpcStdioClient,
  spawnJsonRpcProcess,
} from "../src/providers/subscription/jsonrpc-stdio";

const launch = resolveSubscriptionLaunch("chatgpt");
assert.ok(launch, "The bundled Codex runtime must be installed");
const temporaryHome = await realpath(
  await mkdtemp(join(tmpdir(), "atlas-codex-isolation-"))
);
const providerHome = subscriptionRuntimeHome("chatgpt", {
  ATLAS_CONFIG_DIR: temporaryHome,
});
const cwd = join(temporaryHome, "profile");
await mkdir(providerHome, { recursive: true });
await mkdir(cwd, { recursive: true });
const marker = join(temporaryHome, "native-mcp-started");
const fixtureScript = join(temporaryHome, "fixture-mcp.js");
await writeFile(
  fixtureScript,
  `await Bun.write(${JSON.stringify(marker)}, "started");`
);
const mcpConfig = `[mcp_servers.fixture]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(fixtureScript)}]\nstartup_timeout_sec=1\n`;
const configPath = join(providerHome, "config.toml");
const features = Object.fromEntries(
  codexAppServerArguments()
    .filter((arg) => arg.startsWith("features."))
    .map((arg) => [arg.slice("features.".length).split("=")[0], false])
);

function makeClient(): JsonRpcStdioClient {
  assert.ok(launch);
  return new JsonRpcStdioClient(
    spawnJsonRpcProcess(
      launch.command,
      [...launch.prefixArgs, ...codexAppServerArguments()],
      buildSubscriptionRuntimeEnv("chatgpt", {
        ATLAS_CONFIG_DIR: temporaryHome,
      }) as NodeJS.ProcessEnv
    )
  );
}

async function markerExists(): Promise<boolean> {
  try {
    await access(marker);
    return true;
  } catch {
    return false;
  }
}

async function verifyCleanStartup(): Promise<void> {
  const client = makeClient();
  const server = new CodexAppServer({ client });
  try {
    assert.equal(await initializeCodexClient(client), "0.150.1");
    const response = (await client.request("config/read", {
      cwd,
      includeLayers: false,
    })) as {
      config: {
        approval_policy: string;
        sandbox_mode: string;
        features: Record<string, boolean>;
        web_search: string;
      };
    };
    for (const feature of Object.keys(features)) {
      assert.equal(
        response.config.features[feature],
        false,
        `${feature} must be disabled before a thread starts`
      );
    }
    assert.equal(response.config.sandbox_mode, "read-only");
    assert.equal(response.config.approval_policy, "never");
    assert.equal(response.config.web_search, "disabled");
    assert.ok(await server.startThread({ cwd, ephemeral: true }));
    assert.equal(await markerExists(), false);
  } finally {
    server.close();
  }
}

async function verifyConfiguredMcpBlocked(label: string): Promise<void> {
  const originalConfig = await readFile(configPath, "utf8");
  const client = makeClient();
  const server = new CodexAppServer({ client });
  try {
    await initializeCodexClient(client);
    await assert.rejects(
      server.startThread({ cwd, ephemeral: true }),
      /Native Codex MCP/
    );
    await assert.rejects(
      server.resumeThread("never-started", { cwd }),
      /Native Codex MCP/
    );
    await Bun.sleep(1200);
    assert.equal(
      await markerExists(),
      false,
      `${label}: guarded start/resume must not launch native MCP`
    );
    assert.equal(
      await readFile(configPath, "utf8"),
      originalConfig,
      "Preflight must preserve operator configuration"
    );
    // Positive control: prove the same harmless local fixture executes if callers
    // bypass Atlas's guard. No login, provider turn, or external request is used.
    await client.request("thread/start", {
      approvalPolicy: "never",
      config: { features, web_search: "disabled" },
      cwd,
      ephemeral: true,
      sandbox: "read-only",
    });
    for (
      let attempt = 0;
      attempt < 40 && !(await markerExists());
      attempt += 1
    ) {
      await Bun.sleep(50);
    }
    assert.equal(
      await markerExists(),
      true,
      `${label}: unguarded canary must be executable`
    );
    console.info(
      `${label}: guarded start/resume blocked native MCP; positive control verified.`
    );
  } finally {
    server.close();
    await Bun.sleep(100);
    await rm(marker, { force: true });
  }
}

async function verifyLateProjectConfig(): Promise<void> {
  const projectConfig = join(cwd, ".codex", "config.toml");
  await rm(projectConfig);
  const client = makeClient();
  const server = new CodexAppServer({ client });
  try {
    await initializeCodexClient(client);
    const request = client.request.bind(client);
    client.request = async (method, params) => {
      const result = await request(method, params);
      if (method === "config/read") {
        // Reproduce a concurrent workspace tool writing native project config
        // in the gap between Atlas's inspection and native thread startup.
        await writeFile(projectConfig, mcpConfig);
      }
      return result;
    };
    assert.ok(await server.startThread({ cwd, ephemeral: true }));
    await Bun.sleep(1200);
    assert.equal(
      await markerExists(),
      false,
      "Late project config must remain untrusted during native startup"
    );
    console.info(
      "Concurrent profile config: native project override prevented MCP startup after preflight."
    );
  } finally {
    server.close();
  }
}

try {
  await verifyCleanStartup();
  await writeFile(configPath, mcpConfig);
  await verifyConfiguredMcpBlocked("Populated runtime home");
  await writeFile(
    configPath,
    `[projects.${JSON.stringify(cwd)}]\ntrust_level="trusted"\n`
  );
  await mkdir(join(cwd, ".codex"));
  await writeFile(join(cwd, ".codex", "config.toml"), mcpConfig);
  await verifyConfiguredMcpBlocked("Trusted profile workspace");
  await verifyLateProjectConfig();
  console.info(
    "Codex 0.150.1 isolation verified with temporary homes. No account login or provider turn was started."
  );
} finally {
  await Bun.sleep(100);
  await rm(temporaryHome, { force: true, recursive: true });
}

import { expect, test } from "bun:test";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getProfileSoulDir,
  type McpStdioConfig,
  runWithUserConfigDir,
} from "@atlas/core";
import {
  createInMemoryDatabaseAdapter,
  type StoredMcpServerRecord,
} from "@atlas/db";
import { McpClientManager } from "./mcp-client-manager";
import { McpService } from "./mcp-service";
import { prepareMcpStdioTransport } from "./mcp-stdio-runtime";

const MCP_FIXTURE = String.raw`
const fs = require('node:fs');
const readline = require('node:readline');
const denied = (f) => { try { f(); return false; } catch { return true; } };
// Never read sensitive file contents or return proc directory entries.
const procOpenError = (target, directory = false) => {
  try {
    if (directory) {
      const dir = fs.opendirSync(target);
      try { dir.readSync(); } finally { dir.closeSync(); }
    } else fs.closeSync(fs.openSync(target, 'r'));
    return null;
  } catch (error) { return error.code; }
};
const procProbe = () => process.platform === 'linux' ? {
  selfMapsReadable: !denied(() => { if (!fs.readFileSync('/proc/self/maps').length) throw new Error('Empty maps'); }),
  selfEnvironError: procOpenError('/proc/self/environ'),
  parentMapsError: procOpenError('/proc/' + process.env.FIXTURE_PARENT_PID + '/maps'),
  parentEnvironError: procOpenError('/proc/' + process.env.FIXTURE_PARENT_PID + '/environ'),
  parentDescriptorsError: procOpenError('/proc/' + process.env.FIXTURE_PARENT_PID + '/fd', true),
} : null;
const probe = () => ({
  readDenied: denied(() => fs.readFileSync(process.env.CANARY)),
  writeDenied: denied(() => fs.writeFileSync(process.env.CANARY, 'CHANGED')),
  linkDenied: denied(() => fs.readFileSync('linked-canary')),
  cwd: process.cwd(), home: process.env.HOME,
  custom: process.env.FIXTURE_CREDENTIAL,
  runtime: { node: process.versions.node, bun: process.versions.bun ?? null },
  proc: procProbe(),
});
const initial = probe();
const rl = readline.createInterface({input: process.stdin});
rl.on('line', line => {
  const message = JSON.parse(line);
  if (!('id' in message)) return;
  let result;
  if (message.method === 'initialize') result = {protocolVersion: message.params.protocolVersion, capabilities: {tools: {}}, serverInfo: {name:'fixture',version:'1'}};
  if (message.method === 'tools/list') result = {tools:[{name:'probe', description:JSON.stringify(initial), inputSchema:{type:'object',properties:{}}}]};
  if (message.method === 'tools/call') {
    fs.writeFileSync('allowed.txt','workspace write');
    if (process.env.HOME !== process.env.FIXTURE_HOST_HOME) fs.writeFileSync(process.env.HOME + '/mcp-fixture-temp','temporary write');
    result = {content:[], structuredContent:{initial, current:probe()}};
  }
  process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:message.id, result})+'\n', () => { if (message.params?.arguments?.shutdown) process.exit(0); });
});
`;

interface Probe {
  custom: string;
  cwd: string;
  home: string;
  linkDenied: boolean;
  proc: {
    parentDescriptorsError: string | null;
    parentEnvironError: string | null;
    parentMapsError: string | null;
    selfEnvironError: string | null;
    selfMapsReadable: boolean;
  } | null;
  readDenied: boolean;
  runtime: { node: string; bun: string | null };
  writeDenied: boolean;
}

async function withFixture(
  run: (
    server: StoredMcpServerRecord & { config: McpStdioConfig },
    workspace: string,
    canary: string
  ) => Promise<void>
): Promise<void> {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "atlas-mcp-confinement-"))
  );
  try {
    await runWithUserConfigDir(root, async () => {
      const workspace = getProfileSoulDir("fixture-org", "active");
      const canary = path.join(
        getProfileSoulDir("fixture-org", "sibling"),
        "canary.txt"
      );
      await mkdir(workspace, { recursive: true });
      await mkdir(path.dirname(canary), { recursive: true });
      await writeFile(canary, "SYNTHETIC MCP CANARY");
      await symlink(canary, path.join(workspace, "linked-canary"));
      const now = new Date().toISOString();
      const server: StoredMcpServerRecord & { config: McpStdioConfig } = {
        cachedTools: [],
        config: {
          args: ["--no-install", "--no-addons", "-e", MCP_FIXTURE],
          command: process.execPath,
          env: {
            CANARY: canary,
            FIXTURE_CREDENTIAL: "synthetic-server-token",
            FIXTURE_HOST_HOME: os.homedir(),
            FIXTURE_PARENT_PID: String(process.pid),
          },
        },
        createdAt: now,
        enabled: true,
        id: "mcp-fixture",
        lastError: null,
        name: "fixture",
        orgId: "fixture-org",
        status: "disconnected",
        transport: "stdio",
        updatedAt: now,
      };
      await run(server, workspace, canary);
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

test("MCP discovery initialization cannot read or mutate sibling tenant files", async () => {
  await withFixture(async (server, _workspace, canary) => {
    const manager = new McpClientManager();
    const tools = await manager.testConnection("stdio", server.config);
    const initial: Probe = JSON.parse(tools[0]!.description);
    expect(initial.readDenied).toBe(true);
    expect(initial.writeDenied).toBe(true);
    expect(typeof initial.home).toBe("string");
    expect(initial.home).not.toBe(os.homedir());
    expect(initial.cwd).not.toBe(process.cwd());
    await expect(access(initial.home)).rejects.toThrow();
    await expect(access(initial.cwd)).rejects.toThrow();
    expect(initial.custom).toBe("synthetic-server-token");
    expect(await readFile(canary, "utf8")).toBe("SYNTHETIC MCP CANARY");
  });
});

if (process.platform === "linux") {
  test("MCP Bun can read its own stack maps while sensitive and parent proc access stays denied", async () => {
    await withFixture(async (server, _workspace, canary) => {
      const manager = new McpClientManager();
      try {
        await manager.connect(server, {
          orgId: "fixture-org",
          profileId: "active",
        });
        const result = (await manager.callTool(
          server.id,
          "stdio",
          "probe",
          {},
          "active",
          "fixture-org"
        )) as { initial: Probe; current: Probe };
        for (const phase of [result.initial, result.current]) {
          expect(phase.runtime.bun).toBe(Bun.version);
          expect(phase.proc?.selfMapsReadable).toBe(true);
          for (const [permission, error] of Object.entries({
            parentDescriptors: phase.proc?.parentDescriptorsError,
            parentEnviron: phase.proc?.parentEnvironError,
            parentMaps: phase.proc?.parentMapsError,
            selfEnviron: phase.proc?.selfEnvironError,
          })) {
            expect(["EACCES", "EPERM"], permission).toContain(error);
          }
          expect(phase.readDenied).toBe(true);
          expect(phase.writeDenied).toBe(true);
        }
        expect(await readFile(canary, "utf8")).toBe("SYNTHETIC MCP CANARY");
      } finally {
        await manager.disconnectAll();
      }
    });
  });
}

test("MCP connected calls keep permitted workspace effects and deny sibling bytes", async () => {
  await withFixture(async (server, workspace, canary) => {
    const manager = new McpClientManager();
    let privateHome: string | undefined;
    try {
      await manager.connect(server, {
        orgId: "fixture-org",
        profileId: "active",
      });
      const result = (await manager.callTool(
        server.id,
        "stdio",
        "probe",
        {},
        "active",
        "fixture-org"
      )) as { initial: Probe; current: Probe };
      privateHome = result.current.home;
      expect(typeof privateHome).toBe("string");
      expect(
        await readFile(path.join(privateHome!, "mcp-fixture-temp"), "utf8")
      ).toBe("temporary write");
      expect(result.initial.readDenied).toBe(true);
      expect(result.initial.writeDenied).toBe(true);
      expect(result.current.readDenied).toBe(true);
      expect(result.current.writeDenied).toBe(true);
      expect(result.current.linkDenied).toBe(true);
      expect(result.current.cwd).toBe(workspace);
      expect(result.current.custom).toBe("synthetic-server-token");
      expect(await readFile(path.join(workspace, "allowed.txt"), "utf8")).toBe(
        "workspace write"
      );
      expect(await readFile(canary, "utf8")).toBe("SYNTHETIC MCP CANARY");
    } finally {
      await manager.disconnectAll();
    }
    expect(manager.getConnectedCount()).toBe(0);
    if (privateHome) {
      await expect(access(privateHome)).rejects.toThrow();
    }
  });
});

for (const key of [
  "LD_PRELOAD",
  "DYLD_INSERT_LIBRARIES",
  "NODE_OPTIONS",
  "NODE_PATH",
  "BUN_OPTIONS",
  "ATLAS_RESTRICTED_ARG_0",
]) {
  test(`MCP rejects ${key} before initialization`, async () => {
    await withFixture(async (_server, workspace, canary) => {
      const manager = new McpClientManager();
      await expect(
        manager.testConnection("stdio", {
          args: ["-c", 'printf changed > "$MCP_MARKER"'],
          command: "/bin/sh",
          env: { [key]: "synthetic-loader-setting", MCP_MARKER: canary },
        })
      ).rejects.toThrow();
      expect(await readFile(canary, "utf8")).toBe("SYNTHETIC MCP CANARY");
      await expect(
        access(path.join(workspace, "allowed.txt"))
      ).rejects.toThrow();
    });
  });
}

test("MCP rejects a redirected profile root before running configured code", async () => {
  await withFixture(async (server, workspace, canary) => {
    await rm(workspace, { force: true, recursive: true });
    await symlink(path.dirname(canary), workspace);
    const manager = new McpClientManager();
    await expect(
      manager.connect(server, { orgId: "fixture-org", profileId: "active" })
    ).rejects.toThrow();
    expect(await readFile(canary, "utf8")).toBe("SYNTHETIC MCP CANARY");
    expect(manager.getConnectedCount()).toBe(0);
  });
});

test("MCP admission rejects a different organization and traversal profile", async () => {
  await withFixture(async (server, _workspace, canary) => {
    const manager = new McpClientManager();
    await expect(
      manager.connect(server, { orgId: "different", profileId: "active" })
    ).rejects.toThrow();
    await expect(
      manager.connect(server, { orgId: "fixture-org", profileId: "../sibling" })
    ).rejects.toThrow();
    expect(manager.getConnectedCount()).toBe(0);
    expect(await readFile(canary, "utf8")).toBe("SYNTHETIC MCP CANARY");
  });
});

test("MCP prepared discovery cleanup is idempotent without starting a process", async () => {
  await withFixture(async (_server, _workspace, canary) => {
    const prepared = await prepareMcpStdioTransport({
      args: ["-c", "exit 0"],
      command: "/bin/sh",
    });
    await prepared.cleanup();
    await prepared.cleanup();
    expect(await readFile(canary, "utf8")).toBe("SYNTHETIC MCP CANARY");
  });
});

test("MCP service create and test both confine code before tool invocation", async () => {
  await withFixture(async (server, _workspace, canary) => {
    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();
    await db.upsertOrganization({
      createdAt: now,
      id: "fixture-org",
      name: "fixture",
      slug: "fixture",
      updatedAt: now,
    });
    const manager = new McpClientManager();
    const service = new McpService(db, manager);
    try {
      const created = await service.createServer("fixture-org", {
        config: server.config,
        name: "probe",
        transport: "stdio",
      });
      const initial: Probe = JSON.parse(
        created.server.cachedTools[0]!.description
      );
      expect(initial.readDenied).toBe(true);
      expect(initial.writeDenied).toBe(true);
      expect(initial.custom).toBe("synthetic-server-token");
      const tested = await service.testServer(
        "fixture-org",
        "stdio",
        server.config
      );
      expect(tested.ok).toBe(true);
      const testedInitial: Probe = JSON.parse(tested.tools[0]!.description);
      expect(testedInitial.readDenied).toBe(true);
      expect(testedInitial.writeDenied).toBe(true);
      expect(await readFile(canary, "utf8")).toBe("SYNTHETIC MCP CANARY");
    } finally {
      await manager.disconnectAll();
    }
  });
});

test("MCP natural process exit evicts the cached connection and releases its temporary home", async () => {
  await withFixture(async (server, _workspace, canary) => {
    const manager = new McpClientManager();
    try {
      await manager.connect(server, {
        orgId: "fixture-org",
        profileId: "active",
      });
      const result = (await manager.callTool(
        server.id,
        "stdio",
        "probe",
        { shutdown: true },
        "active",
        "fixture-org"
      )) as { current: Probe };
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (manager.getConnectedCount() === 0) {
          break;
        }
        await Bun.sleep(10);
      }
      expect(manager.getConnectedCount()).toBe(0);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (
          !(await Bun.file(
            path.join(result.current.home, "mcp-fixture-temp")
          ).exists())
        ) {
          break;
        }
        await Bun.sleep(10);
      }
      await expect(access(result.current.home)).rejects.toThrow();
      expect(await readFile(canary, "utf8")).toBe("SYNTHETIC MCP CANARY");
    } finally {
      await manager.disconnectAll();
    }
  });
});

test("MCP Node runtime preserves configured credentials and confines real file effects", async () => {
  await withFixture(async (server, workspace, canary) => {
    const manager = new McpClientManager();
    const nodeServer = {
      ...server,
      config: { ...server.config, args: ["-e", MCP_FIXTURE], command: "node" },
    };
    try {
      await manager.connect(nodeServer, {
        orgId: "fixture-org",
        profileId: "active",
      });
      const result = (await manager.callTool(
        server.id,
        "stdio",
        "probe",
        {},
        "active",
        "fixture-org"
      )) as { initial: Probe; current: Probe };
      expect(
        result.initial.runtime,
        "The MCP Node fixture requires genuine Node.js on PATH; a Bun shim is not Node.js."
      ).toMatchObject({ bun: null, node: expect.any(String) });
      expect(result.initial.readDenied).toBe(true);
      expect(result.initial.writeDenied).toBe(true);
      expect(result.current.linkDenied).toBe(true);
      expect(result.current.custom).toBe("synthetic-server-token");
      expect(result.current.cwd).toBe(workspace);
      expect(await readFile(path.join(workspace, "allowed.txt"), "utf8")).toBe(
        "workspace write"
      );
      expect(await readFile(canary, "utf8")).toBe("SYNTHETIC MCP CANARY");
    } finally {
      await manager.disconnectAll();
    }
  });
});

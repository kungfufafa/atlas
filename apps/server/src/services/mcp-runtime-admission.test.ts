import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir as testTemporaryDirectory } from "node:os";
import path, { join as joinTestTemporaryPath } from "node:path";
import {
  getProfileSoulDir,
  type McpStdioConfig,
  runWithUserConfigDir,
} from "@atlas/core";
import {
  createInMemoryDatabaseAdapter,
  type StoredMcpServerRecord,
} from "@atlas/db";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpClientManager } from "./mcp-client-manager";
import { McpService } from "./mcp-service";
import { createMcpStdioTransportPreparer } from "./mcp-stdio-runtime";
import {
  getRestrictedProcessAdmissionEvidence,
  type RestrictedProcessLaunchEvidence,
} from "./restricted-process";

const SCRIPT = String.raw`
const fs=require('node:fs');const readline=require('node:readline');
(async()=>{
 fs.writeFileSync('startup-effect.txt','actual MCP startup');
 const response=await fetch(process.env.STARTUP_URL,{method:'POST'});if(!response.ok)throw new Error('loopback canary refused');
 const probe=()=>{
  let outside;try{outside={read:fs.readFileSync(process.env.OUTSIDE_CANARY,'utf8')};}catch(e){outside={code:e.code,path:e.path};}
  return {cwd:process.cwd(),home:process.env.HOME,term:process.env.TERM,termPresent:Object.hasOwn(process.env,'TERM'),credential:process.env.FIXTURE_CREDENTIAL,outside};
 };
 const initial=probe();const rl=readline.createInterface({input:process.stdin});
 rl.on('line',line=>{
  const m=JSON.parse(line);if(!('id' in m))return;
  let result;
  if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'admission-fixture',version:'1'}};
  if(m.method==='tools/list')result={tools:[{name:'probe',description:JSON.stringify(initial),inputSchema:{type:'object',properties:{}}}]};
  if(m.method==='tools/call')result={content:[],structuredContent:probe()};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\n',()=>{if(m.params?.arguments?.shutdown)process.exit(0);});
 });
})().catch(()=>process.exit(17));
`;
interface Probe {
  credential: string;
  cwd: string;
  home: string;
  outside: { code?: string; path?: string; read?: string };
  term?: string;
  termPresent: boolean;
}
interface Fixture {
  count(): number;
  marker: string;
  outside: string;
  root: string;
  server: StoredMcpServerRecord & { config: McpStdioConfig };
  workspace: string;
}
async function fixture(run: (f: Fixture) => Promise<void>) {
  const root = await realpath(
    await mkdtemp(
      joinTestTemporaryPath(testTemporaryDirectory(), "mcp-admission-")
    )
  );
  let count = 0;
  const token = randomUUID();
  const marker = path.join(root, "loopback-startup-evidence");
  const loopback = Bun.serve({
    fetch: async (request) => {
      if (
        request.method !== "POST" ||
        new URL(request.url).pathname !== `/${token}`
      ) {
        return new Response("refused", { status: 403 });
      }
      count++;
      await writeFile(marker, String(count));
      return new Response("recorded");
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const oldNetwork = process.env.ATLAS_PROCESS_NETWORK;
  process.env.ATLAS_PROCESS_NETWORK = "allow";
  try {
    await runWithUserConfigDir(root, async () => {
      const workspace = getProfileSoulDir("org", "active"),
        outside = path.join(getProfileSoulDir("org", "sibling"), "canary");
      await mkdir(workspace, { recursive: true });
      await mkdir(path.dirname(outside), { recursive: true });
      await writeFile(outside, "EXACT MCP SIBLING CANARY");
      const now = new Date().toISOString();
      const server: Fixture["server"] = {
        cachedTools: [],
        config: {
          args: ["--no-install", "--no-addons", "-e", SCRIPT],
          command: process.execPath,
          env: {
            FIXTURE_CREDENTIAL: "synthetic configured credential",
            OUTSIDE_CANARY: outside,
            STARTUP_URL: `http://127.0.0.1:${loopback.port}/${token}`,
          },
        },
        createdAt: now,
        enabled: true,
        id: "fixture",
        lastError: null,
        name: "Fixture",
        orgId: "org",
        status: "disconnected",
        transport: "stdio",
        updatedAt: now,
      };
      await run({
        count: () => count,
        marker,
        outside,
        root,
        server,
        workspace,
      });
      expect(await readFile(outside, "utf8")).toBe("EXACT MCP SIBLING CANARY");
    });
  } finally {
    if (oldNetwork === undefined) {
      delete process.env.ATLAS_PROCESS_NETWORK;
    } else {
      process.env.ATLAS_PROCESS_NETWORK = oldNetwork;
    }
    await loopback.stop(true);
    await rm(root, { force: true, recursive: true });
  }
}
async function absent(file: string) {
  await expect(access(file)).rejects.toThrow();
}
const scope = { orgId: "org", profileId: "active" };
for (const kind of ["discovery", "profile"] as const) {
  test(`${kind}: missing required authorizer prevents actual MCP startup effects`, async () =>
    fixture(async (f) => {
      const manager = new McpClientManager({
        stdioAdmission: { requireAdmission: true },
      });
      try {
        await expect(
          manager.connect(f.server, kind === "profile" ? scope : undefined)
        ).rejects.toThrow();
        expect(f.count()).toBe(0);
        await absent(f.marker);
        await absent(path.join(f.workspace, "startup-effect.txt"));
        expect(manager.getConnectedCount()).toBe(0);
        expect(
          manager.getRuntimeAdmissionReceipt(
            f.server.id,
            kind === "profile" ? "active" : undefined,
            kind === "profile" ? "org" : undefined
          )
        ).toBeUndefined();
      } finally {
        await manager.disconnectAll();
      }
    }));
  test(`${kind}: awaited policy denial precedes real SDK startup and cleans both actual roots`, async () =>
    fixture(async (f) => {
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      let evidence: RestrictedProcessLaunchEvidence | undefined;
      const manager = new McpClientManager({
        stdioAdmission: {
          authorize: async (e) => {
            evidence = e;
            entered.resolve();
            await release.promise;
            throw new Error("asynchronous host denial");
          },
          requireAdmission: true,
        },
      });
      try {
        const outcome = manager
          .connect(f.server, kind === "profile" ? scope : undefined)
          .then(
            (value) => ({ error: undefined, value }),
            (error) => ({ error, value: undefined })
          );
        await entered.promise;
        expect(f.count()).toBe(0);
        await absent(f.marker);
        expect(manager.getConnectedCount()).toBe(0);
        expect(evidence!.launchPolicy).toBe("mcp_stdio");
        expect(evidence!.policy.stage).toBe("prepared_not_executed");
        release.resolve();
        expect((await outcome).error?.message).toBe("asynchronous host denial");
        expect(f.count()).toBe(0);
        await absent(f.marker);
        await absent(evidence!.temporaryRoot.path);
        if (kind === "discovery") {
          await absent(evidence!.workspaceRoot.path);
        } else {
          expect(evidence!.workspaceRoot.path).toBe(f.workspace);
        }
      } finally {
        release.resolve();
        await manager.disconnectAll();
      }
    }));
  test(`${kind}: approved MCP starts, preserves configured values and retains a genuine receipt until disconnect`, async () =>
    fixture(async (f) => {
      let seen: RestrictedProcessLaunchEvidence | undefined;
      const manager = new McpClientManager({
        stdioAdmission: {
          authorize: async (e) => {
            seen = e;
          },
          requireAdmission: true,
        },
      });
      let historical: unknown;
      try {
        const tools = await manager.connect(
          f.server,
          kind === "profile" ? scope : undefined
        );
        expect(tools).toHaveLength(1);
        const initial = JSON.parse(tools[0]!.description) as Probe;
        expect(f.count()).toBe(1);
        expect(await readFile(f.marker, "utf8")).toBe("1");
        expect(initial.credential).toBe("synthetic configured credential");
        expect(initial.outside.path).toBe(f.outside);
        expect(["EPERM", "EACCES"]).toContain(initial.outside.code);
        expect(initial.cwd).toBe(seen!.workspaceRoot.path);
        expect(initial.home).toBe(seen!.temporaryRoot.path);
        expect(
          await readFile(path.join(initial.cwd, "startup-effect.txt"), "utf8")
        ).toBe("actual MCP startup");
        historical = manager.getRuntimeAdmissionReceipt(
          f.server.id,
          kind === "profile" ? "active" : undefined,
          kind === "profile" ? "org" : undefined
        );
        expect(getRestrictedProcessAdmissionEvidence(historical)).toBe(seen!);
        expect(JSON.stringify(tools)).not.toContain("launchDigest");
        expect(
          manager.getRuntimeAdmissionReceipt(f.server.id, "other", "org")
        ).toBeUndefined();
        const probe = (await manager.callTool(
          f.server.id,
          "stdio",
          "probe",
          {},
          kind === "profile" ? "active" : undefined,
          kind === "profile" ? "org" : undefined
        )) as Probe;
        expect(probe.credential).toBe(initial.credential);
        expect(probe.outside).toEqual(initial.outside);
      } finally {
        await manager.disconnectAll();
      }
      expect(
        manager.getRuntimeAdmissionReceipt(
          f.server.id,
          kind === "profile" ? "active" : undefined,
          kind === "profile" ? "org" : undefined
        )
      ).toBeUndefined();
      expect(getRestrictedProcessAdmissionEvidence(historical)).toBe(seen!);
      await absent(seen!.temporaryRoot.path);
      if (kind === "discovery") {
        await absent(seen!.workspaceRoot.path);
      }
    }));
}

test("manager policy is captured and extra model/config policy fields cannot override it", async () =>
  fixture(async (f) => {
    const policy = {
      authorize: async (_e: RestrictedProcessLaunchEvidence): Promise<void> => {
        throw new Error("original captured denial");
      },
      requireAdmission: true,
    };
    const manager = new McpClientManager({ stdioAdmission: policy });
    policy.requireAdmission = false;
    policy.authorize = async () => {};
    const malicious = {
      ...f.server.config,
      launchPolicy: "standard",
      requireAdmission: false,
      stdioAdmission: { authorize: async () => {}, requireAdmission: false },
    };
    try {
      await expect(manager.testConnection("stdio", malicious)).rejects.toThrow(
        "original captured denial"
      );
      expect(f.count()).toBe(0);
      await absent(f.marker);
    } finally {
      await manager.disconnectAll();
    }
  }));

test("McpService create and test inherit required host admission without storing a rejected server", async () =>
  fixture(async (f) => {
    const db = createInMemoryDatabaseAdapter();
    const now = new Date().toISOString();
    await db.upsertOrganization({
      createdAt: now,
      id: "org",
      name: "Org",
      slug: "org",
      updatedAt: now,
    });
    const manager = new McpClientManager({
        stdioAdmission: { requireAdmission: true },
      }),
      service = new McpService(db, manager);
    await expect(
      service.createServer("org", {
        config: f.server.config,
        name: "Denied",
        transport: "stdio",
      })
    ).rejects.toThrow();
    expect((await service.testServer("org", "stdio", f.server.config)).ok).toBe(
      false
    );
    expect(await db.listMcpServersForOrg("org")).toEqual([]);
    expect(f.count()).toBe(0);
    await absent(f.marker);
  }));

test("SDK ambient additions after approval cannot change the admitted absent TERM or configured credential", async () =>
  fixture(async (f) => {
    const previous = process.env.TERM;
    delete process.env.TERM;
    const manager = new McpClientManager({
      stdioAdmission: {
        authorize: async (e) => {
          expect(JSON.stringify(e)).not.toContain(
            "synthetic configured credential"
          );
          process.env.TERM = "later ambient value";
        },
        requireAdmission: true,
      },
    });
    try {
      const tools = await manager.connect(f.server, scope);
      const probe = JSON.parse(tools[0]!.description) as Probe;
      expect(probe.termPresent).toBe(true);
      expect(probe.term).toBe("");
      expect(probe.credential).toBe("synthetic configured credential");
      expect(f.count()).toBe(1);
    } finally {
      await manager.disconnectAll();
      if (previous === undefined) {
        delete process.env.TERM;
      } else {
        process.env.TERM = previous;
      }
    }
  }));

test("explicit configured TERM survives later ambient changes", async () =>
  fixture(async (f) => {
    const previous = process.env.TERM;
    process.env.TERM = "original ambient";
    f.server.config.env!.TERM = "configured terminal";
    const manager = new McpClientManager({
      stdioAdmission: {
        authorize: async () => {
          process.env.TERM = "changed ambient";
        },
        requireAdmission: true,
      },
    });
    try {
      const tools = await manager.connect(f.server, scope);
      expect((JSON.parse(tools[0]!.description) as Probe).term).toBe(
        "configured terminal"
      );
      expect(f.count()).toBe(1);
    } finally {
      await manager.disconnectAll();
      if (previous === undefined) {
        delete process.env.TERM;
      } else {
        process.env.TERM = previous;
      }
    }
  }));

test("natural MCP exit invalidates connection receipt lookup while preserving historical evidence", async () =>
  fixture(async (f) => {
    const manager = new McpClientManager({
      stdioAdmission: { authorize: async () => {}, requireAdmission: true },
    });
    try {
      await manager.connect(f.server, scope);
      const receipt = manager.getRuntimeAdmissionReceipt(
        f.server.id,
        "active",
        "org"
      );
      const evidence = getRestrictedProcessAdmissionEvidence(receipt);
      await manager.callTool(
        f.server.id,
        "stdio",
        "probe",
        { shutdown: true },
        "active",
        "org"
      );
      for (
        let n = 0;
        n < 50 &&
        manager.getRuntimeAdmissionReceipt(f.server.id, "active", "org");
        n++
      ) {
        await Bun.sleep(10);
      }
      expect(
        manager.getRuntimeAdmissionReceipt(f.server.id, "active", "org")
      ).toBeUndefined();
      expect(manager.getConnectedCount()).toBe(0);
      expect(getRestrictedProcessAdmissionEvidence(receipt)).toBe(evidence);
    } finally {
      await manager.disconnectAll();
    }
  }));

test("direct managed preparation cleanup invalidates its host lookup even before SDK start", async () =>
  fixture(async (f) => {
    const prepare = createMcpStdioTransportPreparer({
      authorize: async () => {},
      requireAdmission: true,
    });
    const managed = await prepare(f.server.config, scope);
    const receipt = managed.getAdmissionReceipt();
    expect(
      getRestrictedProcessAdmissionEvidence(receipt).workspaceRoot.path
    ).toBe(f.workspace);
    await managed.cleanup();
    expect(managed.getAdmissionReceipt()).toBeUndefined();
    expect(f.count()).toBe(0);
    await absent(f.marker);
  }));

test("connect snapshots scope and stdio values before its first disconnect await", async () =>
  fixture(async (f) => {
    const options = { ...scope };
    const manager = new McpClientManager({
      stdioAdmission: { authorize: async () => {}, requireAdmission: true },
    });
    try {
      const connecting = manager.connect(f.server, options);
      options.orgId = "different";
      options.profileId = "missing";
      f.server.config.args = ["-e", "process.exit(99)"];
      f.server.config.env!.FIXTURE_CREDENTIAL = "mutated config value";
      const tools = await connecting;
      const initial = JSON.parse(tools[0]!.description) as Probe;
      expect(initial.cwd).toBe(f.workspace);
      expect(initial.credential).toBe("synthetic configured credential");
      expect(f.count()).toBe(1);
      expect(
        manager.getRuntimeAdmissionReceipt(f.server.id, "active", "org")
      ).toBeDefined();
    } finally {
      await manager.disconnectAll();
    }
  }));

test("receipt digest matches immutable SDK invocation parameters before actual startup", async () =>
  fixture(async (f) => {
    const prepare = createMcpStdioTransportPreparer({
      authorize: async () => {},
      requireAdmission: true,
    });
    const managed = await prepare(f.server.config, scope);
    const evidence = getRestrictedProcessAdmissionEvidence(
      managed.getAdmissionReceipt()
    );
    // Version-bound SDK inspection; no environment values are emitted to logs.
    const parameters = Object.getOwnPropertyDescriptor(
      managed.transport,
      "_serverParams"
    )!.value as {
      args: string[];
      command: string;
      cwd: string;
      env: Record<string, string>;
    };
    const digest = createHash("sha256")
      .update(
        JSON.stringify([
          parameters.command,
          parameters.args,
          parameters.cwd,
          Object.keys(parameters.env)
            .sort()
            .map((key) => [key, parameters.env[key]]),
        ])
      )
      .digest("hex");
    const client = new Client({ name: "admission-verifier", version: "1" });
    try {
      expect(digest).toBe(evidence.launchDigest);
      expect(Object.isFrozen(parameters)).toBe(true);
      expect(() => parameters.args.push("unexpected argument")).toThrow();
      expect(() => {
        parameters.env.FIXTURE_CREDENTIAL = "changed";
      }).toThrow();
      expect(() => {
        parameters.cwd = f.outside;
      }).toThrow();
      expect(() => JSON.stringify(managed.getAdmissionReceipt())).toThrow();
      expect(() =>
        getRestrictedProcessAdmissionEvidence({ launchId: evidence.launchId })
      ).toThrow();
      await client.connect(managed.transport);
      const result = await client.listTools();
      const initial = JSON.parse(result.tools[0]!.description!) as Probe;
      expect(initial.credential).toBe("synthetic configured credential");
      expect(initial.cwd).toBe(f.workspace);
      expect(f.count()).toBe(1);
    } finally {
      await client.close();
      await managed.cleanup();
    }
  }));

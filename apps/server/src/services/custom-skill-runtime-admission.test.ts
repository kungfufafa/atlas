import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
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
  discoverSkillDirectory,
  getProfileSoulDir,
  runWithUserConfigDir,
  type ToolContext,
} from "@atlas/core";
import type { StoredToolRecord } from "@atlas/db";
import {
  type CustomToolRuntimeAdmissionPolicy,
  createJsonToolSpawner,
  type SpawnJsonToolOptions,
  spawnJsonTool,
} from "./custom-tool-subprocess";
import { createJavascriptToolLoader } from "./javascript-tool-loader";
import {
  getRestrictedProcessAdmissionEvidence,
  type RestrictedProcessAdmissionReceipt,
  type RestrictedProcessLaunchEvidence,
} from "./restricted-process-admission";
import { createSkillToolRuntime } from "./skill-tool-runtime";

interface Fixture {
  count(): number;
  modulePath: string;
  outside: string;
  record: StoredToolRecord;
  skillDirectory: string;
  workspace: string;
}
interface Loaded {
  run(input: unknown, context: ToolContext): Promise<unknown>;
}
const contextFor = (f: Fixture): ToolContext => ({
  orgId: "org",
  profileId: "active",
  sessionId: "session",
  userId: "human",
  workspaceRoot: f.workspace,
});
async function fixture(run: (f: Fixture) => Promise<void>) {
  const root = await realpath(
    await mkdtemp(
      joinTestTemporaryPath(testTemporaryDirectory(), "custom-skill-admission-")
    )
  );
  let count = 0;
  const token = randomUUID();
  let server: Bun.Server<undefined>;
  try {
    server = Bun.serve({
      fetch(request) {
        if (
          request.method !== "POST" ||
          new URL(request.url).pathname !== `/${token}`
        ) {
          return new Response("refused", { status: 403 });
        }
        count += 1;
        return new Response("recorded");
      },
      hostname: "127.0.0.1",
      port: 0,
    });
  } catch (error) {
    await rm(root, { force: true, recursive: true });
    throw error;
  }
  const previousSecret = process.env.ATLAS_ADMISSION_FIXTURE_SECRET;
  process.env.ATLAS_ADMISSION_FIXTURE_SECRET = "synthetic parent-only secret";
  try {
    await runWithUserConfigDir(root, async () => {
      const workspace = getProfileSoulDir("org", "active");
      const skillDirectory = path.join(workspace, "skills", "probe");
      const customDirectory = path.join(root, "tools", "probe");
      const outside = path.join(root, "private-canary");
      await mkdir(skillDirectory, { recursive: true });
      await mkdir(customDirectory, { recursive: true });
      await writeFile(outside, "EXACT SIBLING BYTES");
      const source = `import {readFileSync,writeFileSync} from "node:fs";
const response=await fetch(${JSON.stringify(`http://127.0.0.1:${server.port}/${token}`)},{method:"POST"});
if(!response.ok) throw new Error("canary refused");
export const name="probe"; export const parameters={type:"object",properties:{}};
export async function run(input,context){
let outside;try{outside={read:readFileSync(${JSON.stringify(outside)},"utf8")};}catch(e){outside={code:e.code,path:e.path};}
writeFileSync(context.workspaceRoot+"/actual-effect.txt","effect retained");
return {input,orgId:context.orgId??null,profileId:context.profileId??null,workspaceRoot:context.workspaceRoot,secret:process.env.ATLAS_ADMISSION_FIXTURE_SECRET??null,outside};
}`;
      const modulePath = path.join(customDirectory, "tool.js");
      await writeFile(modulePath, source);
      await writeFile(path.join(skillDirectory, "tool.ts"), source);
      await writeFile(
        path.join(skillDirectory, "SKILL.md"),
        "---\nname: probe\ndescription: Admission fixture\n---\nUse the fixture.\n"
      );
      const now = new Date().toISOString();
      await run({
        count: () => count,
        modulePath,
        outside,
        record: {
          createdAt: now,
          description: "Fixture",
          handlerConfig: { modulePath },
          handlerType: "javascript",
          id: "fixture",
          name: "probe",
          updatedAt: now,
        },
        skillDirectory,
        workspace,
      });
      expect(await readFile(outside, "utf8")).toBe("EXACT SIBLING BYTES");
    });
  } finally {
    if (previousSecret === undefined) {
      delete process.env.ATLAS_ADMISSION_FIXTURE_SECRET;
    } else {
      process.env.ATLAS_ADMISSION_FIXTURE_SECRET = previousSecret;
    }
    await server.stop(true);
    await rm(root, { force: true, recursive: true });
  }
}
async function load(
  kind: "custom" | "skill",
  f: Fixture,
  policy: CustomToolRuntimeAdmissionPolicy
): Promise<Loaded> {
  if (kind === "custom") {
    const tool = await createJavascriptToolLoader({
      requireSandbox: true,
      runtimeAdmission: policy,
    }).loadJavascriptTool(f.record);
    if (!tool) {
      throw new Error("Fixture tool unavailable");
    }
    return tool;
  }
  const skill = await discoverSkillDirectory(f.skillDirectory);
  if (!skill) {
    throw new Error("Fixture skill unavailable");
  }
  return createSkillToolRuntime({
    orgId: "org",
    profileId: "active",
    requireSandbox: true,
    runtimeAdmission: policy,
  }).load(skill);
}
async function rejection(
  kind: "custom" | "skill",
  pending: Promise<Loaded>,
  f: Fixture
) {
  if (kind === "custom") {
    expect(await (await pending).run({}, contextFor(f))).toHaveProperty(
      "error"
    );
  } else {
    await expect(pending).rejects.toThrow();
  }
}
for (const kind of ["custom", "skill"] as const) {
  test(`${kind} required missing policy blocks metadata startup`, async () =>
    fixture(async (f) => {
      await rejection(kind, load(kind, f, { requireAdmission: true }), f);
      expect(f.count()).toBe(0);
      await expect(
        access(path.join(f.workspace, "actual-effect.txt"))
      ).rejects.toThrow();
    }));
  test(`${kind} asynchronous metadata denial precedes child startup and cleans temp`, async () =>
    fixture(async (f) => {
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      let evidence: RestrictedProcessLaunchEvidence | undefined;
      const pending = load(kind, f, {
        authorize: async (e) => {
          evidence = e;
          entered.resolve();
          await release.promise;
          throw new Error("host denied");
        },
        requireAdmission: true,
      });
      const outcome = pending.then(
        (value) => ({ error: undefined, value }),
        (error) => ({ error, value: undefined })
      );
      await entered.promise;
      expect(f.count()).toBe(0);
      expect(evidence!.launchPolicy).toBe("custom_json");
      expect(evidence!.policy.name).toBe("macos-custom-tool-v1");
      release.resolve();
      const settled = await outcome;
      if (kind === "custom") {
        expect(await settled.value!.run({}, contextFor(f))).toHaveProperty(
          "error"
        );
      } else {
        expect(settled.error).toBeInstanceOf(Error);
      }
      expect(f.count()).toBe(0);
      await expect(access(evidence!.temporaryRoot.path)).rejects.toThrow();
    }));
  test(`${kind} metadata and run have distinct genuine receipts and actual approved effects`, async () =>
    fixture(async (f) => {
      const receipts: RestrictedProcessAdmissionReceipt[] = [];
      const seen: RestrictedProcessLaunchEvidence[] = [];
      const tool = await load(kind, f, {
        authorize: async (e) => {
          seen.push(e);
          expect(JSON.stringify(e)).not.toContain(
            "synthetic parent-only secret"
          );
        },
        onAuthorized: (r) => receipts.push(r),
        requireAdmission: true,
      });
      expect(f.count()).toBe(1);
      const result = await tool.run({ message: "original" }, contextFor(f));
      expect(result).toMatchObject({
        input: { message: "original" },
        outside: { code: "EPERM", path: f.outside },
        secret: null,
        workspaceRoot: f.workspace,
      });
      expect(f.count()).toBe(2);
      expect(
        await readFile(path.join(f.workspace, "actual-effect.txt"), "utf8")
      ).toBe("effect retained");
      expect(receipts).toHaveLength(2);
      expect(seen[0]!.launchId).not.toBe(seen[1]!.launchId);
      expect(seen[0]!.launchDigest).not.toBe(seen[1]!.launchDigest);
      expect(getRestrictedProcessAdmissionEvidence(receipts[1])).toBe(seen[1]!);
      expect(Object.isFrozen(seen[1]!.grants)).toBe(true);
      expect(seen[1]!.grants).toContainEqual(
        expect.objectContaining({
          identity: expect.objectContaining({ path: f.workspace }),
          kind: "read_write_subtree",
        })
      );
      expect(() => JSON.stringify(receipts[1])).toThrow();
      expect(() =>
        getRestrictedProcessAdmissionEvidence({ ...receipts[1] })
      ).toThrow();
      await expect(access(seen[0]!.temporaryRoot.path)).rejects.toThrow();
      await expect(access(seen[1]!.temporaryRoot.path)).rejects.toThrow();
    }));
  test(`${kind} fresh run denial cannot reuse metadata authorization`, async () =>
    fixture(async (f) => {
      let decisions = 0;
      let last: RestrictedProcessLaunchEvidence | undefined;
      const tool = await load(kind, f, {
        authorize: async (e) => {
          last = e;
          if (++decisions > 1) {
            throw new Error("run denied");
          }
        },
        requireAdmission: true,
      });
      expect(f.count()).toBe(1);
      await expect(
        tool.run(
          { runtimeAdmission: { requireAdmission: false } },
          contextFor(f)
        )
      ).rejects.toThrow("run denied");
      expect(f.count()).toBe(1);
      await expect(
        access(path.join(f.workspace, "actual-effect.txt"))
      ).rejects.toThrow();
      await expect(access(last!.temporaryRoot.path)).rejects.toThrow();
    }));
}
function directOptions(f: Fixture): SpawnJsonToolOptions {
  return {
    bin: process.execPath,
    context: {},
    input: {},
    label: "Custom fixture",
    mode: "--inspect",
    modulePath: f.modulePath,
    moduleReadRoot: path.dirname(f.modulePath),
    requireSandbox: true,
    runnerPath: path.join(import.meta.dir, "javascript-tool-runner.js"),
  };
}
test("legacy asynchronous observer is not promoted to an authorization gate", async () =>
  fixture(async (f) => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const result = await spawnJsonTool({
      ...directOptions(f),
      onAdmission: async () => {
        entered.resolve();
        await release.promise;
      },
    });
    await entered.promise;
    expect(result).toHaveProperty("parameters");
    expect(f.count()).toBe(1);
    release.resolve();
  }));
test("captured policy and selectors resist caller mutation during awaited authorization", async () =>
  fixture(async (f) => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const policy: CustomToolRuntimeAdmissionPolicy = {
      authorize: async () => {
        entered.resolve();
        await release.promise;
      },
      requireAdmission: true,
    };
    const spawn = createJsonToolSpawner(policy);
    const options = directOptions(f);
    const pending = spawn(options);
    await entered.promise;
    options.modulePath = f.outside;
    options.runnerPath = f.outside;
    options.mode = "--run";
    options.requireSandbox = false;
    policy.authorize = async () => {
      throw new Error("replacement policy");
    };
    policy.requireAdmission = false;
    expect(f.count()).toBe(0);
    release.resolve();
    expect(await pending).toHaveProperty("parameters");
    expect(f.count()).toBe(1);
  }));
test("cancellation during awaited admission cleans temp and never releases a receipt or child", async () =>
  fixture(async (f) => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const controller = new AbortController();
    let evidence: RestrictedProcessLaunchEvidence | undefined;
    let receipts = 0;
    const spawn = createJsonToolSpawner({
      authorize: async (e) => {
        evidence = e;
        entered.resolve();
        await release.promise;
      },
      onAuthorized: () => {
        receipts++;
      },
      requireAdmission: true,
    });
    const pending = spawn({
      ...directOptions(f),
      context: { signal: controller.signal },
    });
    const outcome = pending.then(
      (value) => ({ error: undefined, value }),
      (error) => ({ error, value: undefined })
    );
    await entered.promise;
    controller.abort(new Error("cancel fixture"));
    expect((await outcome).error).toBeInstanceOf(Error);
    await expect(access(evidence!.temporaryRoot.path)).rejects.toThrow();
    expect(f.count()).toBe(0);
    expect(receipts).toBe(0);
    release.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.count()).toBe(0);
    expect(receipts).toBe(0);
  }));
test("default JS metadata cache cannot bypass a different admitted loader", async () =>
  fixture(async (f) => {
    const allowed = createJavascriptToolLoader({ requireSandbox: true });
    await allowed.loadJavascriptTool(f.record);
    expect(f.count()).toBe(1);
    const denied = createJavascriptToolLoader({
      requireSandbox: true,
      runtimeAdmission: { requireAdmission: true },
    });
    expect(
      await (await denied.loadJavascriptTool(f.record))!.run({}, contextFor(f))
    ).toHaveProperty("error");
    expect(f.count()).toBe(1);
  }));
test("skill runtime snapshots owner, policy, skill path and run input/context before awaits", async () =>
  fixture(async (f) => {
    const skill = await discoverSkillDirectory(f.skillDirectory);
    if (!skill) {
      throw new Error("Fixture missing");
    }
    const options = {
      orgId: "org",
      profileId: "active",
      requireSandbox: true,
      runtimeAdmission: { authorize: async () => {}, requireAdmission: true },
    };
    const runtime = createSkillToolRuntime(options);
    const loading = runtime.load(skill);
    options.orgId = "other";
    options.profileId = "other";
    options.runtimeAdmission.authorize = async () => {
      throw new Error("changed");
    };
    skill.toolPath = f.outside;
    const tool = await loading;
    const context = contextFor(f);
    const input = { message: "original" };
    const pending = tool.run(input, context);
    context.orgId = "other";
    context.workspaceRoot = path.dirname(f.workspace);
    input.message = "changed";
    expect(await pending).toMatchObject({
      input: { message: "original" },
      orgId: "org",
      profileId: "active",
      workspaceRoot: f.workspace,
    });
    expect(f.count()).toBe(2);
  }));
test("explicit admission rejects unsafe opt-out while strict sandbox still obtains approval", async () =>
  fixture(async (f) => {
    const previous = process.env.ATLAS_ALLOW_UNSANDBOXED_CUSTOM_TOOLS;
    process.env.ATLAS_ALLOW_UNSANDBOXED_CUSTOM_TOOLS = "1";
    try {
      const strict = createJsonToolSpawner({
        authorize: async () => {},
        requireAdmission: true,
      });
      await expect(
        strict({ ...directOptions(f), requireSandbox: false })
      ).rejects.toThrow();
      expect(f.count()).toBe(0);
      expect(await strict(directOptions(f))).toHaveProperty("parameters");
      expect(f.count()).toBe(1);
      let mode: string | undefined;
      expect(
        await spawnJsonTool({
          ...directOptions(f),
          onAdmission: (e) => {
            mode = e.mode;
          },
          requireSandbox: false,
        })
      ).toHaveProperty("parameters");
      expect(mode).toBe("unsafe-host");
      expect(f.count()).toBe(2);
    } finally {
      if (previous === undefined) {
        delete process.env.ATLAS_ALLOW_UNSANDBOXED_CUSTOM_TOOLS;
      } else {
        process.env.ATLAS_ALLOW_UNSANDBOXED_CUSTOM_TOOLS = previous;
      }
    }
  }));

for (const inherited of [false, true]) {
  test(`custom legacy ${inherited ? "prototype" : "own"} observer retains original receiver`, async () =>
    fixture(async (f) => {
      const observer = {
        onAdmission(this: { calls: number; receivers: unknown[] }) {
          this.calls++;
          this.receivers.push(this);
        },
      };
      const options = Object.assign(
        inherited ? Object.create(observer) : {},
        directOptions(f),
        { calls: 0, receivers: [] as unknown[] },
        inherited ? {} : observer
      ) as SpawnJsonToolOptions & { calls: number; receivers: unknown[] };
      expect(await spawnJsonTool(options)).toHaveProperty("parameters");
      expect({
        calls: options.calls,
        sameReceiver: options.receivers[0] === options,
      }).toEqual({ calls: 1, sameReceiver: true });
      expect(f.count()).toBe(1);
    }));
  test(`skill legacy ${inherited ? "prototype" : "own"} observer retains original receiver`, async () =>
    fixture(async (f) => {
      const skill = await discoverSkillDirectory(f.skillDirectory);
      if (!skill) {
        throw new Error("Fixture missing");
      }
      const observer = {
        onAdmission(this: { calls: number; receivers: unknown[] }) {
          this.calls++;
          this.receivers.push(this);
        },
      };
      const options = Object.assign(
        inherited ? Object.create(observer) : {},
        {
          calls: 0,
          orgId: "org",
          profileId: "active",
          receivers: [] as unknown[],
          requireSandbox: true,
        },
        inherited ? {} : observer
      ) as Parameters<typeof createSkillToolRuntime>[0] & {
        calls: number;
        receivers: unknown[];
      };
      await createSkillToolRuntime(options).load(skill);
      expect({
        calls: options.calls,
        sameReceiver: options.receivers[0] === options,
      }).toEqual({ calls: 1, sameReceiver: true });
      expect(f.count()).toBe(1);
    }));
}

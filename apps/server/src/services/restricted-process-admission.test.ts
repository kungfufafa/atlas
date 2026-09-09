import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  createRestrictedProcessPreparer,
  getRestrictedProcessAdmissionEvidence,
  type PreparedRestrictedProcess,
  prepareRestrictedProcess,
  type RestrictedProcessAdmissionPolicy,
  type RestrictedProcessLaunchEvidence,
} from "./restricted-process";
import { authorizeRestrictedProcessLaunch } from "./restricted-process-admission";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
async function fixture(
  run: (root: string, workspace: string) => Promise<void>
) {
  const root = await realpath(await mkdtemp("/private/tmp/runtime-admission-"));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);
  try {
    await run(root, workspace);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}
const command = (workspaceRoot: string) => ({
  args: ["-c", "printf actual-child > child-effect.txt"],
  bin: "/bin/sh",
  workspaceRoot,
});
async function execute(
  prepared: Pick<PreparedRestrictedProcess, "bin" | "args" | "cwd" | "env">
) {
  return await new Promise<{ code: number | null; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(prepared.bin, prepared.args, {
        cwd: prepared.cwd,
        env: prepared.env,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > 8192) {
          child.kill("SIGKILL");
        }
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stderr });
      });
    }
  );
}
async function absent(file: string) {
  await expect(access(file)).rejects.toThrow();
}

for (const launchPolicy of ["standard", "mcp_stdio"] as const) {
  test(`${launchPolicy}: asynchronous denial blocks a real launch continuation and cleans its actual temp`, async () =>
    fixture(async (_root, workspace) => {
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      let observed: RestrictedProcessLaunchEvidence | undefined;
      let launched = false;
      const prepare = createRestrictedProcessPreparer({
        authorize: async (evidence) => {
          observed = evidence;
          entered.resolve();
          await release.promise;
          throw new Error("host denied");
        },
        launchPolicy,
        requireAdmission: true,
      });
      const pending = (async () => {
        const p = await prepare(command(workspace));
        launched = true;
        try {
          return await execute(p);
        } finally {
          await p.cleanup();
        }
      })();
      const outcome = pending.then(
        (value) => ({ error: undefined, value }),
        (error) => ({ error, value: undefined })
      );
      await entered.promise;
      expect(launched).toBe(false);
      expect((await stat(observed!.temporaryRoot.path)).isDirectory()).toBe(
        true
      );
      await absent(path.join(workspace, "child-effect.txt"));
      release.resolve();
      expect((await outcome).error?.message).toBe("host denied");
      expect(launched).toBe(false);
      await absent(observed!.temporaryRoot.path);
      await absent(path.join(workspace, "child-effect.txt"));
    }));
  test(`${launchPolicy}: approved real launch uses the final immutable plan and an unforgeable receipt`, async () =>
    fixture(async (_root, workspace) => {
      let observed: RestrictedProcessLaunchEvidence | undefined;
      const prepare = createRestrictedProcessPreparer({
        authorize: async (e) => {
          observed = e;
        },
        launchPolicy,
        requireAdmission: true,
      });
      const p = await prepare({
        ...command(workspace),
        env: { SYNTHETIC_SECRET: "synthetic-secret-only-in-launch-env" },
      });
      try {
        expect(p.evidence).toBe(observed!);
        expect(getRestrictedProcessAdmissionEvidence(p.admissionReceipt)).toBe(
          p.evidence
        );
        expect(p.evidence.launchPolicy).toBe(launchPolicy);
        expect(JSON.stringify(p.evidence)).not.toContain(
          "synthetic-secret-only-in-launch-env"
        );
        expect(p.evidence.launchDigest).toBe(
          digest(
            JSON.stringify([
              p.bin,
              p.args,
              p.cwd,
              Object.keys(p.env)
                .sort()
                .map((k) => [k, p.env[k]]),
            ])
          )
        );
        expect(Object.isFrozen(p)).toBe(true);
        expect(Object.isFrozen(p.args)).toBe(true);
        expect(Object.isFrozen(p.env)).toBe(true);
        expect(Object.isFrozen(p.evidence.grants)).toBe(true);
        expect(
          p.evidence.grants.every(
            (g) => Object.isFrozen(g) && Object.isFrozen(g.identity)
          )
        ).toBe(true);
        expect(() => Reflect.set(p, "bin", "/bin/false")).not.toThrow();
        expect(p.bin).not.toBe("/bin/false");
        expect(Reflect.set(p.env, "HOME", "/")).toBe(false);
        expect(Reflect.set(p.args, 0, "invalid")).toBe(false);
        expect(() =>
          getRestrictedProcessAdmissionEvidence({ ...p.admissionReceipt })
        ).toThrow();
        expect(() =>
          getRestrictedProcessAdmissionEvidence(
            JSON.parse(JSON.stringify(p.evidence))
          )
        ).toThrow();
        expect(() => JSON.stringify(p.admissionReceipt)).toThrow();
        expect(() => structuredClone(p.admissionReceipt)).toThrow();
        const result = await execute(p);
        expect(result).toEqual({ code: 0, stderr: "" });
        expect(
          await readFile(path.join(workspace, "child-effect.txt"), "utf8")
        ).toBe("actual-child");
      } finally {
        await p.cleanup();
        await p.cleanup();
      }
      await absent(p.evidence.temporaryRoot.path);
      // Retained receipt describes original admission after cleanup, without reparsing missing roots.
      expect(getRestrictedProcessAdmissionEvidence(p.admissionReceipt)).toBe(
        observed!
      );
    }));
}

test("required missing policy never releases a launch plan or runs the child", async () =>
  fixture(async (_root, workspace) => {
    let launched = false;
    const prepare = createRestrictedProcessPreparer({ requireAdmission: true });
    await expect(
      (async () => {
        const p = await prepare(command(workspace));
        launched = true;
        await execute(p);
      })()
    ).rejects.toThrow();
    expect(launched).toBe(false);
    await absent(path.join(workspace, "child-effect.txt"));
  }));

test("a synchronous diagnostic observer is rejected and its prepared temp is cleaned", async () =>
  fixture(async (_root, workspace) => {
    let seen: RestrictedProcessLaunchEvidence | undefined;
    const observer = ((e: RestrictedProcessLaunchEvidence) => {
      seen = e;
    }) as unknown as NonNullable<RestrictedProcessAdmissionPolicy["authorize"]>;
    const prepare = createRestrictedProcessPreparer({
      authorize: observer,
      requireAdmission: true,
    });
    await expect(prepare(command(workspace))).rejects.toThrow();
    expect(seen).toBeDefined();
    await absent(seen!.temporaryRoot.path);
    await absent(path.join(workspace, "child-effect.txt"));
  }));

function overlaps(parent: string, child: string) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    !(
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
  );
}
function disjointPolicy(privateRoot: string) {
  return async (evidence: RestrictedProcessLaunchEvidence) => {
    for (const grant of evidence.grants) {
      const granted = grant.identity.path;
      // Literal directory-entry rules do not authorize descendant byte reads.
      if (grant.kind === "directory_entries_literal") {
        continue;
      }
      if (
        overlaps(privateRoot, granted) ||
        (grant.kind.endsWith("subtree")
          ? overlaps(granted, privateRoot)
          : granted === privateRoot)
      ) {
        throw new Error("private store overlaps actual launch grant");
      }
    }
  };
}

test("trusted policy checks actual workspace and runtime roots against private storage before code", async () =>
  fixture(async (root, workspace) => {
    const privateRoot = path.join(root, "private-store");
    await mkdir(privateRoot);
    await writeFile(
      path.join(privateRoot, "secret"),
      "synthetic private bytes"
    );
    const authorize = disjointPolicy(privateRoot);
    const prepare = createRestrictedProcessPreparer({
      authorize,
      requireAdmission: true,
    });
    for (const options of [
      { ...command(workspace), readRoots: [privateRoot] },
      command(privateRoot),
    ]) {
      await expect(
        (async () => {
          const p = await prepare(options);
          try {
            await execute(p);
          } finally {
            await p.cleanup();
          }
        })()
      ).rejects.toThrow("private store overlaps");
    }
    await absent(path.join(workspace, "child-effect.txt"));
    await absent(path.join(privateRoot, "child-effect.txt"));
    expect(await readFile(path.join(privateRoot, "secret"), "utf8")).toBe(
      "synthetic private bytes"
    );
    const accepted = await prepare(command(workspace));
    try {
      expect((await execute(accepted)).code).toBe(0);
    } finally {
      await accepted.cleanup();
    }
  }));

test("policy snapshots launch/config inputs and independently binds simultaneous temp identities", async () =>
  fixture(async (_root, workspace) => {
    const options = command(workspace);
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const policy: {
      requireAdmission: boolean;
      authorize: NonNullable<RestrictedProcessAdmissionPolicy["authorize"]>;
    } = {
      authorize: async () => {
        entered.resolve();
        await release.promise;
      },
      requireAdmission: true,
    };
    const prepare = createRestrictedProcessPreparer(policy);
    const a = prepare(options);
    options.args[1] = "exit 99";
    policy.authorize = async () => {
      throw new Error("changed callback");
    };
    const b = prepare(command(workspace));
    await entered.promise;
    release.resolve();
    const [first, second] = await Promise.all([a, b]);
    try {
      expect(first.args.at(-1)).toBe("printf actual-child > child-effect.txt");
      expect(first.evidence.launchId).not.toBe(second.evidence.launchId);
      expect(first.evidence.temporaryRoot.path).not.toBe(
        second.evidence.temporaryRoot.path
      );
      expect(
        getRestrictedProcessAdmissionEvidence(first.admissionReceipt)
      ).not.toBe(
        getRestrictedProcessAdmissionEvidence(second.admissionReceipt)
      );
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  }));

test("MCP receipt binds post-extension directory grants/policy before authorization", async () =>
  fixture(async (_root, workspace) => {
    const standard = await prepareRestrictedProcess(command(workspace));
    let authorized = false;
    const prepare = createRestrictedProcessPreparer({
      authorize: async (e) => {
        if (process.platform === "darwin") {
          const directories = e.grants
            .filter((g) => g.kind === "directory_entries_literal")
            .map((g) => g.identity.path);
          expect(directories).toContain(path.dirname(workspace));
          expect(directories).toContain("/");
          expect(e.policy.startupConfigurationSuppressed).toBe(false);
        }
        authorized = true;
      },
      launchPolicy: "mcp_stdio",
      requireAdmission: true,
    });
    const p = await prepare(command(workspace));
    try {
      expect(authorized).toBe(true);
      if (process.platform === "darwin") {
        const index = p.args.indexOf("-p");
        expect(p.args[index + 1]).toContain("MCP_DIRECTORY_0");
        expect(p.evidence.policy.digest).toBe(digest(p.args[index + 1]!));
        expect(standard.args.join(" ")).not.toContain("MCP_DIRECTORY_");
      } else {
        expect(p.args.slice(0, 2)).toEqual([
          "--config=/dev/null",
          "--env-file=/dev/null",
        ]);
      }
    } finally {
      await standard.cleanup();
      await p.cleanup();
    }
  }));

test("legacy standard preparation remains available without creating an admission receipt", async () =>
  fixture(async (_root, workspace) => {
    const legacy = await prepareRestrictedProcess(command(workspace));
    try {
      expect("admissionReceipt" in legacy).toBe(false);
      expect(Object.isFrozen(legacy.args)).toBe(false);
      expect((await execute(legacy)).code).toBe(0);
    } finally {
      await legacy.cleanup();
    }
  }));

test("dynamic temp and canonical runtime identities are checked while present, then preserved as evidence", async () =>
  fixture(async (root, workspace) => {
    const runtimeRoot = path.join(root, "runtime");
    await mkdir(runtimeRoot);
    let observed: RestrictedProcessLaunchEvidence | undefined;
    const prepare = createRestrictedProcessPreparer({
      authorize: async (evidence) => {
        observed = evidence;
        for (const item of [
          evidence.temporaryRoot,
          evidence.workspaceRoot,
          evidence.executable,
        ]) {
          const actual = await stat(item.path, { bigint: true });
          expect(item.device).toBe(actual.dev.toString());
          expect(item.inode).toBe(actual.ino.toString());
        }
        expect(
          evidence.grants.some(
            (grant) =>
              grant.kind === "read_write_subtree" &&
              grant.identity.path === evidence.temporaryRoot.path
          )
        ).toBe(true);
        expect(
          evidence.grants.some((grant) => grant.identity.path === runtimeRoot)
        ).toBe(true);
        await disjointPolicy(
          path.join(evidence.temporaryRoot.path, "private-store")
        )(evidence);
      },
      requireAdmission: true,
    });
    await expect(
      prepare({ ...command(workspace), readRoots: [runtimeRoot] })
    ).rejects.toThrow("private store overlaps");
    await absent(observed!.temporaryRoot.path);
    expect(
      observed!.grants.some((grant) => grant.identity.path === runtimeRoot)
    ).toBe(true);
    await absent(path.join(workspace, "child-effect.txt"));
  }));

test("an optional asynchronous policy is still awaited; no policy yields prepared evidence without certification", async () =>
  fixture(async (_root, workspace) => {
    const denied = createRestrictedProcessPreparer({
      authorize: async () => {
        throw new Error("optional policy denied");
      },
    });
    await expect(denied(command(workspace))).rejects.toThrow(
      "optional policy denied"
    );
    const prepare = createRestrictedProcessPreparer({});
    const prepared = await prepare(command(workspace));
    try {
      expect(prepared.admissionReceipt).toBeUndefined();
      expect(prepared.evidence.kind).toBe("restricted_process_prepared");
      expect(() =>
        getRestrictedProcessAdmissionEvidence(prepared.evidence)
      ).toThrow();
    } finally {
      await prepared.cleanup();
    }
  }));

test("a copied prepared-evidence shape cannot create an admitted receipt", async () =>
  fixture(async (_root, workspace) => {
    const prepared = await createRestrictedProcessPreparer({})(
      command(workspace)
    );
    let called = false;
    try {
      await expect(
        authorizeRestrictedProcessLaunch(
          JSON.parse(JSON.stringify(prepared.evidence)),
          async () => {
            called = true;
          }
        )
      ).rejects.toThrow();
      expect(called).toBe(false);
    } finally {
      await prepared.cleanup();
    }
  }));

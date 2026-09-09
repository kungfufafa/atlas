import { constants } from "node:fs";
import { access, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getUserConfigDir } from "@atlas/core";
import {
  authorizeRestrictedProcessLaunch,
  createRestrictedProcessLaunchEvidence,
  type RestrictedProcessAdmissionPolicy,
  type RestrictedProcessAdmissionReceipt,
  type RestrictedProcessEvidenceInput,
  type RestrictedProcessLaunchEvidence,
  type RestrictedProcessLaunchPolicy,
} from "./restricted-process-admission";
import {
  readRestrictedProcessLinuxPolicy,
  restrictedProcessLinuxBootstrapArgs,
  validateRestrictedProcessLinuxEnvironment,
} from "./restricted-process-linux-policy";

export type {
  RestrictedProcessAdmissionPolicy,
  RestrictedProcessAdmissionReceipt,
  RestrictedProcessLaunchEvidence,
} from "./restricted-process-admission";
export { getRestrictedProcessAdmissionEvidence } from "./restricted-process-admission";

export interface RestrictedProcessOptions {
  args: string[];
  bin: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  readRoots?: string[];
  workspaceRoot: string;
}

export interface RestrictedProcess {
  args: string[];
  bin: string;
  cleanup(): Promise<void>;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface PreparedRestrictedProcess {
  readonly admissionReceipt?: RestrictedProcessAdmissionReceipt;
  readonly args: readonly string[];
  readonly bin: string;
  cleanup(): Promise<void>;
  readonly cwd: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly evidence: RestrictedProcessLaunchEvidence;
}
interface RestrictedProcessPlan {
  readonly evidenceInput: Omit<
    RestrictedProcessEvidenceInput,
    "policySource"
  > & {
    readonly policySource: string;
    readonly linuxLauncher?: string;
  };
  readonly launch: RestrictedProcess;
}

/** Trusted host factory. Approval is awaited before the immutable launch plan is released. */
export function createRestrictedProcessPreparer(
  policy: RestrictedProcessAdmissionPolicy
): (options: RestrictedProcessOptions) => Promise<PreparedRestrictedProcess> {
  const authorize = policy.authorize;
  const requireAdmission = policy.requireAdmission === true;
  const launchPolicy = policy.launchPolicy ?? "standard";
  if (launchPolicy !== "standard" && launchPolicy !== "mcp_stdio") {
    throw new Error("Unknown restricted process launch policy.");
  }
  return async (options) => {
    if (requireAdmission && !authorize) {
      throw new Error("Required runtime authorization is unavailable.");
    }
    const captured = {
      args: [...options.args],
      bin: options.bin,
      cwd: options.cwd,
      env: { ...options.env },
      readRoots: [...(options.readRoots ?? [])],
      workspaceRoot: options.workspaceRoot,
    };
    const plan = await prepareRestrictedProcessPlan(captured, launchPolicy);
    try {
      const args = Object.freeze([...plan.launch.args]);
      const env = Object.freeze({ ...plan.launch.env });
      let policySource = plan.evidenceInput.policySource;
      if (plan.evidenceInput.linuxLauncher) {
        policySource = await readRestrictedProcessLinuxPolicy(
          policySource,
          plan.evidenceInput.linuxLauncher
        );
      }
      const evidence = await createRestrictedProcessLaunchEvidence({
        ...plan.evidenceInput,
        args,
        env,
        policySource,
      });
      const admissionReceipt = await authorizeRestrictedProcessLaunch(
        evidence,
        authorize
      );
      return Object.freeze({
        admissionReceipt,
        args,
        bin: plan.launch.bin,
        cleanup: plan.launch.cleanup,
        cwd: plan.launch.cwd,
        env,
        evidence,
      });
    } catch (error) {
      await plan.launch.cleanup();
      throw error;
    }
  };
}

// System software and shared libraries only. No host home, /etc, /tmp, /proc,
// project checkout, or Atlas configuration tree is exposed recursively.
const SYSTEM_READ_ROOTS = [
  "/bin",
  "/usr/bin",
  "/usr/sbin",
  "/lib",
  "/lib64",
  "/usr/lib",
  "/usr/lib64",
  "/usr/share",
  "/usr/local/bin",
  "/usr/local/lib",
  "/System",
  "/opt/homebrew/bin",
  "/opt/homebrew/lib",
  "/opt/homebrew/Cellar",
  "/private/etc/ssl",
  "/etc/ssl",
  "/etc/pki",
  "/etc/ca-certificates",
  "/etc/ld.so.cache",
  "/etc/resolv.conf",
  "/etc/hosts",
  "/etc/nsswitch.conf",
  "/etc/gai.conf",
  "/etc/localtime",
  "/etc/mime.types",
  "/etc/httpd/mime.types",
  "/etc/httpd/conf/mime.types",
  "/etc/apache/mime.types",
  "/etc/apache2/mime.types",
  "/usr/local/etc/httpd/conf/mime.types",
  "/dev/null",
  "/dev/random",
  "/dev/urandom",
];
const RUNTIME_PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin";

export async function resolveRestrictedExecutable(
  bin: string
): Promise<string> {
  const candidates = path.isAbsolute(bin)
    ? [bin]
    : (process.env.PATH ?? RUNTIME_PATH)
        .split(path.delimiter)
        .map((dir) => path.join(dir, bin));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      // Preserve the spelling of a venv executable: realpath changes Python's
      // prefix discovery and silently discards its installed site-packages.
      return path.resolve(candidate);
    } catch {
      // Try the next installed executable.
    }
  }
  throw new Error(`Restricted process executable is unavailable: ${bin}`);
}

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    !(
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative)
    )
  );
}

async function allowedRuntimeRoots(
  roots: string[],
  workspaceRoot: string
): Promise<string[]> {
  const configRoot = await realpath(getUserConfigDir()).catch(() =>
    path.resolve(getUserConfigDir())
  );
  const resolved: string[] = [];
  for (const root of roots) {
    const canonical = await realpath(root).catch(() => undefined);
    if (!canonical) {
      continue;
    }
    if (
      canonical === path.parse(canonical).root ||
      contains(canonical, configRoot) ||
      contains(canonical, workspaceRoot)
    ) {
      throw new Error(
        `Runtime read root would expose the Atlas configuration or profile tree: ${canonical}`
      );
    }
    // The managed Python venv is the only supported runtime within Atlas home.
    if (
      contains(configRoot, canonical) &&
      !contains(path.join(configRoot, "runtime", "python"), canonical)
    ) {
      throw new Error(
        `Runtime read root must not expose Atlas tenant data: ${canonical}`
      );
    }
    resolved.push(canonical);
  }
  return [...new Set(resolved)];
}

/** Required OS boundary for arbitrary Python and Bash. There is no host fallback. */
export async function prepareRestrictedProcess(
  options: RestrictedProcessOptions
): Promise<RestrictedProcess> {
  return (await prepareRestrictedProcessPlan(options, "standard")).launch;
}

async function prepareRestrictedProcessPlan(
  options: RestrictedProcessOptions,
  launchPolicy: RestrictedProcessLaunchPolicy
): Promise<RestrictedProcessPlan> {
  const requestedEnv = { ...options.env };
  if (process.platform === "linux") {
    validateRestrictedProcessLinuxEnvironment(requestedEnv);
  }
  const network = process.env.ATLAS_PROCESS_NETWORK?.trim() || "allow";
  if (network !== "allow" && network !== "deny") {
    throw new Error("ATLAS_PROCESS_NETWORK must be allow or deny.");
  }
  if (network === "deny" && process.platform !== "darwin") {
    // Landlock ABI 3 confines files only, and newer network rules cover TCP
    // rather than every socket type. Never advertise full network denial there.
    throw new Error(
      "ATLAS_PROCESS_NETWORK=deny currently requires macOS sandbox-exec. Execution was blocked because this host cannot enforce that network policy."
    );
  }
  const temporaryRoot = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "atlas-restricted-"))
  );
  const cleanup = async () => {
    await rm(temporaryRoot, { force: true, recursive: true });
  };
  try {
    const workspaceRoot = await realpath(options.workspaceRoot);
    const cwd = await realpath(options.cwd ?? workspaceRoot);
    if (!contains(workspaceRoot, cwd)) {
      throw new Error(
        "Restricted process cwd must stay inside the profile workspace."
      );
    }
    const executable = await resolveRestrictedExecutable(options.bin);
    const executableTarget = await realpath(executable);
    const readRoots = await allowedRuntimeRoots(
      [...SYSTEM_READ_ROOTS, ...(options.readRoots ?? []), executableTarget],
      workspaceRoot
    );
    const env: NodeJS.ProcessEnv = {
      ...requestedEnv,
      HOME: temporaryRoot,
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      PATH: RUNTIME_PATH,
      TEMP: temporaryRoot,
      TMP: temporaryRoot,
      TMPDIR: temporaryRoot,
      XDG_CACHE_HOME: temporaryRoot,
      XDG_CONFIG_HOME: temporaryRoot,
    };
    if (process.platform === "darwin") {
      await access("/usr/bin/sandbox-exec", constants.X_OK);
      const args: string[] = [];
      const rules = readRoots.map((root, index) => {
        args.push("-D", `READ_${index}=${root}`);
        return `(subpath (param "READ_${index}"))`;
      });
      args.push(
        "-D",
        `WORKSPACE=${workspaceRoot}`,
        "-D",
        `TEMP=${temporaryRoot}`
      );
      let profile = `(version 1)
(deny default)
(import "system.sb")
(allow process-exec)
(allow process-fork)
(allow signal (target same-sandbox))
(allow file-read-metadata)
(allow file-test-existence)
(allow file-read-data ${rules.join("\n")})
(allow file-read* file-write* (subpath (param "WORKSPACE")) (subpath (param "TEMP")))
(allow file-read* file-write* (literal "/dev/null"))
(allow sysctl-read)
(allow mach-lookup)
(${network === "deny" ? "deny" : "allow"} network*)`;
      const directoryRoots: string[] = [];
      if (launchPolicy === "mcp_stdio") {
        let current = path.dirname(workspaceRoot);
        for (;;) {
          directoryRoots.push(current);
          const parent = path.dirname(current);
          if (parent === current) {
            break;
          }
          current = parent;
        }
        const directoryRules = directoryRoots.map((root, index) => {
          args.push("-D", `MCP_DIRECTORY_${index}=${root}`);
          return `(literal (param "MCP_DIRECTORY_${index}"))`;
        });
        profile += `\n(allow file-read-data ${directoryRules.join(" ")})`;
      }
      args.push("-p", profile, executable, ...options.args);
      const launch = { args, bin: "/usr/bin/sandbox-exec", cleanup, cwd, env };
      return {
        evidenceInput: {
          ...launch,
          executable: executableTarget,
          executableSpelling: executable,
          grants: [
            ...readRoots.map((root) => ({
              kind: "read_subtree" as const,
              root,
            })),
            { kind: "read_write_subtree", root: workspaceRoot },
            { kind: "read_write_subtree", root: temporaryRoot },
            { kind: "read_write_literal", root: "/dev/null" },
            ...directoryRoots.map((root) => ({
              kind: "directory_entries_literal" as const,
              root,
            })),
          ],
          launchPolicy,
          network,
          platform: "darwin",
          policySource: profile,
          temporaryRoot,
          workspaceRoot,
        },
        launch,
      };
    }
    if (process.platform === "linux") {
      const launcher = path.join(
        import.meta.dir,
        "restricted-process-linux.js"
      );
      await access(launcher, constants.R_OK);
      const rules = [
        ...(await Promise.all(
          readRoots.map(async (root) => ({
            mode:
              root === executableTarget
                ? "e"
                : (await stat(root)).isDirectory()
                  ? "r"
                  : "f",
            root,
          }))
        )),
        { mode: "w", root: workspaceRoot },
        { mode: "w", root: temporaryRoot },
      ];
      const argv = [executable, ...options.args];
      env.ATLAS_RESTRICTED_ARGC = String(argv.length);
      env.ATLAS_RESTRICTED_RULEC = String(rules.length);
      for (const [index, arg] of argv.entries()) {
        env[`ATLAS_RESTRICTED_ARG_${index}`] = arg;
      }
      for (const [index, rule] of rules.entries()) {
        env[`ATLAS_RESTRICTED_ROOT_${index}`] = rule.root;
        env[`ATLAS_RESTRICTED_MODE_${index}`] = rule.mode;
      }
      const launch = {
        args: restrictedProcessLinuxBootstrapArgs(launcher),
        bin: process.execPath,
        cleanup,
        cwd,
        env,
      };
      return {
        evidenceInput: {
          ...launch,
          executable: executableTarget,
          executableSpelling: executable,
          grants: [
            ...rules.map((rule) => ({
              kind:
                rule.mode === "w"
                  ? ("read_write_subtree" as const)
                  : rule.mode === "e"
                    ? ("read_execute_literal" as const)
                    : rule.mode === "r"
                      ? ("read_subtree" as const)
                      : ("read_literal" as const),
              root: rule.root,
            })),
            { kind: "read_write_literal", root: "/dev/null" },
          ],
          launchPolicy,
          linuxLauncher: launcher,
          network,
          platform: "linux",
          policySource: JSON.stringify(rules),
          temporaryRoot,
          workspaceRoot,
        },
        launch,
      };
    }
    throw new Error(
      "Python/Bash require macOS sandbox-exec or Linux Landlock ABI 3; this host is unsupported. Execution was blocked."
    );
  } catch (error) {
    await cleanup();
    throw error;
  }
}

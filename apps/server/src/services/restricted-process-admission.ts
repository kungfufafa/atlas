import { createHash, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";

export type RestrictedProcessLaunchPolicy =
  | "standard"
  | "mcp_stdio"
  | "custom_json";
export type RestrictedProcessGrantKind =
  | "read_subtree"
  | "read_literal"
  | "read_execute_literal"
  | "read_write_subtree"
  | "read_write_literal"
  | "directory_entries_literal";

export interface RestrictedProcessPathIdentity {
  readonly device: string;
  readonly inode: string;
  readonly path: string;
  readonly type: "directory" | "file" | "other";
}
export interface RestrictedProcessGrant {
  readonly identity: RestrictedProcessPathIdentity;
  readonly kind: RestrictedProcessGrantKind;
}
export interface RestrictedProcessLaunchEvidence {
  readonly cwd: RestrictedProcessPathIdentity;
  readonly executable: RestrictedProcessPathIdentity;
  readonly executableSpelling: string;
  /** Rules with identities resolved before launch; runtime-bound rules are declared by policy. */
  readonly grants: readonly RestrictedProcessGrant[];
  readonly kind: "restricted_process_prepared";
  readonly launchDigest: string;
  readonly launchId: string;
  readonly launchPolicy: RestrictedProcessLaunchPolicy;
  readonly network: "allow" | "deny";
  readonly platform: "darwin" | "linux";
  readonly policy: {
    /** Linux's trusted Bun bootstrap; this does not describe the selected target. */
    readonly bootstrapStartupConfigurationSuppressed: boolean;
    readonly digest: string;
    readonly name:
      | "macos-restricted-process-v1"
      | "linux-landlock-abi3-v2"
      | "macos-custom-tool-v1";
    readonly stage: "prepared_not_executed";
    /** Configuration suppression on the selected target runtime itself. */
    readonly startupConfigurationSuppressed: boolean;
    /** Resolved by the launcher before same-PID exec; descendants inherit only that inode. */
    readonly runtimeReadRules: readonly {
      readonly path: "/proc/self/maps";
      readonly resolvedBy: "launcher";
      readonly scope: "same_process_inode";
    }[];
    readonly implicitAuthority:
      | "macos-system.sb-metadata-existence"
      | "trusted-linux-launcher-bootstrap";
  };
  readonly temporaryRoot: RestrictedProcessPathIdentity;
  readonly version: 1;
  readonly workspaceRoot: RestrictedProcessPathIdentity;
}

declare const admissionBrand: unique symbol;
export interface RestrictedProcessAdmissionReceipt {
  readonly [admissionBrand]: true;
}
export interface RestrictedProcessAdmissionPolicy {
  /** Trusted host policy only; never accept this object from tool/request JSON. */
  readonly authorize?: (
    evidence: RestrictedProcessLaunchEvidence
  ) => Promise<void>;
  readonly launchPolicy?: "standard" | "mcp_stdio";
  readonly requireAdmission?: boolean;
}

const receipts = new WeakMap<object, RestrictedProcessLaunchEvidence>();
const preparedEvidence = new WeakSet<object>();

/** This validates capability identity, not a serialized receipt's shape. */
export function getRestrictedProcessAdmissionEvidence(
  receipt: unknown
): RestrictedProcessLaunchEvidence {
  const evidence =
    receipt !== null && typeof receipt === "object"
      ? receipts.get(receipt)
      : undefined;
  if (!evidence) {
    throw new Error("A genuine host runtime admission receipt is required.");
  }
  return evidence;
}

export interface RestrictedProcessEvidenceInput {
  readonly args: readonly string[];
  readonly bin: string;
  readonly cwd: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly executable: string;
  readonly executableSpelling: string;
  readonly grants: readonly {
    readonly kind: RestrictedProcessGrantKind;
    readonly root: string;
  }[];
  readonly launchPolicy: RestrictedProcessLaunchPolicy;
  readonly network: "allow" | "deny";
  readonly platform: "darwin" | "linux";
  readonly policySource: string;
  readonly temporaryRoot: string;
  readonly workspaceRoot: string;
}

async function pathIdentity(
  value: string
): Promise<RestrictedProcessPathIdentity> {
  const info = await stat(value, { bigint: true });
  return Object.freeze({
    device: info.dev.toString(),
    inode: info.ino.toString(),
    path: value,
    type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
  });
}
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Internal launcher construction helper. This is not an untrusted receipt import API. */
export async function createRestrictedProcessLaunchEvidence(
  input: RestrictedProcessEvidenceInput
): Promise<RestrictedProcessLaunchEvidence> {
  if (input.launchPolicy === "custom_json" && input.platform !== "darwin") {
    throw new Error("Custom runtime evidence currently requires macOS.");
  }
  const [cwd, executable, workspaceRoot, temporaryRoot, grants] =
    await Promise.all([
      pathIdentity(input.cwd),
      pathIdentity(input.executable),
      pathIdentity(input.workspaceRoot),
      pathIdentity(input.temporaryRoot),
      Promise.all(
        input.grants.map(async (grant) =>
          Object.freeze({
            identity: await pathIdentity(grant.root),
            kind: grant.kind,
          })
        )
      ),
    ]);
  const evidence: RestrictedProcessLaunchEvidence = Object.freeze({
    cwd,
    executable,
    executableSpelling: input.executableSpelling,
    grants: Object.freeze(grants),
    kind: "restricted_process_prepared",
    launchDigest: digest(
      JSON.stringify([
        input.bin,
        input.args,
        input.cwd,
        Object.keys(input.env)
          .sort()
          .map((key) => [key, input.env[key]]),
      ])
    ),
    launchId: randomUUID(),
    launchPolicy: input.launchPolicy,
    network: input.network,
    platform: input.platform,
    policy: Object.freeze({
      bootstrapStartupConfigurationSuppressed: input.platform === "linux",
      digest: digest(input.policySource),
      implicitAuthority:
        input.platform === "darwin"
          ? "macos-system.sb-metadata-existence"
          : "trusted-linux-launcher-bootstrap",
      name:
        input.launchPolicy === "custom_json"
          ? "macos-custom-tool-v1"
          : input.platform === "darwin"
            ? "macos-restricted-process-v1"
            : "linux-landlock-abi3-v2",
      runtimeReadRules: Object.freeze(
        input.platform === "linux"
          ? [
              Object.freeze({
                path: "/proc/self/maps" as const,
                resolvedBy: "launcher" as const,
                scope: "same_process_inode" as const,
              }),
            ]
          : []
      ),
      stage: "prepared_not_executed",
      startupConfigurationSuppressed: input.launchPolicy === "custom_json",
    }),
    temporaryRoot,
    version: 1,
    workspaceRoot,
  });
  preparedEvidence.add(evidence);
  return evidence;
}

/** Internal helper: only a resolved asynchronous policy decision creates a capability. */
export async function authorizeRestrictedProcessLaunch(
  evidence: RestrictedProcessLaunchEvidence,
  authorize: RestrictedProcessAdmissionPolicy["authorize"]
): Promise<RestrictedProcessAdmissionReceipt | undefined> {
  if (!authorize) {
    return;
  }
  if (!preparedEvidence.has(evidence)) {
    throw new Error(
      "A genuine prepared launch evidence capability is required."
    );
  }
  const decision = authorize(evidence);
  if (!decision || typeof decision.then !== "function") {
    throw new Error("Runtime authorization must return an awaited promise.");
  }
  await decision;
  const receipt = Object.freeze({
    toJSON(): never {
      throw new Error("Runtime admission receipts cannot be serialized.");
    },
  });
  receipts.set(receipt, evidence);
  return receipt as unknown as RestrictedProcessAdmissionReceipt;
}

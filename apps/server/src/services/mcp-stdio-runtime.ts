import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getProfileSoulDir,
  getUserConfigDir,
  type McpStdioConfig,
} from "@atlas/core";
import {
  DEFAULT_INHERITED_ENV_VARS,
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  createRestrictedProcessPreparer,
  getRestrictedProcessAdmissionEvidence,
  type RestrictedProcessAdmissionPolicy,
  type RestrictedProcessAdmissionReceipt,
} from "./restricted-process";

export type McpStdioAdmissionPolicy = Pick<
  RestrictedProcessAdmissionPolicy,
  "authorize" | "requireAdmission"
>;
const SDK_DEFAULT_ENV_KEYS = Object.freeze([...DEFAULT_INHERITED_ENV_VARS]);

const RESERVED_ENV =
  /^(?:LD_|DYLD_|BUN_|ATLAS_RESTRICTED_)|^(?:NODE_OPTIONS|NODE_PATH)$/;
const SCOPE_SEPARATOR = /[\\/\0]/;

export interface ManagedMcpStdioTransport {
  cleanup(): Promise<void>;
  /** Host-only current-connection lookup. Retained receipts are historical after cleanup. */
  getAdmissionReceipt(): RestrictedProcessAdmissionReceipt | undefined;
  transport: StdioClientTransport;
}

function scopeSegment(value: string): void {
  if (
    !value ||
    value === "." ||
    value === ".." ||
    SCOPE_SEPARATOR.test(value)
  ) {
    throw new Error(
      "MCP process scope requires canonical organization and profile IDs."
    );
  }
}

async function profileWorkspace(
  orgId: string,
  profileId: string
): Promise<string> {
  scopeSegment(orgId);
  scopeSegment(profileId);
  const configRoot = await realpath(getUserConfigDir());
  const expected = path.join(configRoot, "orgs", orgId, "profiles", profileId);
  const workspace = await realpath(getProfileSoulDir(orgId, profileId));
  if (workspace !== expected) {
    throw new Error(
      "MCP profile workspace must not redirect through a symbolic link."
    );
  }
  return workspace;
}

/** Host configuration is captured here, never read from an MCP config/request. */
export function createMcpStdioTransportPreparer(
  policy: McpStdioAdmissionPolicy = {}
) {
  const prepare = createRestrictedProcessPreparer({
    authorize: policy.authorize,
    launchPolicy: "mcp_stdio",
    requireAdmission: policy.requireAdmission,
  });
  return async (
    config: McpStdioConfig,
    scope?: { orgId?: string; profileId?: string }
  ): Promise<ManagedMcpStdioTransport> => {
    const defaults = getDefaultEnvironment();
    const configuredEnv = Object.fromEntries(
      Object.entries(config.env ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string"
      )
    );
    const captured: McpStdioConfig = {
      args: [...(config.args ?? [])],
      command: config.command,
      // SDK merges ambient defaults again at start. Explicit values for every key
      // prevent a later ambient addition/change from altering the admitted plan.
      // An absent/filtered inherited key is intentionally present-and-empty.
      env: {
        ...Object.fromEntries(
          SDK_DEFAULT_ENV_KEYS.map((key) => [key, defaults[key] ?? ""])
        ),
        ...configuredEnv,
      },
    };
    const capturedScope = scope ? { ...scope } : undefined;
    return await prepareMcpStdioTransportWith(prepare, captured, capturedScope);
  };
}
const defaultPreparer = createMcpStdioTransportPreparer();
/** Initialization and tools/list run tenant-selected code too, so admission precedes transport creation. */
export async function prepareMcpStdioTransport(
  config: McpStdioConfig,
  scope?: { orgId?: string; profileId?: string }
): Promise<ManagedMcpStdioTransport> {
  return await defaultPreparer(config, scope);
}

async function prepareMcpStdioTransportWith(
  prepare: ReturnType<typeof createRestrictedProcessPreparer>,
  config: McpStdioConfig,
  scope?: { orgId?: string; profileId?: string }
): Promise<ManagedMcpStdioTransport> {
  for (const key of Object.keys(config.env ?? {})) {
    if (RESERVED_ENV.test(key)) {
      throw new Error(
        `MCP environment variable ${key} is reserved for the confined runtime.`
      );
    }
  }
  if (scope?.profileId && !scope.orgId) {
    throw new Error("MCP profile execution requires its organization.");
  }
  let discoveryRoot: string | undefined;
  const cleanupDiscovery = async (): Promise<void> => {
    if (discoveryRoot) {
      await rm(discoveryRoot, { force: true, recursive: true });
    }
  };
  try {
    let workspaceRoot: string;
    if (scope?.orgId && scope.profileId) {
      workspaceRoot = await profileWorkspace(scope.orgId, scope.profileId);
    } else {
      discoveryRoot = await realpath(
        await mkdtemp(path.join(os.tmpdir(), "atlas-mcp-discovery-"))
      );
      workspaceRoot = discoveryRoot;
    }
    const prepared = await prepare({
      args: config.args ?? [],
      bin: config.command,
      env: config.env,
      workspaceRoot,
    });
    try {
      // The required MCP extensions and exact env were admitted before this point.
      const args = [...prepared.args];
      const env = Object.fromEntries(
        Object.entries(prepared.env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string"
        )
      );
      Object.freeze(args);
      Object.freeze(env);
      const parameters = Object.freeze({
        args,
        command: prepared.bin,
        cwd: prepared.cwd,
        env,
        stderr: "pipe" as const,
      });
      const transport = new StdioClientTransport(parameters);
      transport.stderr?.on("data", () => {});
      let cleanupPromise: Promise<void> | undefined;
      let activeReceipt = prepared.admissionReceipt;
      const managed: ManagedMcpStdioTransport = {
        cleanup() {
          activeReceipt = undefined;
          cleanupPromise ??= (async () => {
            try {
              await prepared.cleanup();
            } finally {
              await cleanupDiscovery();
            }
          })();
          return cleanupPromise;
        },
        getAdmissionReceipt() {
          if (activeReceipt) {
            getRestrictedProcessAdmissionEvidence(activeReceipt);
          }
          return activeReceipt;
        },
        transport,
      };
      transport.onclose = () => {
        void managed.cleanup().catch(() => {});
      };
      return managed;
    } catch (error) {
      await prepared.cleanup();
      throw error;
    }
  } catch (error) {
    await cleanupDiscovery();
    throw error;
  }
}

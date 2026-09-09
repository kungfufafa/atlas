import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type DiscoveredSkill,
  getGlobalSkillsDir,
  getProfileSkillsDir,
  getProfileSoulDir,
  getUserConfigDir,
  type JsonSchema,
  type SkillToolRuntime,
  type ToolContext,
} from "@atlas/core";
import {
  type CustomToolAdmission,
  type CustomToolRuntimeAdmissionPolicy,
  createJsonToolSpawner,
} from "./custom-tool-subprocess";

const RUNNER_PATH = fileURLToPath(
  new URL("./skill-tool-runner.js", import.meta.url)
);

export interface SkillToolAdmission extends CustomToolAdmission {
  orgId: string;
  phase: "metadata" | "run";
  profileId: string;
}

export interface SkillToolRuntimeOptions {
  onAdmission?: (evidence: Readonly<SkillToolAdmission>) => void;
  orgId: string;
  profileId: string;
  /** Trusted host policy; never sourced from module JSON or tool arguments. */
  requireSandbox?: boolean;
  runtimeAdmission?: CustomToolRuntimeAdmissionPolicy;
}

function scopeId(value: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.trim() !== value ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.basename(value) !== value ||
    value === "." ||
    value === ".."
  ) {
    throw new Error(
      "Skill runtime requires a valid organization and profile identity."
    );
  }
  return value;
}

async function exactRealPath(
  candidate: string,
  expected: string
): Promise<string> {
  const actual = await realpath(candidate);
  if (actual !== expected) {
    throw new Error(
      "Skill runtime rejected a symlink or changed root outside the authorized skill/profile location."
    );
  }
  return actual;
}

async function skillLocation(
  skill: DiscoveredSkill,
  options: SkillToolRuntimeOptions
) {
  const orgId = scopeId(options.orgId);
  const profileId = scopeId(options.profileId);
  const configRoot = await realpath(getUserConfigDir());
  const profileRoot = path.join(
    configRoot,
    "orgs",
    orgId,
    "profiles",
    profileId
  );
  const logicalDirectory = path.resolve(skill.directory);
  const logicalParent = path.dirname(logicalDirectory);
  let canonicalParent: string;
  if (logicalParent === path.resolve(getProfileSkillsDir(orgId, profileId))) {
    canonicalParent = path.join(profileRoot, "skills");
  } else if (logicalParent === path.resolve(getGlobalSkillsDir())) {
    canonicalParent = path.join(configRoot, "agent", "skills");
  } else {
    throw new Error(
      "Skill module is outside this profile's or the shared global skills directory. Reinstall it through an authorized skill path."
    );
  }
  const directory = await exactRealPath(
    logicalDirectory,
    path.join(canonicalParent, path.basename(logicalDirectory))
  );
  const toolPath = skill.toolPath;
  if (
    !(
      toolPath &&
      ["tool.ts", "tool.js"].some(
        (name) => path.resolve(toolPath) === path.join(logicalDirectory, name)
      )
    )
  ) {
    throw new Error(
      "Skill executable must be its own tool.ts or tool.js file."
    );
  }
  const modulePath = await exactRealPath(
    toolPath,
    path.join(directory, path.basename(toolPath))
  );
  if (!(await lstat(modulePath)).isFile()) {
    throw new Error("Skill executable must be a regular file.");
  }
  return { directory, modulePath, profileRoot };
}

function safeContext(context: ToolContext, orgId: string, profileId: string) {
  return {
    agentDepth: context.agentDepth,
    automationId: context.automationId,
    automationRunId: context.automationRunId,
    channel: context.channel,
    clientOrigin: context.clientOrigin,
    forbidProfileSkillMarkdownWrites: context.forbidProfileSkillMarkdownWrites,
    isPlatformAdmin: context.isPlatformAdmin,
    orgId,
    orgRole: context.orgRole,
    profileId,
    runId: context.runId,
    sessionId: context.sessionId,
    tokenOptimizerEnabled: context.tokenOptimizerEnabled,
    userId: context.userId,
  };
}

function metadata(value: unknown): {
  name?: string;
  description?: string;
  parameters?: JsonSchema;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Skill metadata must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  return {
    description:
      typeof record.description === "string" ? record.description : undefined,
    name: typeof record.name === "string" ? record.name : undefined,
    parameters:
      record.parameters &&
      typeof record.parameters === "object" &&
      !Array.isArray(record.parameters)
        ? (record.parameters as JsonSchema)
        : undefined,
  };
}

export function createSkillToolRuntime(
  suppliedOptions: SkillToolRuntimeOptions
): SkillToolRuntime {
  const onAdmission = suppliedOptions.onAdmission;
  const options = Object.freeze({
    orgId: suppliedOptions.orgId,
    profileId: suppliedOptions.profileId,
    requireSandbox: suppliedOptions.requireSandbox,
  });
  const spawn = createJsonToolSpawner(suppliedOptions.runtimeAdmission);
  const runtimeBin = process.env.ATLAS_BUN_BIN ?? "bun";
  return {
    async load(suppliedSkill) {
      const skill = Object.freeze({ ...suppliedSkill });
      const location = await skillLocation(skill, options);
      const invoke = (
        phase: "metadata" | "run",
        input: unknown,
        context: ToolContext,
        workspaceRoot?: string
      ) =>
        spawn({
          bin: runtimeBin,
          canonicalRootsRequired: true,
          context,
          input,
          label:
            phase === "metadata" ? "Skill metadata inspection" : "Skill tool",
          mode: phase === "metadata" ? "--inspect" : "--run",
          modulePath: location.modulePath,
          moduleReadRoot: location.directory,
          onAdmission: (evidence) =>
            onAdmission?.call(
              suppliedOptions,
              Object.freeze({
                ...evidence,
                orgId: options.orgId,
                phase,
                profileId: options.profileId,
              })
            ),
          requireSandbox: options.requireSandbox,
          runnerPath: RUNNER_PATH,
          workspaceRoot,
        });
      const inspected = metadata(await invoke("metadata", {}, {}));
      return {
        ...inspected,
        async run(input, suppliedContext) {
          const context = { ...suppliedContext };
          context.signal?.throwIfAborted();
          const payload: unknown = JSON.parse(
            JSON.stringify({
              context: safeContext(context, options.orgId, options.profileId),
              input,
            })
          );
          if (
            context.orgId !== options.orgId ||
            context.profileId !== options.profileId
          ) {
            throw new Error(
              "Skill invocation does not match its admitted organization/profile."
            );
          }
          const current = await skillLocation(skill, options);
          if (
            current.modulePath !== location.modulePath ||
            current.directory !== location.directory
          ) {
            throw new Error(
              "Skill executable changed location; reload the profile."
            );
          }
          const profileRoot = await exactRealPath(
            getProfileSoulDir(options.orgId, options.profileId),
            location.profileRoot
          );
          const workspaceRoot = await realpath(
            context.workspaceRoot ?? profileRoot
          );
          const relative = path.relative(profileRoot, workspaceRoot);
          if (
            relative === ".." ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)
          ) {
            throw new Error(
              "Skill workspace must stay inside its admitted profile."
            );
          }
          return invoke("run", payload, context, workspaceRoot);
        },
      };
    },
  };
}

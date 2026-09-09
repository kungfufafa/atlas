import path from "node:path";
import {
  builtinTools,
  type ToolContext,
  type ToolDefinition,
} from "@atlas/core";
import { getProfileArtifactsDir } from "@atlas/core/soul";
import { guardFilePath } from "@atlas/core/tools/paths";
import { pythonExecuteTool } from "../tools/python-execute-tool";

const WORK_FILE_TOOL_NAMES = new Set([
  "spreadsheet",
  "extract_document_text",
  "read_file",
  "write_file",
  "write_docx",
  "write_pptx",
]);

export function isChannelWorkFileTool(name: string): boolean {
  return WORK_FILE_TOOL_NAMES.has(name);
}

/** Channel file handling is a built-in capability, including on older profiles. */
export function channelWorkFileTools(guest: boolean): ToolDefinition[] {
  const files = builtinTools.filter((tool) => isChannelWorkFileTool(tool.name));
  return guest
    ? files.map(confineGuestFileTool)
    : [...files, pythonExecuteTool];
}

function confineGuestFileTool(tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    channelGuestFileSafe: true,
    async run(input: unknown, context: ToolContext) {
      if (!(context.orgId && context.profileId && context.workspaceRoot)) {
        throw new Error("Channel file tools require a profile workspace.");
      }
      if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("File tool input must be an object.");
      }
      const params: Record<string, unknown> = { ...input };
      if (params.cwd !== undefined && params.cwd !== "") {
        throw new Error(
          "Channel file tools use the profile workspace directly; omit cwd."
        );
      }
      const artifacts = getProfileArtifactsDir(
        context.orgId,
        context.profileId
      );
      const requiredPath =
        tool.name === "extract_document_text" ? "documentRef" : "path";
      if (typeof params[requiredPath] !== "string") {
        throw new Error(`File tool requires ${requiredPath}.`);
      }
      for (const key of [
        requiredPath,
        "csvPath",
        "targetCsvPath",
        "targetXlsxPath",
      ]) {
        if (params[key] === undefined) {
          continue;
        }
        if (typeof params[key] !== "string") {
          throw new Error(`Invalid file path: ${key}.`);
        }
        const guarded = await guardFilePath(params[key], null, undefined, {
          allowedDirs: [artifacts],
          cwd: context.workspaceRoot,
        });
        if (guarded.resolved === path.resolve(artifacts)) {
          throw new Error("Choose a file under artifacts/.");
        }
        params[key] = guarded.resolved;
      }
      return tool.run(params, {
        ...context,
        fileAssetAllowedDirs: [artifacts],
        loadAttachment: undefined,
      });
    },
  };
}

import { createHash } from "node:crypto";
import {
  type CreateProfileRequest,
  emptyObjectSchema,
  type ToolContext,
  type ToolDefinition,
  type UpdateProfileRequest,
} from "@atlas/core";
import { validateJavascriptToolModule } from "../services/javascript-tool-loader";
import type { ProfileService } from "../services/profile-service";
import {
  PROFILE_CREATE_CONFIRMATION_MESSAGE,
  PROFILE_UPDATE_CANCELLED_MESSAGE,
  PROFILE_UPDATE_CONFIRMATION_MESSAGE,
  type SuperAgentSessionState,
  TOOL_ASSIGNMENT_CONFIRMATION_MESSAGE,
} from "../services/super-agent-session-state";

const SUPPORTED_SOUL_FILE_NAMES = [
  "SOUL.md",
  "STYLE.md",
  "INSTRUCTIONS.md",
  "MEMORY.md",
] as const;
type SupportedSoulFileName = (typeof SUPPORTED_SOUL_FILE_NAMES)[number];

const SOUL_FILES_PARAMETER_SCHEMA = {
  additionalProperties: false,
  description:
    "Only the provided allowlisted soul files are replaced. Never put credentials or secrets in soul files.",
  properties: {
    "INSTRUCTIONS.md": { type: "string" },
    "MEMORY.md": { type: "string" },
    "SOUL.md": { type: "string" },
    "STYLE.md": { type: "string" },
  },
  type: "object",
} as const;

const PROFILE_UPDATE_INPUT_KEYS = new Set([
  "model",
  "name",
  "profileId",
  "skillsPostTurnReview",
  "skillsWriteApproval",
  "soulFiles",
  "systemPrompt",
]);

function requireOrgId(context: ToolContext): string {
  const orgId = context.orgId?.trim();

  if (!orgId) {
    throw new Error("Organization context is required.");
  }

  return orgId;
}

export function createSuperAgentTools(
  profileService: ProfileService,
  sessionState: SuperAgentSessionState,
  options: { onProfileUpdated?: (profileId: string) => void } = {}
): ToolDefinition[] {
  return [
    {
      description:
        "List all agent profiles with their id, name, and tool counts. Use when managing profiles or when the user asks you to assign a tool and you need profile ids.",
      name: "list_profiles",
      parameters: emptyObjectSchema(),
      async run(_input, context: ToolContext) {
        return profileService.listProfiles(requireOrgId(context));
      },
    },
    {
      description: "Get an agent profile by id, including assigned tools.",
      name: "get_profile",
      parameters: {
        additionalProperties: false,
        properties: {
          profileId: { description: "Profile id to fetch.", type: "string" },
        },
        required: ["profileId"],
        type: "object",
      },
      async run(input, context: ToolContext) {
        const profileId = readString(input, "profileId");

        if (!profileId) {
          throw new Error("profileId is required.");
        }

        const orgId = requireOrgId(context);
        const response = await profileService.getProfile(orgId, profileId);
        const soulFiles = await profileService.getProfileSoulFiles(
          orgId,
          profileId
        );

        return { ...response, soulFiles };
      },
    },
    {
      description: "Create a new agent profile.",
      name: "create_profile",
      parameters: {
        additionalProperties: false,
        properties: {
          isSuper: {
            description: "Whether this profile is a super agent.",
            type: "boolean",
          },
          model: {
            description: "Model override, or null to use the server default.",
            type: "string",
          },
          name: {
            description: "Display name for the profile.",
            type: "string",
          },
          soulFiles: {
            ...SOUL_FILES_PARAMETER_SCHEMA,
            description:
              "Optional generated soul file contents for the new profile. Supported keys: SOUL.md, STYLE.md, INSTRUCTIONS.md, MEMORY.md.",
          },
          systemPrompt: {
            description: "System prompt for the agent.",
            type: "string",
          },
        },
        required: ["name"],
        type: "object",
      },
      async run(input, context: ToolContext) {
        const name = readString(input, "name");

        if (!name) {
          throw new Error("name is required.");
        }

        const soulFiles = readSoulFiles(input);

        if (
          !sessionState.consumeProfileCreateConfirmation(
            context.sessionId,
            name
          )
        ) {
          return {
            message: PROFILE_CREATE_CONFIRMATION_MESSAGE,
            outcome: "needs_confirmation",
          };
        }

        return profileService.createProfile(requireOrgId(context), {
          model: readOptionalString(input, "model"),
          name,
          soulFiles,
          systemPrompt: readString(input, "systemPrompt") ?? undefined,
        });
      },
    },
    {
      description:
        "Update an org-scoped profile after explicit confirmation. Use get_profile, show the exact draft, wait for the user's next-turn confirmation, then submit the unchanged name, model, stored prompt, governance overrides, and/or allowlisted soul files.",
      name: "update_profile",
      parameters: {
        additionalProperties: false,
        properties: {
          model: {
            description:
              "Model override, or null to inherit the workspace default. Omit to preserve it.",
            type: ["string", "null"],
          },
          name: {
            description: "Replacement display name. Omit to preserve it.",
            type: "string",
          },
          profileId: {
            description: "Target profile id in the active workspace.",
            type: "string",
          },
          skillsPostTurnReview: {
            description:
              "Profile post-turn skill review override, or null to inherit. Omit to preserve it.",
            type: ["boolean", "null"],
          },
          skillsWriteApproval: {
            description:
              "Profile skill write-approval override, or null to inherit. Omit to preserve it.",
            type: ["boolean", "null"],
          },
          soulFiles: SOUL_FILES_PARAMETER_SCHEMA,
          systemPrompt: {
            description:
              "Replacement stored system prompt. Pass an empty string to clear it; omit to preserve it.",
            type: "string",
          },
        },
        required: ["profileId"],
        type: "object",
      },
      async run(input, context: ToolContext) {
        const orgId = requireOrgId(context);
        const userId = context.userId?.trim();
        const sessionId = context.sessionId?.trim();

        if (
          !(context.orgRole === "admin" || context.isPlatformAdmin === true)
        ) {
          throw new Error(
            "Workspace admin permission is required to update profiles."
          );
        }

        if (!(userId && sessionId)) {
          throw new Error(
            "An authenticated user and interactive session are required to update profiles."
          );
        }

        const { profileId, request } = readProfileUpdate(input);
        const draftHash = hashProfileUpdateDraft(request);
        const confirmation = sessionState.consumeProfileUpdateConfirmation({
          draftHash,
          orgId,
          profileId,
          sessionId,
          userId,
        });

        if (confirmation === "cancelled") {
          return {
            message: PROFILE_UPDATE_CANCELLED_MESSAGE,
            outcome: "cancelled",
          };
        }

        if (confirmation !== "confirmed") {
          return {
            message: PROFILE_UPDATE_CONFIRMATION_MESSAGE,
            outcome: "needs_confirmation",
          };
        }

        const result = await profileService.updateProfileAsActor(
          orgId,
          profileId,
          request,
          { userId }
        );
        options.onProfileUpdated?.(profileId);
        return result;
      },
    },
    {
      description:
        "Assign an existing tool to a profile. Use only when the user explicitly asks to assign a tool to a profile.",
      name: "assign_tool_to_profile",
      parameters: {
        additionalProperties: false,
        properties: {
          profileId: { description: "Target profile id.", type: "string" },
          toolId: { description: "Tool id to assign.", type: "string" },
        },
        required: ["profileId", "toolId"],
        type: "object",
      },
      async run(input, context: ToolContext) {
        const profileId = readString(input, "profileId");
        const toolId = readString(input, "toolId");

        if (!(profileId && toolId)) {
          throw new Error("profileId and toolId are required.");
        }

        if (!sessionState.canAssignTool(context.sessionId, toolId)) {
          throw new Error(TOOL_ASSIGNMENT_CONFIRMATION_MESSAGE);
        }

        const result = await profileService.assignTool(
          requireOrgId(context),
          profileId,
          {
            toolId,
          }
        );
        sessionState.markToolAssigned(context.sessionId, toolId);
        return result;
      },
    },
    {
      description: "List all registered tools.",
      name: "list_tools",
      parameters: emptyObjectSchema(),
      async run(_input, context: ToolContext) {
        return profileService.listTools(requireOrgId(context));
      },
    },
    {
      description:
        "Register a JavaScript tool. Workflow: list_tools (check name) → write_file (~/.atlas/tools/<name>.js) → create_tool. Do not call list_profiles as part of this workflow.",
      name: "create_tool",
      parameters: {
        additionalProperties: false,
        properties: {
          description: { description: "What the tool does.", type: "string" },
          handlerConfig: {
            additionalProperties: true,
            description:
              'For javascript tools: { "modulePath": "my-tool.js" } relative to ~/.atlas/tools/. The file must already exist and export run(input, context) plus optional parameters JSON schema.',
            type: "object",
          },
          handlerType: {
            description: 'Handler type. Must be "javascript".',
            type: "string",
          },
          name: { description: "Unique tool name.", type: "string" },
        },
        required: ["name", "description"],
        type: "object",
      },
      async run(input, context: ToolContext) {
        const name = readString(input, "name");
        const description = readString(input, "description");

        if (!(name && description)) {
          throw new Error("name and description are required.");
        }

        const requestedHandlerType = readString(input, "handlerType");
        const handlerType = "javascript";
        const handlerConfig = readObject(input, "handlerConfig");

        if (requestedHandlerType && requestedHandlerType !== handlerType) {
          throw new Error(
            'Super Agent can only create JavaScript tools. Use handlerType "javascript".'
          );
        }

        const modulePath = readModulePath(handlerConfig);

        if (!modulePath?.endsWith(".js")) {
          throw new Error(
            'JavaScript tools require handlerConfig.modulePath ending in ".js". Write the module with write_file to ~/.atlas/tools/ first.'
          );
        }

        await validateJavascriptToolModule(modulePath);

        const tool = await profileService.createTool(requireOrgId(context), {
          description,
          handlerConfig,
          handlerType,
          name,
        });

        sessionState.markToolCreated(context.sessionId, tool.id);

        return { tool };
      },
    },
  ];
}

function readString(input: unknown, key: string): string | null {
  if (typeof input !== "object" || input === null || !(key in input)) {
    return null;
  }

  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readStringAllowEmpty(input: unknown, key: string): string | null {
  if (typeof input !== "object" || input === null || !(key in input)) {
    return null;
  }

  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function readOptionalString(
  input: unknown,
  key: string
): string | null | undefined {
  if (typeof input !== "object" || input === null || !(key in input)) {
    return;
  }

  const value = (input as Record<string, unknown>)[key];

  if (value === null) {
    return null;
  }

  return typeof value === "string" ? value : undefined;
}

function readObject(input: unknown, key: string): unknown {
  if (typeof input !== "object" || input === null || !(key in input)) {
    return;
  }

  return (input as Record<string, unknown>)[key];
}

function readSoulFiles(
  input: unknown
):
  | CreateProfileRequest["soulFiles"]
  | UpdateProfileRequest["soulFiles"]
  | undefined {
  const raw = readObject(input, "soulFiles");

  if (raw === undefined) {
    return;
  }

  if (typeof raw !== "object" || raw === null) {
    throw new Error("soulFiles must be an object.");
  }

  const allowed = new Set<string>(SUPPORTED_SOUL_FILE_NAMES);
  const result: NonNullable<CreateProfileRequest["soulFiles"]> = {};

  for (const [key, value] of Object.entries(raw)) {
    if (!allowed.has(key)) {
      throw new Error(`Unsupported soul file: ${key}`);
    }

    if (typeof value !== "string") {
      throw new Error(`Soul file content must be a string: ${key}`);
    }

    result[key as SupportedSoulFileName] = value;
  }

  return result;
}

function readNullableBoolean(
  input: Record<string, unknown>,
  key: string
): boolean | null | undefined {
  if (!(key in input)) {
    return;
  }

  const value = input[key];
  if (value === null || typeof value === "boolean") {
    return value;
  }

  throw new Error(`${key} must be a boolean or null.`);
}

function readProfileUpdate(input: unknown): {
  profileId: string;
  request: UpdateProfileRequest;
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Profile update must be an object.");
  }

  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!PROFILE_UPDATE_INPUT_KEYS.has(key)) {
      throw new Error(`Unsupported profile update field: ${key}`);
    }
  }

  const profileId = readString(record, "profileId");
  if (!profileId) {
    throw new Error("profileId is required.");
  }

  const request: UpdateProfileRequest = {};

  if ("name" in record) {
    const name = readString(record, "name");
    if (!name) {
      throw new Error("name must not be empty.");
    }
    request.name = name;
  }

  if ("model" in record) {
    const model = record.model;
    if (model !== null && typeof model !== "string") {
      throw new Error("model must be a non-empty string or null.");
    }
    if (typeof model === "string" && !model.trim()) {
      throw new Error("model must be a non-empty string or null.");
    }
    request.model = typeof model === "string" ? model.trim() : null;
  }

  const systemPrompt = readStringAllowEmpty(record, "systemPrompt");
  if (systemPrompt !== null) {
    request.systemPrompt = systemPrompt.trim();
  } else if ("systemPrompt" in record) {
    throw new Error("systemPrompt must be a string.");
  }

  const skillsPostTurnReview = readNullableBoolean(
    record,
    "skillsPostTurnReview"
  );
  if (skillsPostTurnReview !== undefined) {
    request.skillsPostTurnReview = skillsPostTurnReview;
  }

  const skillsWriteApproval = readNullableBoolean(
    record,
    "skillsWriteApproval"
  );
  if (skillsWriteApproval !== undefined) {
    request.skillsWriteApproval = skillsWriteApproval;
  }

  const soulFiles = readSoulFiles(record);
  if (soulFiles !== undefined) {
    request.soulFiles = soulFiles;
  }

  const hasSoulFileUpdate = Object.keys(request.soulFiles ?? {}).length > 0;
  const hasStoredFieldUpdate = Object.keys(request).some(
    (key) => key !== "soulFiles"
  );
  if (!(hasSoulFileUpdate || hasStoredFieldUpdate)) {
    throw new Error("Provide at least one profile field to update.");
  }

  return { profileId, request };
}

function hashProfileUpdateDraft(request: UpdateProfileRequest): string {
  const canonicalSoulFiles = request.soulFiles
    ? Object.fromEntries(
        SUPPORTED_SOUL_FILE_NAMES.filter(
          (fileName) => request.soulFiles?.[fileName] !== undefined
        ).map((fileName) => [fileName, request.soulFiles?.[fileName]])
      )
    : undefined;
  const canonical = {
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.name === undefined ? {} : { name: request.name }),
    ...(request.skillsPostTurnReview === undefined
      ? {}
      : { skillsPostTurnReview: request.skillsPostTurnReview }),
    ...(request.skillsWriteApproval === undefined
      ? {}
      : { skillsWriteApproval: request.skillsWriteApproval }),
    ...(canonicalSoulFiles ? { soulFiles: canonicalSoulFiles } : {}),
    ...(request.systemPrompt === undefined
      ? {}
      : { systemPrompt: request.systemPrompt }),
  };

  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function readModulePath(handlerConfig: unknown): string | null {
  if (typeof handlerConfig !== "object" || handlerConfig === null) {
    return null;
  }

  const modulePath = (handlerConfig as Record<string, unknown>).modulePath;
  return typeof modulePath === "string" && modulePath.trim()
    ? modulePath.trim()
    : null;
}

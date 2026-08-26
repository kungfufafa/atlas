import {
  DEFAULT_BUNDLED_SKILL_NAMES,
  nanoid,
  SUPER_AGENT_BUNDLED_SKILL_NAMES,
} from "@atlas/core";
import {
  BASH_TOOL_ID,
  BUILTIN_TOOL_IDS,
  GENERATE_IMAGE_TOOL_ID,
  PYTHON_EXECUTE_TOOL_ID,
  TOOL_SEARCH_TOOL_ID,
} from "@atlas/core/tools/protected";
import { SUPER_AGENT_SYSTEM_PROMPT } from "./constants";
import type { DatabaseAdapter, StoredProfileRecord } from "./types";

const DEFAULT_BUILTIN_TOOL_IDS = [
  ...Object.values(BUILTIN_TOOL_IDS),
  PYTHON_EXECUTE_TOOL_ID,
  TOOL_SEARCH_TOOL_ID,
];

/** Default Agent + new custom profile toolkit — Super Agent extras (bash, image) stay opt-in. */
export const DEFAULT_AGENT_TOOL_IDS = DEFAULT_BUILTIN_TOOL_IDS.filter(
  (toolId) => toolId !== BASH_TOOL_ID && toolId !== GENERATE_IMAGE_TOOL_ID
);

export async function ensureProfileDefaultBuiltinTools(
  db: DatabaseAdapter,
  profileId: string
): Promise<void> {
  for (const toolId of DEFAULT_BUILTIN_TOOL_IDS) {
    await db.assignToolToProfile(profileId, toolId);
  }
}

export async function ensureProfileDefaultAgentTools(
  db: DatabaseAdapter,
  profileId: string
): Promise<void> {
  for (const toolId of DEFAULT_AGENT_TOOL_IDS) {
    await db.assignToolToProfile(profileId, toolId);
  }
}

export async function ensureProfileDefaultBundledSkills(
  db: DatabaseAdapter,
  profileId: string
): Promise<void> {
  for (const name of DEFAULT_BUNDLED_SKILL_NAMES) {
    const skill = await db.getSkillByName(name);

    if (skill) {
      await db.assignSkillToProfile(profileId, skill.id);
    }
  }
}

export async function ensureProfileSuperAgentBundledSkills(
  db: DatabaseAdapter,
  profileId: string
): Promise<void> {
  for (const name of SUPER_AGENT_BUNDLED_SKILL_NAMES) {
    const skill = await db.getSkillByName(name);

    if (skill) {
      await db.assignSkillToProfile(profileId, skill.id);
    }
  }
}

export async function ensureBundledSkillsAssigned(
  db: DatabaseAdapter
): Promise<void> {
  const organizations = await db.listOrganizations();
  const hasTenantOrganizations = organizations.length > 0;
  const activeOrgIds = new Set(
    organizations.filter((org) => !org.archivedAt).map((org) => org.id)
  );
  const profiles = await db.listProfiles();

  for (const profile of profiles) {
    if (
      hasTenantOrganizations &&
      !(profile.orgId && activeOrgIds.has(profile.orgId))
    ) {
      continue;
    }
    await ensureProfileDefaultBundledSkills(db, profile.id);
  }
}

export async function seedOrgDefaultProfile(
  db: DatabaseAdapter,
  orgId: string
): Promise<StoredProfileRecord> {
  const existing = await db.getDefaultProfileForOrg(orgId);

  if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  const profile: StoredProfileRecord = {
    createdAt: now,
    id: nanoid(),
    isDefault: true,
    isSuper: false,
    model: null,
    name: "Default Agent",
    orgId,
    systemPrompt: "",
    updatedAt: now,
  };

  await db.upsertProfile(profile);
  await ensureProfileDefaultAgentTools(db, profile.id);
  await ensureProfileDefaultBundledSkills(db, profile.id);

  return profile;
}

export async function seedOrgSuperAgentProfile(
  db: DatabaseAdapter,
  orgId: string
): Promise<StoredProfileRecord> {
  const existing = (await db.listProfilesForOrg(orgId)).find(
    (profile) => profile.isSuper
  );

  if (existing) {
    await ensureSuperAgentBashTool(db, existing.id);
    await ensureProfileDefaultBundledSkills(db, existing.id);
    await ensureProfileSuperAgentBundledSkills(db, existing.id);
    return existing;
  }

  const now = new Date().toISOString();
  const profile: StoredProfileRecord = {
    createdAt: now,
    id: nanoid(),
    isDefault: false,
    isSuper: true,
    model: null,
    name: "Super Agent",
    orgId,
    systemPrompt: SUPER_AGENT_SYSTEM_PROMPT,
    updatedAt: now,
  };

  await db.upsertProfile(profile);

  for (const toolId of DEFAULT_BUILTIN_TOOL_IDS) {
    await db.assignToolToProfile(profile.id, toolId);
  }

  await ensureSuperAgentBashTool(db, profile.id);
  await ensureProfileDefaultBundledSkills(db, profile.id);
  await ensureProfileSuperAgentBundledSkills(db, profile.id);

  return profile;
}

export async function ensureOrgSuperAgentProfiles(
  db: DatabaseAdapter
): Promise<void> {
  const orgs = await db.listOrganizations();

  for (const org of orgs) {
    if (org.archivedAt) {
      continue;
    }
    await seedOrgSuperAgentProfile(db, org.id);
  }
}

export const ensureOrgSuperBotProfiles = ensureOrgSuperAgentProfiles;

export async function ensureBashToolDefinition(
  db: DatabaseAdapter
): Promise<void> {
  const now = new Date().toISOString();
  const existing = await db.getTool(BASH_TOOL_ID);

  await db.upsertTool({
    createdAt: existing?.createdAt ?? now,
    description:
      "Run a shell command in the profile workspace and return stdout, stderr, and exit code.",
    handlerConfig: {},
    handlerType: "bash",
    id: BASH_TOOL_ID,
    name: "bash",
    updatedAt: now,
  });
}

export async function ensureGenerateImageToolDefinition(
  db: DatabaseAdapter
): Promise<void> {
  const now = new Date().toISOString();
  const existing = await db.getTool(GENERATE_IMAGE_TOOL_ID);

  await db.upsertTool({
    createdAt: existing?.createdAt ?? now,
    description:
      "Generate an image from a text prompt using the workspace image model (OpenAI gpt-image-2). Saves under artifacts/ with a metadata sidecar.",
    handlerConfig: {},
    handlerType: "generate_image",
    id: GENERATE_IMAGE_TOOL_ID,
    name: "generate_image",
    updatedAt: now,
  });
}

export async function ensureSuperAgentBashTool(
  db: DatabaseAdapter,
  profileId: string
): Promise<void> {
  await ensureBashToolDefinition(db);
  await db.assignToolToProfile(profileId, BASH_TOOL_ID);
}

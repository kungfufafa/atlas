import { cp, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "./fs";
import { getUserConfigDir } from "./user-config";

export type WorkspaceChannel = "telegram" | "discord" | "whatsapp";

export function resolveChannelWorkspaceId(
  orgId?: string | null
): string | null {
  if (orgId === null) {
    return null;
  }

  return orgId?.trim() || process.env.ATLAS_WORKSPACE_ID?.trim() || null;
}

export function getWorkspaceChannelDir(
  channel: WorkspaceChannel,
  orgId?: string | null
): string {
  const workspaceId = resolveChannelWorkspaceId(orgId);
  if (!workspaceId) {
    return join(getUserConfigDir(), channel);
  }

  return join(getUserConfigDir(), "orgs", workspaceId, "channels", channel);
}

export async function listConfiguredChannelWorkspaceIds(
  channel: WorkspaceChannel
): Promise<string[]> {
  const orgsDir = join(getUserConfigDir(), "orgs");
  if (!(await pathExists(orgsDir))) {
    return [];
  }

  const entries = await readdir(orgsDir, { withFileTypes: true });
  const configured: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const configPath = join(
      orgsDir,
      entry.name,
      "channels",
      channel,
      "config.ini"
    );
    if (await pathExists(configPath)) {
      configured.push(entry.name);
    }
  }

  return configured.sort();
}

export async function migrateLegacyChannelToWorkspace(
  channel: WorkspaceChannel,
  orgId: string
): Promise<boolean> {
  const legacyDir = getWorkspaceChannelDir(channel, null);
  const workspaceDir = getWorkspaceChannelDir(channel, orgId);
  const legacyConfig = join(legacyDir, "config.ini");
  const workspaceConfig = join(workspaceDir, "config.ini");

  if (
    !(await pathExists(legacyConfig)) ||
    (await pathExists(workspaceConfig))
  ) {
    return false;
  }

  await cp(legacyDir, workspaceDir, {
    errorOnExist: false,
    force: false,
    recursive: true,
  });
  return true;
}

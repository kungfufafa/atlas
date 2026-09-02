import type { ProfileSummary } from "@atlas/core/contract";

export const sectionClass = "rounded-md border border-border bg-card";
export const profilePanelHeaderClass =
  "flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 sm:px-5";
export const profilePanelHeaderLabelClass =
  "inline-flex items-center px-3 py-2.5 text-sm font-medium text-foreground sm:px-4";
export const profilesTagline =
  "Separate prompt, tools, and knowledge for each bot.";
export const profileTextSaveDelayMs = 1000;
export const profileModelSaveDelayMs = 400;

export type ProfileSaveStatus =
  | "idle"
  | "pending"
  | "saving"
  | "saved"
  | "error";

export type ProfileDetailTab = "history" | "profile" | "prompt" | "proposals";

export function resolveProfileDetailTab(
  value: string | null
): ProfileDetailTab {
  if (value === "history" || value === "prompt" || value === "proposals") {
    return value;
  }

  if (value === "soul") {
    return "prompt";
  }

  return "profile";
}

export type ProfileEditSnapshot = {
  editName: string;
  editPrompt: string;
  editModel: string | null;
  savedName: string;
  savedPrompt: string;
  savedModel: string | null;
};

export function profileHasPendingEdits(snapshot: ProfileEditSnapshot): boolean {
  const name = snapshot.editName.trim();
  if (!name) {
    return false;
  }

  return (
    name !== snapshot.savedName ||
    snapshot.editPrompt !== snapshot.savedPrompt ||
    snapshot.editModel !== snapshot.savedModel
  );
}

export async function flushProfileSave(options: {
  clearScheduledSave: () => void;
  hasPendingEdits: () => boolean;
  isSaving: () => boolean;
  isValid: () => boolean;
  performSave: () => Promise<boolean>;
}): Promise<boolean> {
  options.clearScheduledSave();

  if (!options.isValid()) {
    return false;
  }

  while (options.isSaving() || options.hasPendingEdits()) {
    const saved = await options.performSave();
    options.clearScheduledSave();

    if (!(saved && options.isValid())) {
      return false;
    }
  }

  return true;
}

export async function runExclusiveProfileExport(options: {
  lock: { current: boolean };
  onPendingChange: (pending: boolean) => void;
  run: () => Promise<void>;
}): Promise<boolean> {
  if (options.lock.current) {
    return false;
  }

  options.lock.current = true;

  try {
    options.onPendingChange(true);
    await options.run();
    return true;
  } finally {
    options.lock.current = false;
    options.onPendingChange(false);
  }
}

export async function runProfileExport(options: {
  download: (filename: string, data: ArrayBuffer) => void;
  exportProfile: (
    profileId: string
  ) => Promise<{ data: ArrayBuffer; filename: string }>;
  flushSave: () => Promise<boolean>;
  isCurrentProfile: () => boolean;
  profileId: string;
}): Promise<boolean> {
  if (!(await options.flushSave())) {
    return false;
  }

  if (!options.isCurrentProfile()) {
    return false;
  }

  const archive = await options.exportProfile(options.profileId);
  options.download(archive.filename, archive.data);
  return true;
}

export type RemoveAssignmentTarget =
  | { kind: "tool"; id: string; name: string }
  | { kind: "mcp"; id: string; name: string }
  | { kind: "skill"; id: string; name: string }
  | { kind: "composio"; id: string; name: string };

export function profileSidebarDescription(profile: ProfileSummary): string {
  if (profile.isSuper) {
    return "Super agent";
  }

  const parts: string[] = [];

  if (profile.toolCount > 0) {
    parts.push(
      `${profile.toolCount} tool${profile.toolCount === 1 ? "" : "s"}`
    );
  }

  if (profile.mcpServerCount > 0) {
    parts.push(`${profile.mcpServerCount} MCP`);
  }

  if (parts.length > 0) {
    return parts.join(" · ");
  }

  return profile.isDefault ? "Default profile" : profile.id;
}

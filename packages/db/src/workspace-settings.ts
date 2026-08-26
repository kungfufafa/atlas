import { WORKSPACE_SETTINGS_ID } from "./constants";
import type { DatabaseAdapter, StoredWorkspaceSettingsRecord } from "./types";

const orgMutationLocks = new WeakMap<
  DatabaseAdapter,
  Map<string, Promise<void>>
>();

export function isCodingAgentProviderPassthroughEnabled(
  settings:
    | Pick<StoredWorkspaceSettingsRecord, "codingAgentProviderPassthrough">
    | null
    | undefined
): boolean {
  return settings?.codingAgentProviderPassthrough !== false;
}

function pickDefined<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

export function mergeWorkspaceSettings(
  existing: StoredWorkspaceSettingsRecord | null | undefined,
  patch: Partial<StoredWorkspaceSettingsRecord> = {}
): StoredWorkspaceSettingsRecord {
  return {
    codingAgentHarnesses: pickDefined(
      patch.codingAgentHarnesses,
      existing?.codingAgentHarnesses ?? []
    ),
    codingAgentProviderPassthrough: pickDefined(
      patch.codingAgentProviderPassthrough,
      existing?.codingAgentProviderPassthrough ?? true
    ),
    id: pickDefined(patch.id, existing?.id ?? WORKSPACE_SETTINGS_ID),
    imageModel: pickDefined(patch.imageModel, existing?.imageModel ?? null),
    orgId: patch.orgId === undefined ? existing?.orgId : patch.orgId,
    selectedCodingAgentHarness: pickDefined(
      patch.selectedCodingAgentHarness,
      existing?.selectedCodingAgentHarness ?? null
    ),
    tokenOptimizerEnabled: pickDefined(
      patch.tokenOptimizerEnabled,
      existing?.tokenOptimizerEnabled ?? null
    ),
    transcriptionModel: pickDefined(
      patch.transcriptionModel,
      existing?.transcriptionModel ?? null
    ),
    updatedAt: pickDefined(
      patch.updatedAt,
      existing?.updatedAt ?? new Date().toISOString()
    ),
    visionModel: pickDefined(patch.visionModel, existing?.visionModel ?? null),
  };
}

export async function updateWorkspaceSettingsForOrg(
  db: DatabaseAdapter,
  orgId: string,
  patcher: (
    existing: StoredWorkspaceSettingsRecord | null
  ) => Partial<StoredWorkspaceSettingsRecord>
): Promise<StoredWorkspaceSettingsRecord> {
  const normalizedOrgId = orgId.trim();
  if (!normalizedOrgId) {
    throw new Error("Workspace context is required.");
  }
  const locks = orgMutationLocks.get(db) ?? new Map<string, Promise<void>>();
  orgMutationLocks.set(db, locks);
  const previous = locks.get(normalizedOrgId) ?? Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(normalizedOrgId, current);
  await previous;
  try {
    const existing = await db.getWorkspaceSettings(normalizedOrgId);
    const next = mergeWorkspaceSettings(existing, {
      ...patcher(existing),
      id: existing?.id ?? `workspace-settings:${normalizedOrgId}`,
      orgId: normalizedOrgId,
    });
    await db.upsertWorkspaceSettings(next);
    return next;
  } finally {
    release();
    if (locks.get(normalizedOrgId) === current) {
      locks.delete(normalizedOrgId);
    }
  }
}

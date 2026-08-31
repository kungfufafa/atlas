import {
  AtlasApiError,
  createId,
  isWritableSoulFileKey,
  type WritableSoulFileKey,
  withProfileSoulMutationLock,
  withProfileSoulMutationLocks,
} from "@atlas/core";
import type { ListProfileChangeHistoryResponse } from "@atlas/core/contract";
import type {
  DatabaseAdapter,
  ProfileChangeField,
  ProfileChangeSource,
  StoredProfileChangeEvent,
} from "@atlas/db";

export type ProfileChangeMeta = {
  actorUserId?: string | null;
  source: ProfileChangeSource;
};

type AssignmentField = "mcp" | "skills" | "tools";

type RecordProfileChangeInput = {
  actorUserId?: string | null;
  afterValue: string | null;
  beforeValue: string | null;
  createdAt?: string;
  field: ProfileChangeField;
  orgId: string;
  profileId: string;
  source: ProfileChangeSource;
};

export type ProfileChangeRecordOutcome =
  | { status: "recorded" }
  | { status: "unchanged" }
  | { status: "failed" };

async function listAssignmentIds(
  db: DatabaseAdapter,
  profileId: string,
  field: AssignmentField
): Promise<string[]> {
  switch (field) {
    case "tools":
      return (await db.listToolsForProfile(profileId)).map((entry) => entry.id);
    case "skills":
      return (await db.listSkillsForProfile(profileId)).map(
        (entry) => entry.id
      );
    case "mcp":
      return (await db.listMcpServersForProfile(profileId)).map(
        (entry) => entry.id
      );
  }
}

function serializeAssignmentIds(ids: string[]): string {
  return JSON.stringify([...ids].sort());
}

export class ProfileChangeHistoryService {
  constructor(private readonly db: DatabaseAdapter) {}

  async list(
    orgId: string,
    profileId: string,
    options: { limit?: number; offset?: number } = {}
  ): Promise<ListProfileChangeHistoryResponse> {
    await this.requireProfile(orgId, profileId);
    const events = await this.db.listProfileChangeEvents(
      orgId,
      profileId,
      options
    );
    return { events };
  }

  async record(input: RecordProfileChangeInput): Promise<void> {
    if (input.beforeValue === input.afterValue) {
      return;
    }

    await this.requireProfile(input.orgId, input.profileId);

    const record: StoredProfileChangeEvent = {
      actorUserId: input.actorUserId?.trim() || null,
      afterValue: input.afterValue,
      beforeValue: input.beforeValue,
      createdAt: input.createdAt ?? new Date().toISOString(),
      field: input.field,
      id: createId("profile_change"),
      orgId: input.orgId,
      profileId: input.profileId,
      source: input.source,
    };

    await this.db.createProfileChangeEvent(record);
  }

  /**
   * Profile changes span database and filesystem writes, while the history
   * ledger is stored separately. Callers use this after a mutation commits so
   * an unavailable ledger cannot make a successful mutation look like a 500.
   */
  async recordBestEffort(
    input: RecordProfileChangeInput
  ): Promise<ProfileChangeRecordOutcome> {
    if (input.beforeValue === input.afterValue) {
      return { status: "unchanged" };
    }

    try {
      await this.record(input);
      return { status: "recorded" };
    } catch {
      return { status: "failed" };
    }
  }

  async withAssignmentChange<Result>(
    input: {
      field: AssignmentField;
      meta: ProfileChangeMeta;
      orgId: string;
      profileId: string;
    },
    mutate: () => Promise<Result>
  ): Promise<Result> {
    return withProfileSoulMutationLock(
      input.orgId,
      input.profileId,
      async () => {
        await this.requireProfile(input.orgId, input.profileId);
        const beforeValue = serializeAssignmentIds(
          await listAssignmentIds(this.db, input.profileId, input.field)
        );
        const result = await mutate();

        try {
          const afterValue = serializeAssignmentIds(
            await listAssignmentIds(this.db, input.profileId, input.field)
          );

          await this.recordBestEffort({
            actorUserId: input.meta.actorUserId,
            afterValue,
            beforeValue,
            field: input.field,
            orgId: input.orgId,
            profileId: input.profileId,
            source: input.meta.source,
          });
        } catch {
          // The mutation has already committed. Assignment history is explicitly
          // best-effort until Atlas has a transactional outbox for cross-store work.
        }

        return result;
      }
    );
  }

  async withOrgAssignmentChanges<Result>(
    input: {
      field: AssignmentField;
      meta: ProfileChangeMeta;
      orgId: string;
    },
    mutate: () => Promise<Result>
  ): Promise<Result> {
    const profiles = await this.db.listProfilesForOrg(input.orgId);
    return withProfileSoulMutationLocks(
      profiles.map((profile) => ({
        orgId: input.orgId,
        profileId: profile.id,
      })),
      async () => {
        const beforeAssignments: Array<{
          beforeValue: string;
          profileId: string;
        }> = [];

        for (const profile of profiles) {
          const beforeValue = serializeAssignmentIds(
            await listAssignmentIds(this.db, profile.id, input.field)
          );
          if (beforeValue !== "[]") {
            beforeAssignments.push({ beforeValue, profileId: profile.id });
          }
        }

        const result = await mutate();

        for (const assignment of beforeAssignments) {
          try {
            const afterValue = serializeAssignmentIds(
              await listAssignmentIds(
                this.db,
                assignment.profileId,
                input.field
              )
            );
            await this.recordBestEffort({
              actorUserId: input.meta.actorUserId,
              afterValue,
              beforeValue: assignment.beforeValue,
              field: input.field,
              orgId: input.orgId,
              profileId: assignment.profileId,
              source: input.meta.source,
            });
          } catch {
            // The resource deletion has already committed. Keep ledger follow-up
            // best-effort for the same cross-store reason as single assignments.
          }
        }

        return result;
      }
    );
  }

  private async requireProfile(
    orgId: string,
    profileId: string
  ): Promise<void> {
    const profile = await this.db.getProfileForOrg(profileId, orgId);
    if (!profile) {
      throw new AtlasApiError("Profile not found.", 404);
    }
  }
}

export function requireProfileChangeHistoryService(
  db: DatabaseAdapter | null | undefined
): ProfileChangeHistoryService {
  if (!db) {
    throw new AtlasApiError("Profile change history is not configured.", 500);
  }

  return new ProfileChangeHistoryService(db);
}

export function soulFieldFromFileName(
  fileName: string
): ProfileChangeField | null {
  const key = soulKeyFromFileName(fileName);
  return key ? soulFieldFromKey(key) : null;
}

export function soulFieldFromKey(key: string): ProfileChangeField | null {
  if (!isWritableSoulFileKey(key)) {
    return null;
  }

  return `soul.${key}` as ProfileChangeField;
}

export function soulKeyFromFileName(
  fileName: string
): WritableSoulFileKey | null {
  if (!fileName.endsWith(".md")) {
    return null;
  }

  const key = fileName.slice(0, -3).toLowerCase();
  return isWritableSoulFileKey(key) ? key : null;
}

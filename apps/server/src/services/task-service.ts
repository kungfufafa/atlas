import type {
  CanonicalPrincipal,
  CreateTaskRequest,
  StoredTask,
  TaskRunRecord,
  TaskStatus,
  UpdateTaskRequest,
} from "@atlas/core";
import {
  AtlasApiError,
  createId,
  isServiceAccountUserId,
  runAsPrincipal,
} from "@atlas/core";
import { canAccessSuperAgentProfile } from "@atlas/core/profiles";
import type { DatabaseAdapter, StoredTaskRecord } from "@atlas/db";
import type { TaskRunner } from "./task-runner";
import { isValidTaskStatus, validateTaskInput } from "./task-validate";

/** Caller role context used to gate access to admin-only profiles (e.g. Super Agent). */
export type ProfileAccess = Parameters<typeof canAccessSuperAgentProfile>[0];

export class TaskService {
  private taskRunner: TaskRunner | null = null;

  constructor(private readonly db: DatabaseAdapter) {}

  setTaskRunner(taskRunner: TaskRunner): void {
    this.taskRunner = taskRunner;
  }

  async listForOrg(orgId: string): Promise<StoredTask[]> {
    const records = await this.db.listTasksForOrg(orgId);
    return records.map((record) => this.toStoredTask(record));
  }

  async get(id: string, orgId?: string): Promise<StoredTask | null> {
    const record = await this.db.getTask(id);
    if (!record || (orgId && record.orgId !== orgId)) {
      return null;
    }

    return this.toStoredTask(record);
  }

  async create(
    orgId: string,
    input: CreateTaskRequest,
    profileIdOverride?: string,
    access?: ProfileAccess,
    createdByUserId?: string
  ): Promise<StoredTask> {
    const status = input.status ?? "backlog";
    validateTaskInput({
      prompt: input.prompt,
      status,
      title: input.title,
    });

    const profileId = await this.resolveProfileId(
      orgId,
      profileIdOverride ?? input.profileId,
      access
    );

    const now = new Date().toISOString();
    const ownerId = createdByUserId?.trim() || null;
    const task: StoredTaskRecord = {
      createdAt: now,
      createdByUserId: ownerId,
      description: input.description?.trim() ?? "",
      id: createId("task"),
      orgId,
      position: await this.nextPosition(orgId, status),
      profileId,
      prompt: input.prompt.trim(),
      status,
      title: input.title.trim(),
      updatedAt: now,
    };

    await this.db.upsertTask(task);
    return this.toStoredTask(task);
  }

  async update(
    id: string,
    orgId: string,
    input: UpdateTaskRequest,
    options?: {
      access?: ProfileAccess;
      principal?: CanonicalPrincipal;
      triggerRun?: boolean;
    }
  ): Promise<StoredTask> {
    let existing = await this.db.getTask(id);

    if (!existing || existing.orgId !== orgId) {
      throw new Error("Task not found.");
    }

    const title =
      input.title === undefined ? existing.title : input.title.trim();
    const prompt =
      input.prompt === undefined ? existing.prompt : input.prompt.trim();
    const status = input.status ?? existing.status;

    if (!isValidTaskStatus(status)) {
      throw new Error(`Invalid task status: ${status}`);
    }

    validateTaskInput({ prompt, status, title });

    let profileId = existing.profileId;

    if (input.profileId !== undefined) {
      profileId = await this.resolveProfileId(
        orgId,
        input.profileId,
        options?.access
      );
    }

    const statusChanged = status !== existing.status;

    if (statusChanged && status === "in_progress") {
      existing = await this.claimTaskRecord(existing, options?.principal);
    }

    let position = input.position;

    if (statusChanged && position === undefined) {
      position = await this.nextPosition(orgId, status as TaskStatus);
    } else if (position === undefined) {
      position = existing.position;
    }

    const updated: StoredTaskRecord = {
      ...existing,
      description:
        input.description === undefined
          ? existing.description
          : input.description.trim(),
      position,
      profileId,
      prompt,
      status,
      title,
      updatedAt: new Date().toISOString(),
    };

    await this.db.upsertTask(updated);

    if (
      status === "in_progress" &&
      statusChanged &&
      options?.triggerRun !== false &&
      this.taskRunner
    ) {
      void this.taskRunner.run(id, options?.principal).catch((error) => {
        console.error(`Task run failed for ${id}:`, error);
      });
    }

    return this.toStoredTask(updated);
  }

  async claimForRun(
    taskId: string,
    principal?: CanonicalPrincipal
  ): Promise<StoredTask> {
    const task = await this.db.getTask(taskId);
    if (!task) {
      throw new Error("Task not found.");
    }
    return this.toStoredTask(await this.claimTaskRecord(task, principal));
  }

  async delete(id: string, orgId: string): Promise<boolean> {
    const existing = await this.db.getTask(id);
    if (!existing || existing.orgId !== orgId) {
      return false;
    }

    return this.db.deleteTask(id);
  }

  async createRun(taskId: string): Promise<TaskRunRecord> {
    const run = {
      completedAt: null,
      error: null,
      id: createId("task_run"),
      output: null,
      startedAt: new Date().toISOString(),
      status: "running" as const,
      taskId,
    };

    await this.db.insertTaskRun(run);
    return run;
  }

  async completeRun(
    runId: string,
    taskId: string,
    result: { output?: string; error?: string }
  ): Promise<void> {
    const runs = await this.db.listTaskRuns(taskId, 100);
    const existing = runs.find((run) => run.id === runId);

    if (!existing) {
      return;
    }

    await this.db.updateTaskRun({
      ...existing,
      completedAt: new Date().toISOString(),
      error: result.error ?? null,
      output: result.output ?? null,
      status: result.error ? "failed" : "completed",
    });
  }

  async listRuns(
    taskId: string,
    orgId?: string,
    limit = 20
  ): Promise<TaskRunRecord[]> {
    const task = orgId
      ? await this.get(taskId, orgId)
      : await this.db.getTask(taskId);

    if (!task) {
      throw new Error("Task not found.");
    }

    return this.db.listTaskRuns(taskId, limit);
  }

  async setTaskStatus(taskId: string, status: TaskStatus): Promise<void> {
    const existing = await this.db.getTask(taskId);

    if (!existing?.orgId) {
      return;
    }

    await this.db.upsertTask({
      ...existing,
      position: await this.nextPosition(existing.orgId, status),
      status,
      updatedAt: new Date().toISOString(),
    });
  }

  private async resolveProfileId(
    orgId: string,
    profileId?: string,
    access?: ProfileAccess
  ): Promise<string> {
    const trimmed = profileId?.trim();

    if (trimmed) {
      const profile = await this.db.getProfileForOrg(trimmed, orgId);
      if (profile) {
        if (profile.isSuper && access && !canAccessSuperAgentProfile(access)) {
          throw new AtlasApiError(
            "Super Agent is only available to Workspace Admins and Superadmins.",
            403
          );
        }
        return profile.id;
      }

      throw new Error("Profile not found.");
    }

    const defaultProfile = await this.db.getDefaultProfileForOrg(orgId);
    if (!defaultProfile) {
      throw new Error("No default profile exists for this organization.");
    }

    return defaultProfile.id;
  }

  private async claimTaskRecord(
    task: StoredTaskRecord,
    principal?: CanonicalPrincipal
  ): Promise<StoredTaskRecord> {
    const ownerId = task.createdByUserId?.trim();
    const orgId = task.orgId?.trim();
    if (!orgId) {
      throw new AtlasApiError(
        "Task has no canonical owner and cannot be run.",
        403
      );
    }

    if (ownerId) {
      const actor = principal
        ? await this.resolveCurrentPrincipal(orgId, principal)
        : await this.resolveCurrentUser(orgId, ownerId);
      this.assertOwnedBy(task, actor);
      return task;
    }

    const actor = await this.resolveFirstClaimPrincipal(task, principal);
    const updatedAt = new Date().toISOString();
    await this.db.claimTaskOwner(task.id, orgId, actor.userId, updatedAt);
    const claimed = await this.db.getTask(task.id);
    if (!claimed || claimed.orgId !== orgId) {
      throw new Error("Task not found.");
    }
    this.assertOwnedBy(claimed, actor);
    return claimed;
  }

  private async resolveFirstClaimPrincipal(
    task: StoredTaskRecord,
    explicit?: CanonicalPrincipal
  ): Promise<CanonicalPrincipal> {
    const orgId = task.orgId?.trim();
    if (!orgId) {
      throw new AtlasApiError(
        "Task has no canonical owner and cannot be run.",
        403
      );
    }

    const sessionPrincipal = await this.resolveLinkedSessionPrincipal(task);
    if (sessionPrincipal) {
      if (explicit) {
        const actor = runAsPrincipal(explicit, (value) => value);
        if (actor.orgId !== orgId || actor.userId !== sessionPrincipal.userId) {
          throw new AtlasApiError(
            "Only the task owner can run this task.",
            403
          );
        }
      }
      return sessionPrincipal;
    }

    if (!explicit) {
      throw new AtlasApiError(
        "Canonical principal is required to claim this legacy task.",
        403
      );
    }
    return this.resolveCurrentPrincipal(orgId, explicit);
  }

  private async resolveLinkedSessionPrincipal(
    task: StoredTaskRecord
  ): Promise<CanonicalPrincipal | null> {
    if (!task.sessionId) {
      return null;
    }
    const session = await this.db.getSession(task.sessionId);
    const orgId = task.orgId?.trim();
    const userId = session?.userId?.trim();
    if (
      !(session && orgId && userId) ||
      session.channel !== "task" ||
      session.orgId !== orgId ||
      session.profileId !== task.profileId ||
      isServiceAccountUserId(userId)
    ) {
      return null;
    }
    return this.resolveCurrentUser(orgId, userId);
  }

  private async resolveCurrentPrincipal(
    orgId: string,
    principal: CanonicalPrincipal
  ): Promise<CanonicalPrincipal> {
    const actor = runAsPrincipal(principal, (value) => value);
    if (actor.orgId !== orgId) {
      throw new AtlasApiError("Only the task owner can run this task.", 403);
    }
    return this.resolveCurrentUser(orgId, actor.userId);
  }

  private async resolveCurrentUser(
    orgId: string,
    userId: string
  ): Promise<CanonicalPrincipal> {
    const [member, user] = await Promise.all([
      this.db.getOrgMember(orgId, userId),
      this.db.getUserById(userId),
    ]);
    if (!member || isServiceAccountUserId(userId)) {
      throw new AtlasApiError(
        "Canonical task owner is not a member of this workspace.",
        403
      );
    }
    const actor = runAsPrincipal(
      {
        isPlatformAdmin: user?.isPlatformAdmin === true,
        orgId,
        orgRole: member.role,
        userId,
      },
      (value) => value
    );
    if (actor.orgRole === "viewer" && !actor.isPlatformAdmin) {
      throw new AtlasApiError("Viewers cannot run tasks.", 403);
    }
    return actor;
  }

  private assertOwnedBy(
    task: StoredTaskRecord,
    principal: CanonicalPrincipal
  ): void {
    if (
      task.orgId !== principal.orgId ||
      task.createdByUserId?.trim() !== principal.userId
    ) {
      throw new AtlasApiError("Only the task owner can run this task.", 403);
    }
  }

  private async nextPosition(
    orgId: string,
    status: TaskStatus
  ): Promise<number> {
    const tasks = await this.db.listTasksForOrg(orgId);
    const inColumn = tasks.filter((task) => task.status === status);

    if (inColumn.length === 0) {
      return 0;
    }

    return Math.max(...inColumn.map((task) => task.position)) + 1;
  }

  private toStoredTask(record: StoredTaskRecord): StoredTask {
    if (!isValidTaskStatus(record.status)) {
      throw new Error(`Invalid task status in database: ${record.status}`);
    }

    return {
      createdAt: record.createdAt,
      createdByUserId: record.createdByUserId ?? null,
      description: record.description,
      id: record.id,
      orgId: record.orgId ?? null,
      position: record.position,
      profileId: record.profileId,
      prompt: record.prompt,
      sessionId: record.sessionId ?? null,
      status: record.status,
      title: record.title,
      updatedAt: record.updatedAt,
    };
  }
}

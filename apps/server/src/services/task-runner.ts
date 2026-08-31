import {
  AtlasApiError,
  type CanonicalPrincipal,
  PrincipalRequiredError,
  runAsPrincipal,
  type StoredTask,
} from "@atlas/core";
import type { AgentService } from "./agent-service";
import type { IdentityService } from "./identity-service";
import type { TaskService } from "./task-service";

export class TaskRunner {
  private readonly running = new Set<string>();

  constructor(
    private readonly taskService: TaskService,
    private readonly agentService: AgentService,
    private readonly identityService?: IdentityService
  ) {}

  async run(
    taskId: string,
    explicitPrincipal?: CanonicalPrincipal
  ): Promise<{ output?: string; error?: string; skipped?: boolean }> {
    const task = await this.taskService.claimForRun(taskId, explicitPrincipal);

    const principal = await this.resolvePrincipal(task, explicitPrincipal);

    if (this.running.has(taskId)) {
      return { error: "Task is already running.", skipped: true };
    }

    this.running.add(taskId);

    try {
      const run = await this.taskService.createRun(taskId);

      try {
        const output = await this.agentService.runTaskPrompt(
          taskId,
          task.profileId,
          task.prompt,
          principal
        );

        await this.taskService.completeRun(run.id, taskId, { output });
        await this.taskService.setTaskStatus(taskId, "done");
        return { output };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.taskService.completeRun(run.id, taskId, { error: message });
        await this.taskService.setTaskStatus(taskId, "failed");
        return { error: message };
      }
    } finally {
      this.running.delete(taskId);
    }
  }

  private async resolvePrincipal(
    task: StoredTask,
    explicitPrincipal?: CanonicalPrincipal
  ): Promise<CanonicalPrincipal> {
    const ownerId = task.createdByUserId?.trim();
    const orgId = task.orgId?.trim();
    if (!(ownerId && orgId)) {
      throw new AtlasApiError(
        "Task has no canonical owner and cannot be run.",
        403
      );
    }

    const explicit = explicitPrincipal
      ? runAsPrincipal(explicitPrincipal, (value) => value)
      : undefined;
    if (explicit && (explicit.orgId !== orgId || explicit.userId !== ownerId)) {
      throw new AtlasApiError("Only the task owner can run this task.", 403);
    }

    let principal = explicit;
    if (this.identityService) {
      try {
        principal = await this.identityService.resolveForUser(orgId, ownerId);
      } catch (error) {
        if (error instanceof PrincipalRequiredError) {
          throw new AtlasApiError(error.message, 403);
        }
        throw error;
      }
    }

    if (!principal) {
      throw new AtlasApiError(
        "Canonical principal is required to run this task.",
        403
      );
    }
    if (principal.userId !== ownerId || principal.orgId !== orgId) {
      throw new AtlasApiError("Only the task owner can run this task.", 403);
    }
    if (principal.orgRole === "viewer" && !principal.isPlatformAdmin) {
      throw new AtlasApiError("Viewers cannot run tasks.", 403);
    }

    return principal;
  }

  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }

  getActiveRunCount(): number {
    return this.running.size;
  }

  getActiveTaskIds(): string[] {
    return [...this.running];
  }
}

import {
  assertCanonicalPrincipal,
  type CanonicalPrincipal,
  canAccessSuperAgentProfile,
  cancelSubagent,
  completeSubagent,
  type ExecutionCheckpoint,
  markSubagentRunning,
  nanoid,
  pollSubagent,
  principalFromToolContext,
  type SubagentHandle,
  SubagentLifecycleError,
  startSubagent,
} from "@atlas/core";
import type { DatabaseAdapter } from "@atlas/db";
import {
  DEFAULT_SUB_AGENT_TIMEOUT_MS,
  failSubAgentResult,
  MAX_SUB_AGENT_TIMEOUT_MS,
  type SubAgentRunInput,
  type SubAgentRunResult,
} from "../tools/sub-agent-shared";
import type { AgentService } from "./agent-service";
import type { ExecutionPlaneService } from "./execution-plane-service";

interface LiveSubagent {
  abort: AbortController;
  handle: SubagentHandle;
  parentSignalCleanup?: () => void;
  principal: CanonicalPrincipal;
  result: SubAgentRunResult | null;
  runId: string | null;
  startedAtMs: number;
  work: Promise<void>;
}

export interface SubagentStartInput {
  agentDepth: number;
  clientOrigin?: string;
  context?: string;
  onActivity?: (label: string) => void;
  orgId: string;
  parentRunId?: string | null;
  principal: CanonicalPrincipal;
  profileId: string;
  sessionId?: string;
  signal?: AbortSignal;
  task: string;
  timeoutMs?: number;
}

export class SubagentService {
  private readonly live = new Map<string, LiveSubagent>();

  constructor(
    private readonly agent: Pick<AgentService, "runSubAgentPrompt">,
    private readonly executionPlane?: ExecutionPlaneService,
    private readonly db?: DatabaseAdapter
  ) {}

  async start(input: SubagentStartInput): Promise<SubagentHandle> {
    const principal = assertCanonicalPrincipal(input.principal);
    if (principal.orgId !== input.orgId) {
      throw new SubagentLifecycleError(
        "Subagent orgId must match the principal org."
      );
    }

    await this.assertProfileAccess(input.orgId, input.profileId, principal);

    const budgetMs = clampBudget(input.timeoutMs);
    const id = nanoid();
    let handle = startSubagent({
      budgetMs,
      id,
      parentRunId: input.parentRunId,
      principal,
      task: input.task,
    });

    let runId: string | null = null;
    if (this.executionPlane) {
      const run = await this.executionPlane.startSubagentRun({
        parentRunId: input.parentRunId,
        principal,
        sessionId: id,
      });
      runId = run.id;
    }

    const abort = new AbortController();
    handle = markSubagentRunning(handle);
    const live: LiveSubagent = {
      abort,
      handle,
      principal,
      result: null,
      runId,
      startedAtMs: Date.now(),
      work: Promise.resolve(),
    };
    this.live.set(id, live);

    if (input.signal) {
      const onParentAbort = () => {
        void this.cancel(id, principal).catch(() => {});
      };
      if (input.signal.aborted) {
        onParentAbort();
      } else {
        input.signal.addEventListener("abort", onParentAbort);
        live.parentSignalCleanup = () => {
          input.signal?.removeEventListener("abort", onParentAbort);
        };
      }
    }

    await this.persistSnapshot(live);
    live.work = this.runWork(live, {
      agentDepth: input.agentDepth,
      clientOrigin: input.clientOrigin,
      context: input.context,
      isPlatformAdmin: principal.isPlatformAdmin,
      onActivity: input.onActivity,
      orgId: input.orgId,
      orgRole: principal.orgRole,
      profileId: input.profileId,
      sessionId: input.sessionId,
      signal: abort.signal,
      task: input.task,
      timeoutMs: budgetMs,
      userId: principal.userId,
    });

    return handle;
  }

  async poll(
    id: string,
    principal: CanonicalPrincipal
  ): Promise<SubagentHandle> {
    const live = await this.requireLive(id, principal);
    const polled = pollSubagent(live.handle, Date.now(), live.startedAtMs);
    live.handle = polled;
    if (polled.status === "cancelled" && !live.abort.signal.aborted) {
      live.abort.abort();
    }
    if (isTerminal(polled.status)) {
      await this.finalize(live, polled.status);
    } else {
      await this.persistSnapshot(live);
    }
    return polled;
  }

  async wait(
    id: string,
    principal: CanonicalPrincipal
  ): Promise<{ handle: SubagentHandle; result: SubAgentRunResult }> {
    const live = await this.requireLive(id, principal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budgetWait = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, live.handle.budgetMs + 10);
    });
    try {
      await Promise.race([live.work, budgetWait]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
    const handle = await this.poll(id, principal);
    if (handle.status === "cancelled" && !live.result) {
      live.result = failSubAgentResult("Sub-agent cancelled.");
    }
    return {
      handle,
      result:
        live.result ?? failSubAgentResult("Sub-agent returned no final reply."),
    };
  }

  async cancel(
    id: string,
    principal: CanonicalPrincipal
  ): Promise<SubagentHandle> {
    const live = await this.requireLive(id, principal);
    const cancelled = cancelSubagent(live.handle);
    live.handle = cancelled;
    live.abort.abort();
    live.result = failSubAgentResult("Sub-agent cancelled.");
    await this.finalize(live, "cancelled");
    return cancelled;
  }

  private async runWork(
    live: LiveSubagent,
    input: SubAgentRunInput
  ): Promise<void> {
    try {
      const result = await this.agent.runSubAgentPrompt(input);
      if (live.handle.status === "cancelled") {
        live.result = live.result ?? failSubAgentResult("Sub-agent cancelled.");
        await this.finalize(live, "cancelled");
        return;
      }
      live.result = result;
      live.handle = completeSubagent(
        live.handle,
        result.status === "success" ? "succeeded" : "failed"
      );
      await this.finalize(
        live,
        live.handle.status === "succeeded" ? "succeeded" : "failed"
      );
    } catch (error) {
      if (live.abort.signal.aborted || live.handle.status === "cancelled") {
        live.handle = {
          ...live.handle,
          status: "cancelled",
          updatedAt: new Date().toISOString(),
        };
        live.result = live.result ?? failSubAgentResult("Sub-agent cancelled.");
        await this.finalize(live, "cancelled");
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      live.result = failSubAgentResult(message);
      live.handle = completeSubagent(live.handle, "failed");
      await this.finalize(live, "failed");
    }
  }

  private async requireLive(
    id: string,
    principal: CanonicalPrincipal
  ): Promise<LiveSubagent> {
    const canonical = assertCanonicalPrincipal(principal);
    const live = this.live.get(id);
    if (live) {
      if (
        live.principal.userId !== canonical.userId ||
        live.principal.orgId !== canonical.orgId
      ) {
        throw new SubagentLifecycleError(
          "Subagent is bound to a different principal."
        );
      }
      return live;
    }

    const restored = await this.restoreFromDurable(id, canonical);
    if (!restored) {
      throw new SubagentLifecycleError("Subagent not found.");
    }
    return restored;
  }

  private async restoreFromDurable(
    id: string,
    principal: CanonicalPrincipal
  ): Promise<LiveSubagent | null> {
    if (!this.executionPlane) {
      return null;
    }
    const runs = await this.executionPlane.listActiveRuns({
      kind: "subagent",
      orgId: principal.orgId,
      sessionId: id,
    });
    const stored = runs[0];
    const snapshot = stored?.checkpoint?.subagent;
    if (!(stored && snapshot?.handle)) {
      const all = this.executionPlane
        ? await this.dbGetCompleted(id, principal.orgId)
        : null;
      if (!all) {
        return null;
      }
      const handle = all.handle;
      if (
        handle.principalUserId !== principal.userId ||
        handle.orgId !== principal.orgId
      ) {
        throw new SubagentLifecycleError(
          "Subagent is bound to a different principal."
        );
      }
      const restored: LiveSubagent = {
        abort: new AbortController(),
        handle,
        principal,
        result: all.result,
        runId: all.runId,
        startedAtMs: Date.parse(handle.createdAt) || Date.now(),
        work: Promise.resolve(),
      };
      this.live.set(id, restored);
      return restored;
    }
    return null;
  }

  private async dbGetCompleted(
    id: string,
    orgId: string
  ): Promise<{
    handle: SubagentHandle;
    result: SubAgentRunResult | null;
    runId: string;
  } | null> {
    if (!this.db) {
      return null;
    }
    const runs = await this.db.listExecutionRuns({
      kind: "subagent",
      orgId,
      sessionId: id,
    });
    const stored = runs[0];
    if (!stored?.checkpoint) {
      return null;
    }
    const checkpoint = JSON.parse(stored.checkpoint) as ExecutionCheckpoint;
    const snapshot = checkpoint.subagent;
    if (!snapshot?.handle) {
      return null;
    }
    return {
      handle: snapshot.handle as SubagentHandle,
      result: (snapshot.result as SubAgentRunResult | null) ?? null,
      runId: stored.id,
    };
  }

  private async persistSnapshot(live: LiveSubagent): Promise<void> {
    if (!(this.executionPlane && live.runId)) {
      return;
    }
    await this.executionPlane.saveCheckpoint(live.runId, {
      remainingToolCalls: [],
      resumeStepIndex: 0,
      subagent: {
        handle: live.handle,
        result: live.result,
      },
    });
  }

  private async finalize(
    live: LiveSubagent,
    status: SubagentHandle["status"]
  ): Promise<void> {
    live.parentSignalCleanup?.();
    live.parentSignalCleanup = undefined;
    await this.persistSnapshot(live);
    if (this.executionPlane && live.runId && isTerminal(status)) {
      const mapped =
        status === "succeeded"
          ? "completed"
          : status === "cancelled"
            ? "cancelled"
            : "failed";
      await this.executionPlane.complete(live.runId, mapped);
      await this.persistSnapshot(live);
    }
  }

  private async assertProfileAccess(
    orgId: string,
    profileId: string,
    principal: CanonicalPrincipal
  ): Promise<void> {
    if (!this.db) {
      return;
    }
    const profile = await this.db.getProfileForOrg(profileId, orgId);
    if (profile?.isSuper && !canAccessSuperAgentProfile(principal)) {
      throw new SubagentLifecycleError(
        "Super Agent is only available to Workspace Admins and Superadmins."
      );
    }
  }
}

export function subagentPrincipalFromToolContext(context: {
  isPlatformAdmin?: boolean;
  orgId?: string;
  orgRole?: CanonicalPrincipal["orgRole"];
  userId?: string;
}): CanonicalPrincipal {
  return principalFromToolContext(context);
}

function clampBudget(timeoutMs?: number): number {
  if (!(timeoutMs && Number.isFinite(timeoutMs)) || timeoutMs <= 0) {
    return DEFAULT_SUB_AGENT_TIMEOUT_MS;
  }
  return Math.min(Math.floor(timeoutMs), MAX_SUB_AGENT_TIMEOUT_MS);
}

function isTerminal(status: string): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "cancelled"
  );
}

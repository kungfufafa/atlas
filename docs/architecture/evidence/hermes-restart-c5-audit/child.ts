import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { ChatToolApprovalService } from "/Users/apriansyahrs/Documents/Code/atlas/apps/server/src/services/chat-tool-approval-service.ts";
import { ExecutionPlaneService } from "/Users/apriansyahrs/Documents/Code/atlas/apps/server/src/services/execution-plane-service.ts";
import { SessionTurnRegistry } from "/Users/apriansyahrs/Documents/Code/atlas/apps/server/src/services/session-turn-registry.ts";
import {
  AtlasApiError,
  executeProtectedTool,
  globalApprovalGrantStore,
  runWithUserConfigDir,
  type ToolApprovalInput,
  type ToolDefinition,
} from "/Users/apriansyahrs/Documents/Code/atlas/packages/core/src/index.ts";
import { createSqliteDatabase } from "/Users/apriansyahrs/Documents/Code/atlas/packages/db/src/index.ts";

const [mode, directory, phase] = process.argv.slice(2);
if (
  !(
    directory &&
    ["start", "reopen"].includes(mode ?? "") &&
    ["approval_wait", "before_effect", "after_effect_before_receipt"].includes(
      phase ?? ""
    )
  )
) {
  throw new Error("Invalid fixture arguments");
}
const principal = {
  isPlatformAdmin: false,
  orgId: "restart-org",
  orgRole: "member" as const,
  userId: "restart-user",
};
const sessionId = "restart-session";
const runId = "restart-run";
const approvalId = "restart-approval";
const profileId = "restart-profile";
function emit(value: unknown): void {
  writeSync(1, `${JSON.stringify(value)}\n`);
}
async function blockAtBoundary(value: unknown): Promise<never> {
  emit(value);
  const keepalive = setInterval(() => {}, 1000);
  try {
    return await new Promise<never>(() => {});
  } finally {
    clearInterval(keepalive);
  }
}
function count(): number {
  return readFileSync(join(directory!, "effects.ndjson"), "utf8")
    .split("\n")
    .filter(Boolean).length;
}
await runWithUserConfigDir(join(directory, "config"), async () => {
  const database = await createSqliteDatabase(
    `file:${join(directory, "restart.sqlite")}`
  );
  const db = database.adapter;
  const plane = new ExecutionPlaneService(db);
  const service = new ChatToolApprovalService(db, plane);
  const registry = new SessionTurnRegistry();
  let accessChecks = 0;
  async function beforeDecision(): Promise<void> {
    accessChecks++;
    const member = await db.getOrgMember(principal.orgId, principal.userId);
    const session = await db.getSession(sessionId);
    if (
      member?.role !== "member" ||
      session?.orgId !== principal.orgId ||
      session?.userId !== principal.userId
    ) {
      throw new AtlasApiError("Fixture principal no longer authorized", 403);
    }
  }
  function request(id: string, executionId: string): ToolApprovalInput {
    return {
      approval: {
        createdAt: new Date().toISOString(),
        id,
        status: "pending",
        title: "Disposable counter effect",
        tool: "delete_file",
        toolCallId: `call-${id}`,
      },
      call: {
        arguments: { path: "disposable-counter" },
        id: `call-${id}`,
        name: "delete_file",
      },
      runId: executionId,
    };
  }
  async function snapshot() {
    const approval = await db.getActionApproval(approvalId);
    return {
      accessChecks,
      approval,
      counter: count(),
      history: await db.getConversationHistory(sessionId),
      oldGrantInProcess: approval?.grantId
        ? (globalApprovalGrantStore.getGrant(approval.grantId) ?? null)
        : null,
      registry: registry.getStatus(sessionId),
      run: await db.getExecutionRun(runId),
      steps: await db.listExecutionSteps(runId),
    };
  }
  if (mode === "start") {
    const now = new Date().toISOString();
    await db.upsertOrganization({
      createdAt: now,
      id: principal.orgId,
      name: "Restart",
      slug: "restart",
      updatedAt: now,
    });
    await db.createUser({
      createdAt: now,
      email: "restart@example.invalid",
      id: principal.userId,
      name: "Fixture",
      passwordHash: "fixture-not-auth",
      updatedAt: now,
    });
    await db.upsertOrgMember({
      createdAt: now,
      orgId: principal.orgId,
      role: "member",
      userId: principal.userId,
    });
    await db.upsertProfile({
      createdAt: now,
      id: profileId,
      isDefault: true,
      isSuper: false,
      model: "no-provider-fixture",
      name: "Restart",
      orgId: principal.orgId,
      systemPrompt: "No model runs",
      updatedAt: now,
    });
    await db.upsertSession({
      agentQuestionnaire: null,
      agentTodos: [],
      channel: "web",
      createdAt: now,
      id: sessionId,
      modelOverride: null,
      orgId: principal.orgId,
      profileId,
      title: null,
      userId: principal.userId,
    });
    registry.beginTurn(sessionId, principal.orgId);
    const input = request(approvalId, runId);
    const ready = Promise.withResolvers<void>();
    const waiting = service.request(
      { ...input, beforeDecision, principal, sessionId },
      ready.resolve
    );
    await ready.promise;
    if (phase === "approval_wait") {
      return await blockAtBoundary({
        event: "boundary",
        phase,
        state: await snapshot(),
      });
    }
    await service.decide({
      approvalId,
      decision: "approved",
      principal,
      sessionId,
    });
    const decision = await waiting;
    if (decision.decision !== "approved") {
      throw new Error("Fixture approval did not resolve");
    }
    const tool: ToolDefinition = {
      description: "Disposable non-idempotent effect; no real file is deleted",
      name: "delete_file",
      run: async () => {
        if (phase === "before_effect") {
          return await blockAtBoundary({
            event: "boundary",
            phase,
            state: await snapshot(),
          });
        }
        const fd = openSync(join(directory, "effects.ndjson"), "a");
        try {
          writeSync(fd, '{"effect":"counter-increment"}\n');
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        return await blockAtBoundary({
          event: "boundary",
          phase,
          state: await snapshot(),
        });
      },
    };
    const result = await executeProtectedTool(tool, input.call.arguments, {
      approvalGrantId: decision.grantId,
      orgId: principal.orgId,
      orgRole: principal.orgRole,
      profileId,
      runId,
      sessionId,
      userId: principal.userId,
      workspaceRoot: join(directory, "workspace"),
    });
    throw new Error(
      `Tool unexpectedly returned before kill: ${JSON.stringify(result)}`
    );
  }
  const initial = await snapshot();
  let oldDecision: unknown;
  try {
    oldDecision = {
      resolved: await service.decide({
        approvalId,
        decision: "approved",
        principal,
        sessionId,
      }),
    };
  } catch (error) {
    oldDecision = {
      message: error instanceof Error ? error.message : String(error),
      rejected: true,
      status: error instanceof AtlasApiError ? error.status : null,
    };
  }
  const afterOldDecision = await snapshot();
  const freshInput = request("fresh-approval", "fresh-run");
  const ready = Promise.withResolvers<void>();
  const freshWaiting = service.request(
    { ...freshInput, beforeDecision, principal, sessionId },
    ready.resolve
  );
  await ready.promise;
  const freshBefore = {
    accessChecks,
    approval: await db.getActionApproval("fresh-approval"),
    counter: count(),
    run: await db.getExecutionRun("fresh-run"),
  };
  const freshDecision = await service.decide({
    approvalId: "fresh-approval",
    decision: "approved",
    principal,
    sessionId,
  });
  const freshResolution = await freshWaiting;
  const freshAfter = {
    accessChecks,
    approval: await db.getActionApproval("fresh-approval"),
    counter: count(),
    run: await db.getExecutionRun("fresh-run"),
    steps: await db.listExecutionSteps("fresh-run"),
  };
  // A new approval is evidence of a new live interaction. Deliberately do not execute/replay the counter effect.
  await service.complete("fresh-run", "cancelled");
  const freshCleanup = {
    approval: await db.getActionApproval("fresh-approval"),
    counter: count(),
    run: await db.getExecutionRun("fresh-run"),
    steps: await db.listExecutionSteps("fresh-run"),
  };
  emit({
    afterOldDecision,
    automaticMutationReplays: 0,
    event: "reopened",
    freshAfter,
    freshBefore,
    freshCleanup,
    freshDecision,
    freshResolution,
    initial,
    oldDecision,
    oldFinal: await snapshot(),
    phase,
    pid: process.pid,
    providerCalls: 0,
  });
  database.close();
});

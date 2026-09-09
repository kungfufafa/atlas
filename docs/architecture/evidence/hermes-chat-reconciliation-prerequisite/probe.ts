import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ChatToolApprovalService } from "./source/apps/server/src/services/chat-tool-approval-service.ts";
import { ExecutionPlaneService } from "./source/apps/server/src/services/execution-plane-service.ts";
import { SessionTurnRegistry } from "./source/apps/server/src/services/session-turn-registry.ts";
import {
  executeProtectedTool,
  type ToolApprovalInput,
} from "./source/packages/core/src/index.ts";
import {
  createSqliteDatabase,
  type DatabaseAdapter,
  type StoredExecutionRunRecord,
} from "./source/packages/db/src/index.ts";

const base = "/private/tmp/atlas-chat-reconciliation-design-c5";
const output = await mkdtemp(join(base, "probe-"));
const principal = {
  isPlatformAdmin: false,
  orgId: "ownership-org",
  orgRole: "member" as const,
  userId: "ownership-user",
};
const events: unknown[] = [];
function emit(event: unknown) {
  events.push(event);
  console.log(JSON.stringify(event));
}
function barrier() {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  return { entered, release };
}
const handles: { close(): void }[] = [];
const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
async function fixture(name: string) {
  const folder = join(output, name);
  await mkdir(folder);
  await mkdir(join(folder, "workspace"));
  await writeFile(join(folder, "effects.ndjson"), "");
  const a = await createSqliteDatabase(`file:${join(folder, "state.sqlite")}`);
  const b = await createSqliteDatabase(`file:${join(folder, "state.sqlite")}`);
  handles.push(a, b);
  const db = a.adapter;
  const recovery = b.adapter;
  const now = new Date().toISOString();
  await db.upsertOrganization({
    createdAt: now,
    id: principal.orgId,
    name: "Ownership",
    slug: "ownership",
    updatedAt: now,
  });
  await db.createUser({
    createdAt: now,
    email: "ownership@example.invalid",
    id: principal.userId,
    name: "Fixture",
    passwordHash: "fixture",
    updatedAt: now,
  });
  const hooks: {
    run?: (record: StoredExecutionRunRecord) => Promise<void>;
    step?: (record: unknown) => Promise<void>;
    approval?: (record: { status: string }) => Promise<void>;
  } = {};
  const writer = new Proxy(db, {
    get(target, key) {
      if (key === "upsertExecutionRun") {
        return async (record: StoredExecutionRunRecord) => {
          await hooks.run?.(record);
          await target.upsertExecutionRun(record);
        };
      }
      if (key === "upsertExecutionStep") {
        return async (
          record: Parameters<DatabaseAdapter["upsertExecutionStep"]>[0]
        ) => {
          await hooks.step?.(record);
          await target.upsertExecutionStep(record);
        };
      }
      if (key === "upsertActionApproval") {
        return async (
          record: Parameters<DatabaseAdapter["upsertActionApproval"]>[0]
        ) => {
          await hooks.approval?.(record);
          await target.upsertActionApproval(record);
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const plane = new ExecutionPlaneService(writer);
  const service = new ChatToolApprovalService(writer, plane);
  const registry = new SessionTurnRegistry();
  const sessionId = `session-${name}`;
  const runId = `run-${name}`;
  const approvalId = `approval-${name}`;
  registry.beginTurn(sessionId, principal.orgId);
  const request: ToolApprovalInput = {
    approval: {
      createdAt: now,
      id: approvalId,
      status: "pending",
      title: "Disposable effect",
      tool: "delete_file",
      toolCallId: `call-${name}`,
    },
    call: {
      arguments: { path: "disposable-counter" },
      id: `call-${name}`,
      name: "delete_file",
    },
    runId,
  };
  const ready = Promise.withResolvers<void>();
  const waiting = service.request(
    { ...request, beforeDecision: async () => {}, principal, sessionId },
    ready.resolve
  );
  void waiting.catch(() => {});
  await ready.promise;
  return {
    approvalId,
    db,
    folder,
    hooks,
    initial: await db.getExecutionRun(runId),
    name,
    plane,
    recovery,
    registry,
    request,
    runId,
    service,
    sessionId,
    waiting,
  };
}
async function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    approval: await f.db.getActionApproval(f.approvalId),
    counter: (await readFile(join(f.folder, "effects.ndjson"), "utf8"))
      .split("\n")
      .filter(Boolean).length,
    registry: f.registry.getStatus(f.sessionId),
    run: await f.db.getExecutionRun(f.runId),
    steps: await f.db.listExecutionSteps(f.runId),
  };
}
async function cancelByCas(f: Awaited<ReturnType<typeof fixture>>) {
  const old = (await f.recovery.getExecutionRun(f.runId))!;
  const at = new Date().toISOString();
  assert(Date.parse(old.leaseExpiresAt!) < Date.now());
  const next = {
    ...old,
    checkpoint: null,
    leaseExpiresAt: null,
    leaseOwner: null,
    status: "cancelled",
    updatedAt: at,
  };
  const result = await f.recovery.casExecutionRun({
    expectedLeaseOwner: old.leaseOwner!,
    id: f.runId,
    next,
    nowIso: at,
    requireExpiredLease: true,
  });
  assert.equal(result, true);
  return {
    at,
    oldOwner: old.leaseOwner,
    stored: await f.recovery.getExecutionRun(f.runId),
  };
}
try {
  for (const name of [
    "late-approval",
    "late-checkpoint",
    "late-cleanup-receipt",
  ]) {
    fixtures.push(await fixture(name));
  }
  const [approval, checkpoint, receipt] = fixtures as [
    (typeof fixtures)[number],
    (typeof fixtures)[number],
    (typeof fixtures)[number],
  ];
  await receipt.service.decide({
    approvalId: receipt.approvalId,
    decision: "approved",
    principal,
    sessionId: receipt.sessionId,
  });
  const allowed = await receipt.waiting;
  assert.equal(allowed.decision, "approved");
  assert(allowed.decision === "approved");
  const actual = await executeProtectedTool(
    {
      description: "Disposable counter effect",
      name: "delete_file",
      run: async () => {
        await writeFile(
          join(receipt.folder, "effects.ndjson"),
          '{"effect":"one"}\n'
        );
        return { effectCount: 1 };
      },
    },
    receipt.request.call.arguments,
    {
      approvalGrantId: allowed.grantId,
      orgId: principal.orgId,
      runId: receipt.runId,
      sessionId: receipt.sessionId,
      userId: principal.userId,
      workspaceRoot: join(receipt.folder, "workspace"),
    }
  );
  assert.equal(actual.success, true);
  const initial = await Promise.all(fixtures.map(snapshot));
  const maxExpiry = Math.max(
    ...initial.map((x) => Date.parse(x.run!.leaseExpiresAt!))
  );
  const waitMs = Math.max(0, maxExpiry - Date.now() + 70);
  emit({ event: "waiting-for-real-expiry", initial, pid: process.pid, waitMs });
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  const expiredLive = await Promise.all(fixtures.map(snapshot));
  for (let i = 0; i < 3; i++) {
    assert.equal(
      expiredLive[i]!.run!.leaseExpiresAt,
      initial[i]!.run!.leaseExpiresAt
    );
    assert(Date.parse(expiredLive[i]!.run!.leaseExpiresAt!) < Date.now());
    assert.equal(expiredLive[i]!.registry.active, true);
  }
  emit({
    at: new Date().toISOString(),
    event: "live-process-leases-expired",
    states: expiredLive,
  });
  // Hypothetical CAS-only reconciliation races an already admitted live decision.
  const approvalGate = barrier();
  approval.hooks.approval = async (record) => {
    if (record.status === "approved") {
      approvalGate.entered.resolve();
      await approvalGate.release.promise;
    }
  };
  const decision = approval.service.decide({
    approvalId: approval.approvalId,
    decision: "approved",
    principal,
    sessionId: approval.sessionId,
  });
  await approvalGate.entered.promise;
  const approvalFence = await cancelByCas(approval);
  const oldStep = (
    await approval.recovery.listExecutionSteps(approval.runId)
  )[0]!;
  const oldApproval = (await approval.recovery.getActionApproval(
    approval.approvalId
  ))!;
  await approval.recovery.upsertExecutionStep({
    ...oldStep,
    resultJson: JSON.stringify({ errorCode: "UNCONFIRMED_RESULT" }),
    status: "failed",
    updatedAt: new Date().toISOString(),
  });
  await approval.recovery.upsertActionApproval({
    ...oldApproval,
    status: "expired",
  });
  const approvalAfterRecovery = await snapshot(approval);
  approvalGate.release.resolve();
  const resolved = await decision;
  const grant = await approval.waiting;
  assert.equal(grant.decision, "approved");
  const lateApproval = await snapshot(approval);
  assert.equal(approvalAfterRecovery.run!.status, "cancelled");
  assert.equal(lateApproval.run!.status, "running");
  assert.equal(lateApproval.approval!.status, "approved");
  assert.equal(lateApproval.steps[0]!.status, "running");
  emit({
    afterLateWriter: lateApproval,
    afterRecovery: approvalAfterRecovery,
    decision: resolved,
    event: "late-approval-resurrected-terminal-run",
    fence: approvalFence,
    grantResolved: grant.decision,
  });
  // saveCheckpoint captured the old row; its later upsert restores old ownership/status.
  const checkpointGate = barrier();
  checkpoint.hooks.run = async () => {
    checkpointGate.entered.resolve();
    await checkpointGate.release.promise;
  };
  const saving = checkpoint.plane.saveCheckpoint(checkpoint.runId, {
    remainingToolCalls: [],
    resumeStepIndex: 99,
  });
  await checkpointGate.entered.promise;
  const checkpointFence = await cancelByCas(checkpoint);
  checkpointGate.release.resolve();
  await saving;
  const lateCheckpoint = await snapshot(checkpoint);
  assert.equal(lateCheckpoint.run!.status, "awaiting_approval");
  assert.equal(lateCheckpoint.run!.leaseOwner, checkpointFence.oldOwner);
  assert.equal(JSON.parse(lateCheckpoint.run!.checkpoint!).resumeStepIndex, 99);
  emit({
    afterLateWriter: lateCheckpoint,
    event: "late-checkpoint-restored-stale-owner",
    fence: checkpointFence,
  });
  // Old cleanup captured a running step without a receipt. A newly persisted genuine receipt must survive, but does not.
  const receiptGate = barrier();
  receipt.hooks.step = async () => {
    receiptGate.entered.resolve();
    await receiptGate.release.promise;
  };
  const completing = receipt.service.complete(receipt.runId, "cancelled", []);
  await receiptGate.entered.promise;
  const receiptFence = await cancelByCas(receipt);
  const step = (await receipt.recovery.listExecutionSteps(receipt.runId))[0]!;
  await receipt.recovery.upsertExecutionStep({
    ...step,
    resultJson: JSON.stringify(actual.data),
    status: "succeeded",
    updatedAt: new Date().toISOString(),
  });
  const durableReceipt = await snapshot(receipt);
  receiptGate.release.resolve();
  await completing;
  const lateCleanup = await snapshot(receipt);
  assert.equal(durableReceipt.steps[0]!.status, "succeeded");
  assert.equal(JSON.parse(durableReceipt.steps[0]!.resultJson!).effectCount, 1);
  assert.equal(lateCleanup.steps[0]!.status, "failed");
  assert.equal(
    JSON.parse(lateCleanup.steps[0]!.resultJson!).errorCode,
    "UNCONFIRMED_RESULT"
  );
  assert.equal(lateCleanup.counter, 1);
  emit({
    afterLateWriter: lateCleanup,
    afterReceiptPersistence: durableReceipt,
    event: "late-cleanup-overwrote-genuine-receipt",
    fence: receiptFence,
    genuineExecutorResult: actual,
  });
  const results = {
    automaticRecoveryExistsInProduct: false,
    cases: 3,
    events,
    productChanges: 0,
    providerCalls: 0,
    realLeaseWaitMs: waitMs,
    rootChanges: 0,
    status: "completed-counterexamples-to-cas-only-recovery",
  };
  await writeFile(
    join(output, "results.json"),
    JSON.stringify(results, null, 2) + "\n"
  );
  emit({ cases: 3, event: "completed", output });
} catch (error) {
  await writeFile(
    join(output, "failure.json"),
    JSON.stringify({ error: String(error), events }, null, 2) + "\n"
  );
  throw error;
} finally {
  for (const f of fixtures) {
    f.service.cancelSession(f.sessionId);
  }
  for (const h of handles) {
    h.close();
  }
}

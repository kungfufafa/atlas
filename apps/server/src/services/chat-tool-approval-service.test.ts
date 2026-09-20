import { describe, expect, test } from "bun:test";
import {
  AtlasApiError,
  executeProtectedTool,
  type ToolApprovalInput,
  type ToolDefinition,
} from "@atlas/core";
import { SYNTHETIC_SECRET_FIXTURES } from "@atlas/core/testing/synthetic-secret-fixtures";
import {
  runSendWhatsApp,
  sendWhatsAppTool,
} from "@atlas/core/tools/send-whatsapp";
import { createInMemoryDatabaseAdapter } from "@atlas/db";
import { ChatToolApprovalService } from "./chat-tool-approval-service";
import { ExecutionPlaneService } from "./execution-plane-service";

const principal = {
  isPlatformAdmin: false,
  orgId: "approval-org",
  orgRole: "member" as const,
  userId: "approval-user",
};
const sessionId = "approval-session";

async function fixture(customTool?: ToolDefinition) {
  const db = createInMemoryDatabaseAdapter();
  const now = new Date().toISOString();
  await db.upsertOrganization({
    createdAt: now,
    id: principal.orgId,
    name: "Approvals",
    slug: "approvals",
    updatedAt: now,
  });
  await db.createUser({
    createdAt: now,
    email: "approval@example.com",
    id: principal.userId,
    name: "Approver",
    passwordHash: "x",
    updatedAt: now,
  });
  const plane = new ExecutionPlaneService(db);
  const service = new ChatToolApprovalService(db, plane);
  let effects = 0;
  const tool: ToolDefinition = customTool ?? {
    description: "Delete an artifact",
    name: "delete_file",
    run: () => {
      effects += 1;
      return Promise.resolve({ deleted: true });
    },
  };
  function begin(
    options: {
      beforeDecision?: () => Promise<void>;
      args?: Record<string, unknown>;
      id?: string;
      signal?: AbortSignal;
    } = {}
  ) {
    const id = options.id ?? "approval-one";
    const ready = Promise.withResolvers<void>();
    const request: ToolApprovalInput = {
      approval: {
        createdAt: now,
        id,
        status: "pending",
        title: "Delete artifact",
        tool: tool.name,
        toolCallId: `call-${id}`,
      },
      call: {
        arguments: options.args ?? { path: "artifacts/report.txt" },
        id: `call-${id}`,
        name: tool.name,
      },
      runId: "approval-run",
      signal: options.signal,
    };
    const waiting = service.request(
      {
        ...request,
        beforeDecision: options.beforeDecision ?? (() => Promise.resolve()),
        principal,
        sessionId,
      },
      ready.resolve
    );
    // Cancellation tests intentionally reject before awaiting the final outcome.
    void waiting.catch(() => undefined);
    return { ready: ready.promise, request, waiting };
  }
  return { begin, db, effects: () => effects, plane, service, tool };
}

describe("live chat tool approvals", () => {
  test("persists before announcing, authorizes the exact effect, and completes the run", async () => {
    const context = await fixture();
    const pending = context.begin();
    await pending.ready;
    expect(
      (await context.db.getActionApproval(pending.request.approval.id))?.status
    ).toBe("pending");
    expect((await context.db.getExecutionRun("approval-run"))?.status).toBe(
      "awaiting_approval"
    );
    expect(context.effects()).toBe(0);
    await context.service.decide({
      approvalId: pending.request.approval.id,
      decision: "approved",
      principal,
      sessionId,
    });
    const decision = await pending.waiting;
    if (decision.decision !== "approved") {
      throw new Error("Expected authorization");
    }
    const result = await executeProtectedTool(
      context.tool,
      pending.request.call.arguments,
      {
        approvalGrantId: decision.grantId,
        orgId: principal.orgId,
        runId: "approval-run",
        sessionId,
        userId: principal.userId,
      }
    );
    expect(result.success).toBe(true);
    expect(context.effects()).toBe(1);
    const replay = await executeProtectedTool(
      context.tool,
      pending.request.call.arguments,
      {
        approvalGrantId: decision.grantId,
        orgId: principal.orgId,
        sessionId,
        userId: principal.userId,
      }
    );
    expect(replay.success).toBe(false);
    expect(context.effects()).toBe(1);
    await context.service.complete("approval-run", "completed", [
      { call: pending.request.call, content: JSON.stringify(result.data) },
    ]);
    expect(
      (await context.db.listExecutionSteps("approval-run"))[0]
    ).toMatchObject({ resultJson: '{"deleted":true}', status: "succeeded" });
    expect((await context.db.getExecutionRun("approval-run"))?.status).toBe(
      "completed"
    );
  });

  test("denial resolves without a grant or effect and allows a later approval in the same run", async () => {
    const context = await fixture();
    const first = context.begin();
    await first.ready;
    expect(
      await context.service.decide({
        approvalId: first.request.approval.id,
        decision: "denied",
        principal,
        sessionId,
      })
    ).toEqual({ resumed: true, status: "denied" });
    expect(await first.waiting).toEqual({ decision: "denied" });
    expect(context.effects()).toBe(0);
    expect(
      (await context.db.getActionApproval(first.request.approval.id))?.grantId
    ).toBeNull();
    const second = context.begin({ id: "approval-two" });
    await second.ready;
    await context.service.decide({
      approvalId: second.request.approval.id,
      decision: "denied",
      principal,
      sessionId,
    });
    await second.waiting;
    expect(
      (await context.db.listExecutionSteps("approval-run")).map(
        (step) => step.stepIndex
      )
    ).toEqual([0, 1]);
  });

  test("concurrent decisions claim one live waiter and issue one grant", async () => {
    const context = await fixture();
    const pending = context.begin();
    await pending.ready;
    const input = {
      approvalId: pending.request.approval.id,
      decision: "approved" as const,
      principal,
      sessionId,
    };
    const results = await Promise.allSettled([
      context.service.decide(input),
      context.service.decide(input),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected")
    ).toHaveLength(1);
    const decision = await pending.waiting;
    expect(decision.decision).toBe("approved");
    const originalGrant = (await context.db.getActionApproval(input.approvalId))
      ?.grantId;
    expect(await context.service.decide(input)).toEqual({
      resumed: true,
      status: "approved",
    });
    expect(
      (await context.db.getActionApproval(input.approvalId))?.grantId
    ).toBe(originalGrant);
    await expect(
      context.service.decide({ ...input, decision: "denied" })
    ).rejects.toMatchObject({ status: 409 });
  });

  test("cancel removes the waiter and a stored approval never resumes after restart", async () => {
    const context = await fixture();
    const abort = new AbortController();
    const pending = context.begin({ signal: abort.signal });
    await pending.ready;
    abort.abort(new DOMException("Cancelled", "AbortError"));
    await expect(pending.waiting).rejects.toMatchObject({ name: "AbortError" });
    const decision = {
      approvalId: pending.request.approval.id,
      decision: "approved" as const,
      principal,
      sessionId,
    };
    await expect(context.service.decide(decision)).rejects.toMatchObject({
      status: 409,
    });
    const restarted = new ChatToolApprovalService(context.db, context.plane);
    await expect(restarted.decide(decision)).rejects.toMatchObject({
      status: 409,
    });
    expect(
      (await context.db.getActionApproval(pending.request.approval.id))?.grantId
    ).toBeNull();
    expect(context.effects()).toBe(0);
  });

  test("revalidates access on decision and rejects both the request and the decision after revocation", async () => {
    const context = await fixture();
    let revoked = false;
    const pending = context.begin({
      beforeDecision: async () => {
        if (revoked) {
          throw new AtlasApiError("Access revoked", 403);
        }
        await Promise.resolve();
      },
    });
    await pending.ready;
    revoked = true;
    await expect(
      context.service.decide({
        approvalId: pending.request.approval.id,
        decision: "approved",
        principal,
        sessionId,
      })
    ).rejects.toMatchObject({ status: 403 });
    await expect(pending.waiting).rejects.toMatchObject({ status: 403 });
    expect(
      (await context.db.getActionApproval(pending.request.approval.id))?.grantId
    ).toBeNull();
  });

  test("revocation during persistence prevents announcing or accepting the approval", async () => {
    const context = await fixture();
    let revoked = false;
    const saveApproval = context.db.upsertActionApproval.bind(context.db);
    context.db.upsertActionApproval = async (record) => {
      await saveApproval(record);
      revoked = true;
    };
    const pending = context.begin({
      beforeDecision: () => {
        if (revoked) {
          return Promise.reject(new AtlasApiError("Access revoked", 403));
        }
        return Promise.resolve();
      },
    });
    let announced = false;
    void pending.ready.then(() => {
      announced = true;
    });
    await expect(pending.waiting).rejects.toMatchObject({ status: 403 });
    expect(announced).toBe(false);
    await expect(
      context.service.decide({
        approvalId: pending.request.approval.id,
        decision: "approved",
        principal,
        sessionId,
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(context.effects()).toBe(0);
  });

  test("cancellation during decision validation prevents issuing an execution grant", async () => {
    const context = await fixture();
    const abort = new AbortController();
    const validating = Promise.withResolvers<void>();
    const releaseValidation = Promise.withResolvers<void>();
    let deciding = false;
    const pending = context.begin({
      beforeDecision: async () => {
        if (deciding) {
          validating.resolve();
          await releaseValidation.promise;
        }
      },
      signal: abort.signal,
    });
    await pending.ready;
    deciding = true;
    const decision = context.service.decide({
      approvalId: pending.request.approval.id,
      decision: "approved",
      principal,
      sessionId,
    });
    await validating.promise;
    abort.abort(new DOMException("Cancelled", "AbortError"));
    await expect(pending.waiting).rejects.toMatchObject({ name: "AbortError" });
    releaseValidation.resolve();
    await expect(decision).rejects.toMatchObject({ name: "AbortError" });
    expect(
      (await context.db.getActionApproval(pending.request.approval.id))?.grantId
    ).toBeNull();
  });

  test.each(["session", "org"] as const)(
    "%s invalidation cancels pending requests",
    async (scope) => {
      const context = await fixture();
      const pending = context.begin();
      await pending.ready;
      if (scope === "session") {
        context.service.cancelSession(sessionId);
      } else {
        context.service.cancelOrg(principal.orgId);
      }
      await expect(pending.waiting).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(context.effects()).toBe(0);
    }
  );

  test("session, tenant, and principal checks do not consume another caller's waiter", async () => {
    const context = await fixture();
    const pending = context.begin();
    await pending.ready;
    const input = {
      approvalId: pending.request.approval.id,
      decision: "denied" as const,
      principal,
      sessionId,
    };
    await expect(
      context.service.decide({ ...input, sessionId: "other-session" })
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      context.service.decide({
        ...input,
        principal: { ...principal, orgId: "other-org" },
      })
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      context.service.decide({
        ...input,
        principal: { ...principal, userId: "other-user" },
      })
    ).rejects.toMatchObject({ status: 403 });
    await context.service.decide(input);
    expect(await pending.waiting).toEqual({ decision: "denied" });
  });
});

test.each([false, true])(
  "approval audit records actual outcomes and redacts receipts (failed=%s)",
  async (failed) => {
    const context = await fixture();
    const pending = context.begin();
    await pending.ready;
    await context.service.decide({
      approvalId: pending.request.approval.id,
      decision: "approved",
      principal,
      sessionId,
    });
    await pending.waiting;
    await context.service.complete("approval-run", "completed", [
      {
        call: pending.request.call,
        content: JSON.stringify({
          ...(failed ? { error: "Write rejected" } : { deleted: true }),
          token: SYNTHETIC_SECRET_FIXTURES.openAiApiKey,
        }),
      },
    ]);
    const step = (await context.db.listExecutionSteps("approval-run"))[0]!;
    expect(step.status).toBe(failed ? "failed" : "succeeded");
    expect(step.resultJson).not.toContain(
      SYNTHETIC_SECRET_FIXTURES.openAiApiKey
    );
  }
);

test("an interrupted pending approval expires and never leaves its execution step running", async () => {
  const context = await fixture();
  const pending = context.begin();
  await pending.ready;
  await context.service.complete("approval-run", "cancelled");
  await expect(pending.waiting).rejects.toBeInstanceOf(Error);
  expect(
    (await context.db.getActionApproval(pending.request.approval.id))?.status
  ).toBe("expired");
  expect((await context.db.listExecutionSteps("approval-run"))[0]?.status).toBe(
    "skipped"
  );
  expect((await context.db.getExecutionRun("approval-run"))?.status).toBe(
    "cancelled"
  );
});

test.each([
  { error: "The requested operation failed." },
  { success: false },
  { ok: false },
  { isError: true },
])(
  "approval history records an explicit failed operation: %j",
  async (payload) => {
    const context = await fixture();
    const pending = context.begin();
    await pending.ready;
    await context.service.decide({
      approvalId: pending.request.approval.id,
      decision: "approved",
      principal,
      sessionId,
    });
    const decision = await pending.waiting;
    if (decision.decision !== "approved") {
      throw new Error("Expected authorization");
    }
    const result = await executeProtectedTool(
      { ...context.tool, run: () => Promise.resolve(payload) },
      pending.request.call.arguments,
      {
        approvalGrantId: decision.grantId,
        orgId: principal.orgId,
        runId: "approval-run",
        sessionId,
        userId: principal.userId,
      }
    );
    expect(result.data).toEqual(payload);
    await context.service.complete("approval-run", "completed", [
      { call: pending.request.call, content: JSON.stringify(result.data) },
    ]);
    const step = (await context.db.listExecutionSteps("approval-run"))[0]!;
    expect(step.status).toBe("failed");
    expect(JSON.parse(step.resultJson!)).toEqual(payload);
  }
);

test("one batch approval binds every recipient and preserves partial results in the durable audit", async () => {
  const sent: string[] = [];
  const tool: ToolDefinition = {
    ...sendWhatsAppTool,
    run: (input, context) =>
      runSendWhatsApp(input, context, async (payload) => {
        sent.push(payload.to);
        return payload.to.endsWith("2")
          ? { error: "Unconfirmed worker response", ok: false }
          : { ok: true };
      }),
  };
  const context = await fixture(tool);
  const args = {
    text: "Meeting jam 3",
    to: ["6289500000001", "6289500000002", "6289500000003"],
  };
  const pending = context.begin({ args });
  await pending.ready;
  await context.service.decide({
    approvalId: pending.request.approval.id,
    decision: "approved",
    principal,
    sessionId,
  });
  const decision = await pending.waiting;
  if (decision.decision !== "approved") {
    throw new Error("Expected approval");
  }
  const toolContext = {
    approvalGrantId: decision.grantId,
    orgId: principal.orgId,
    runId: "approval-run",
    sessionId,
    userId: principal.userId,
  };
  const tampered = await executeProtectedTool(
    tool,
    { ...args, to: [...args.to, "6289500000004"] },
    toolContext
  );
  expect(tampered.success).toBe(false);
  expect(sent).toEqual([]);
  const execution = await executeProtectedTool(tool, args, toolContext);
  expect(sent).toEqual(args.to);
  await context.service.complete("approval-run", "completed", [
    { call: pending.request.call, content: JSON.stringify(execution.data) },
  ]);
  const steps = await context.db.listExecutionSteps("approval-run");
  expect(steps).toHaveLength(1);
  expect(steps[0]?.status).toBe("failed");
  expect(JSON.parse(steps[0]?.resultJson ?? "null")).toMatchObject({
    ok: false,
    results: [
      { status: "sent", to: args.to[0] },
      { status: "unconfirmed", to: args.to[1] },
      { status: "sent", to: args.to[2] },
    ],
  });
});
